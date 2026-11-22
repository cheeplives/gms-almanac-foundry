/* core.mjs — everything the bridge works out that doesn't need Foundry: talking to GM's Almanac's API, reading the
 * campaign's "now" into a small state, and turning the Encyclopedia into journal pages. Plain ES module with no
 * Foundry calls, so `node --test` runs it (test/core.test.mjs).
 *
 * The calendar maths is GM's Almanac's own engine (scripts/vendor/engine.js, a copy of its static/engine.js), handed
 * in as E so this file never reaches for a global. */

export const ID = 'gms-almanac';

/** The site's address as typed, down to the folder index.html lives in: "https://example.com/almanac". */
export function siteBase(typed) {
  let s = String(typed || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/[#?].*$/, '').replace(/\/(index|panel)\.html$/i, '').replace(/\/api(\/index\.php)?$/i, '').replace(/\/+$/, '');
  return s;
}

/** Whether two typed addresses are the same site: the key saved for one is only ever sent to that one. */
export function sameSite(a, b) {
  const norm = t => {
    const s = siteBase(t);
    if (!s) return '';
    try { const u = new URL(s); return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`; } catch { return ''; }
  };
  return norm(a) !== '' && norm(a) === norm(b);
}

/** GM's Almanac's API with an API key (docs/API.md there). fetch is handed in for the tests. */
export class AlmanacClient {
  constructor({ base, key, fetch: f = globalThis.fetch }) {
    this.base = siteBase(base);
    this.key = String(key || '').trim();
    this.fetch = f;
  }
  get ready() { return !!this.base && /^[0-9a-f]{64}$/.test(this.key); }
  async call(action, { query = {}, body } = {}) {
    if (!this.ready) throw Object.assign(new Error('Set the site address and your API key in the module settings.'), { status: 0 });
    const qs = new URLSearchParams({ a: action, ...query });
    const opt = { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Chronicle-Key': this.key, Accept: 'application/json' } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await this.fetch(`${this.base}/api/index.php?${qs}`, opt); }
    catch (e) { throw Object.assign(new Error(`GM's Almanac can't be reached at ${this.base} (${e.message}).`), { status: 0 }); }
    let data;
    try { data = await res.json(); } catch { throw Object.assign(new Error(`GM's Almanac answered ${res.status}, not JSON. Check the site address.`), { status: res.status }); }
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `GM's Almanac answered ${res.status}`), { status: res.status, code: data.error });
    return data;
  }
  get(action, query) { return this.call(action, { query }); }
  post(action, body) { return this.call(action, { body: body || {} }); }
}

/** The elements a note from the site may keep in a journal page: the same list the site cleans its notes to. */
const NOTE_TAGS = new Set(['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'h1', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'hr', 'a',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'aside']);
const NOTE_DROP = 'script|style|template|noscript|iframe|frame|frameset|object|embed|applet|svg|math|head|title|textarea|select|button|form|audio|video|canvas';
/**
 * HTML from the site, cleaned again here before it is written into the world: the site address is a world setting, so
 * what answers at it is not taken on trust. Every tag that stays is written out afresh from its name alone, with no
 * attributes (a link keeps an http, https or mailto address), anything else loses its tag and keeps its text, and a
 * script or the like goes with everything inside it. So no handler, style, picture or script reaches a journal page.
 */
export function cleanHtml(html) {
  const s = String(html ?? '').replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(new RegExp(`<(${NOTE_DROP})\\b[\\s\\S]*?(<\\/\\1\\s*>|$)`, 'gi'), '');
  const text = t => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let out = '', at = 0;
  for (let m; (m = tagRe.exec(s));) {
    out += text(s.slice(at, m.index));
    at = tagRe.lastIndex;
    const tag = m[2].toLowerCase();
    if (!NOTE_TAGS.has(tag)) continue;
    if (m[1]) { if (tag !== 'br' && tag !== 'hr') out += `</${tag}>`; continue; }
    if (tag !== 'a') { out += `<${tag}>`; continue; }
    const h = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[3]);
    const href = (h ? (h[1] ?? h[2] ?? h[3]) : '').replace(/[\u0000-\u0020\u007f]+/g, '');
    out += /^(https?:\/\/|mailto:)/i.test(href) ? `<a href="${esc(href.replace(/&amp;/g, '&'))}">` : '<a>';
  }
  return out + text(s.slice(at));
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const has = v => v !== null && v !== undefined && String(v).trim() !== '';

/** The date and shift in words for an absolute shift: { day, slot, shiftName, date, label }. */
export function when(E, calendar, shift) {
  const cal = E.prep(calendar), spd = E.slotsPerDay(cal);
  const day = Math.floor(shift / spd), slot = ((shift % spd) + spd) % spd;
  const shiftName = E.shiftNames(cal)[slot], date = E.fmtDate(cal, day);
  return { day, slot, spd, shiftName, date, label: `${shiftName}, ${date}` };
}

/** The campaign right now, as the key's member may see it. */
export async function readState(client, E) {
  const c = await client.get('campaign');
  const camp = c.campaign, settings = camp.settings || {};
  const w = when(E, camp.calendar, camp.current_shift);
  const [day, clocks] = await Promise.all([
    client.get('day', { d: w.day }).catch(() => null),
    client.get('clocks').catch(() => ({ clocks: [] })),
  ]);
  const hide = settings.hide_temps ?? settings.temp_unit === 'none';
  const unit = hide ? 'none' : (settings.units ? settings.units === 'imperial' : E.isImperial?.(settings.temp_unit)) ? 'F' : 'C';
  const weather = day?.day?.weather ? E.weatherLabel(day.day.weather, unit) : '';
  return {
    campaignId: camp.id, name: camp.name, role: c.role, shift: camp.current_shift, day: w.day, spd: w.spd,
    shiftName: w.shiftName, date: w.date, label: w.label, weather,
    moons: E.moons(E.prep(camp.calendar), w.day).map(m => ({ name: m.name, label: m.label, icon: m.icon })),
    clocks: (clocks.clocks || []).filter(k => !k.archived).map(k => ({ id: k.id, name: k.name, segments: k.segments, filled: k.filled, visibility: k.visibility })),
    entries: (c.encyclopedia || []).map(e => ({ id: e.id, name: e.name, category: e.category, aliases: e.aliases || [], secret: !!e.is_secret })),
    at: Date.now(),
  };
}

/** What the GM's client shares with the table through a world setting: nothing a player may not see. */
export function tableState(state) {
  if (!state) return null;
  const { campaignId, name, shift, day, spd, shiftName, date, label, weather, moons, at } = state;
  return { campaignId, name, shift, day, spd, shiftName, date, label, weather, moons, at,
    clocks: state.clocks.filter(k => k.visibility === 'shown' && typeof k.filled === 'number').map(k => ({ id: k.id, name: k.name, segments: k.segments, filled: k.filled, visibility: 'shown' })) };
}

/** Seconds of Foundry world time for n shifts: a day's seconds shared among its shifts. */
export const shiftSeconds = (n, spd, daySeconds = 86400) => Math.round(n * daySeconds / spd);

const CATEGORIES = { location: 'Location', person: 'Person', item: 'Item', group: 'Group', vehicle: 'Vehicle', quest: 'Quest' };
/** GM-only paragraphs become Foundry's own secret blocks, which players never see. */
const asideToSecret = (html, newId) => cleanHtml(html).replace(/<aside>([\s\S]*?)<\/aside>/g, (m, inner) => `<section class="secret" id="secret-${newId()}"><p>${inner}</p></section>`);

/**
 * The Encyclopedia as the pages of one journal entry: a page per entry, and a GM-only page for an entry's GM notes.
 *   enc       the API's `encyclopedia` answer ({ entries, relations, relation_types })
 *   existing  the pages already there: [{ id, entryId, gm }] (from each page's flags)
 *   newId     makes a Foundry document id
 * Returns { create, update, remove }: page data to make (with _id), to change (with _id), and ids of pages whose entry
 * is gone. Pages keep their ids from one sync to the next, so links between them, and links to them from scenes,
 * keep working.
 */
export function journalPages(enc, existing, newId) {
  const entries = enc.entries || [], types = new Map((enc.relation_types || []).filter(t => t.id !== null).map(t => [t.id, t]));
  const names = new Map(entries.map(e => [e.id, e.name]));
  const have = new Map(), haveGm = new Map();
  for (const p of existing || []) (p.gm ? haveGm : have).set(p.entryId, p.id);
  const pageId = new Map(entries.map(e => [e.id, have.get(e.id) || newId()]));
  const links = new Map();
  const add = (id, l) => { if (!links.has(id)) links.set(id, []); links.get(id).push(l); };
  for (const r of enc.relations || []) {
    const t = types.get(r.type_id);
    if (!t || !names.has(r.from_id) || !names.has(r.to_id)) continue;
    add(r.from_id, { label: t.label, to: r.to_id, note: r.note, secret: r.is_secret });
    add(r.to_id, { label: t.inverse_label || t.label, to: r.from_id, note: r.note, secret: r.is_secret });
  }
  const secretIds = new Set(entries.filter(e => e.is_secret).map(e => e.id));
  const linkList = ls => `<ul>${ls.map(l => `<li>${esc(l.label)} @UUID[.${pageId.get(l.to)}]{${esc(names.get(l.to)).replace(/[{}]/g, '')}}${has(l.note) ? `: ${esc(l.note)}` : ''}</li>`).join('')}</ul>`;
  const create = [], update = [], keep = new Set();
  let sort = 0;
  const put = (id, isNew, data) => { keep.add(id); (isNew ? create : update).push({ _id: id, ...data }); };
  for (const e of entries) {
    const about = [CATEGORIES[e.category], e.aliases?.length ? `Also called ${e.aliases.join(', ')}` : null].filter(Boolean);
    const mine = links.get(e.id) || [];
    // a connection that is GM-only, or leads to a GM-only entry, is shown on the GM's page: its link would name a page players can't open
    const gmLink = l => l.secret || secretIds.has(l.to);
    const open = e.is_secret ? mine : mine.filter(l => !gmLink(l)), hidden = e.is_secret ? [] : mine.filter(gmLink);
    const html = [about.length ? `<p><em>${esc(about.join(' · '))}</em></p>` : '', asideToSecret(e.notes, newId),
      open.length ? `<h2>Connections</h2>${linkList(open)}` : ''].filter(Boolean).join('\n');
    put(pageId.get(e.id), !have.has(e.id), { name: e.name, type: 'text', title: { show: true, level: 1 }, text: { content: html, format: 1 }, sort: sort += 100000,
      ownership: { default: e.is_secret ? 0 : -1 }, flags: { [ID]: { entryId: e.id, gm: false } } });
    const gmHtml = [e.gm_notes || '', hidden.length ? `<h2>GM-only connections</h2>${linkList(hidden)}` : ''].filter(has).join('\n');
    if (has(gmHtml)) {
      const id = haveGm.get(e.id) || newId();
      put(id, !haveGm.has(e.id), { name: `${e.name} (GM notes)`, type: 'text', title: { show: true, level: 1 }, text: { content: asideToSecret(gmHtml, newId), format: 1 }, sort: sort += 100000,
        ownership: { default: 0 }, flags: { [ID]: { entryId: e.id, gm: true } } });
    }
  }
  const remove = (existing || []).map(p => p.id).filter(id => !keep.has(id));
  return { create, update, remove };
}

/** Entries whose name or other names hold q, best first, for the window's lookup. */
export function lookup(entries, q, max = 8) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  const named = e => [e.name, ...(e.aliases || [])].map(n => String(n).toLowerCase());
  return entries.filter(e => named(e).some(n => n.includes(s)))
    .sort((a, b) => (named(b).some(n => n === s) - named(a).some(n => n === s)) || (named(b).some(n => n.startsWith(s)) - named(a).some(n => n.startsWith(s))) || a.name.localeCompare(b.name))
    .slice(0, max);
}
