/* main.mjs — the Foundry side of the bridge. core.mjs does the working out; this file is settings, the window, the
 * poll, and the few things written into the world (a chat line, world time, the journal).
 *
 * Who holds what:
 *  - The GM pastes the site's address (a world setting) and their own API key (a client setting: it stays in that
 *    browser and is never sent to players).
 *  - The active GM's client polls GM's Almanac and writes what every player may see (date, shift, weather, moons, the
 *    clocks everyone can read) into a hidden world setting, which every client's window reads. Players need no key.
 *  - A player who has their own API key may paste it too; their window then reads the campaign as they see it.
 *  - The key goes only to the address it was saved for (keySite, kept beside it in the browser). The address is a
 *    world setting, which other GMs, and anything else that can write world settings, can change: if it changes, the
 *    key stays put until its owner says the new address may have it.
 */
import { ID, AlmanacClient, siteBase, sameSite, readState, tableState, journalPages, lookup, when, shiftSeconds } from './core.mjs';

const E = globalThis.Engine;   // scripts/vendor/engine.js, loaded before this module
const NAME = "GM's Almanac";
let state = null, stamp = '', timer = null, failed = '', app = null, polling = false;

const setting = key => game.settings.get(ID, key);
/** This browser has a key, but the world's address is no longer the one the key was saved for. */
const keyHeld = () => !!String(setting('apiKey') || '').trim() && !sameSite(setting('site'), setting('keySite'));
const client = () => new AlmanacClient({ base: setting('site'), key: keyHeld() ? '' : setting('apiKey') });
const hasKey = () => client().ready;
/** One GM's client does the world's writing, so two GMs don't both post a chat line. */
const leads = () => game.user.isGM && (game.users.activeGM ? game.users.activeGM.isSelf : true);
/** What this client's window shows: its own reading with a key, else what the GM shared with the table. */
const shown = () => state || setting('table') || null;

function registerSettings() {
  const redraw = () => { restart(); };
  game.settings.register(ID, 'site', { name: "GM's Almanac address", hint: 'Where your GM\'s Almanac lives, for example https://example.com/almanac', scope: 'world', config: true, type: String, default: '', onChange: redraw });
  game.settings.register(ID, 'apiKey', { name: 'Your API key', hint: 'Made in GM\'s Almanac: At the Table → Use in a VTT or on stream → New API key. Pick "Read and write" to pass time from Foundry. It is kept in this browser only. Players can leave it empty.', scope: 'client', config: true, type: String, default: '',
    // pasting a key says where it is for: the address showing in the settings at that moment
    onChange: async () => { await game.settings.set(ID, 'keySite', siteBase(setting('site'))); redraw(); } });
  game.settings.register(ID, 'keySite', { scope: 'client', config: false, type: String, default: '', onChange: redraw });
  game.settings.register(ID, 'poll', { name: 'Look for changes every (seconds)', scope: 'world', config: true, type: Number, default: 15, range: { min: 5, max: 120, step: 5 }, onChange: redraw });
  game.settings.register(ID, 'chat', { name: 'Say in chat when time passes', hint: 'A line for everyone with the new date, shift and weather.', scope: 'world', config: true, type: Boolean, default: true });
  game.settings.register(ID, 'worldTime', { name: 'Move Foundry\'s world time with the Almanac', hint: 'When the Almanac\'s clock moves, Foundry\'s world time moves by the same share of a day, so calendar and lighting modules follow. Off by default: turn it on once the two clocks agree.', scope: 'world', config: true, type: Boolean, default: false });
  game.settings.register(ID, 'openOnLoad', { name: 'Open the Almanac window when the world loads', scope: 'client', config: true, type: Boolean, default: true });
  game.settings.register(ID, 'table', { scope: 'world', config: false, type: Object, default: null, onChange: () => app?.render() });
  game.settings.register(ID, 'journal', { scope: 'world', config: false, type: String, default: '' });
}

// ---------------------------------------------------------------- the poll
function restart() {
  clearInterval(timer);
  state = null; stamp = ''; failed = '';
  if (hasKey()) {
    refresh(true);
    timer = setInterval(() => refresh(false), Math.max(5, Number(setting('poll')) || 15) * 1000);
  }
  app?.render();
}

/** Ask whether anything changed (one cheap call), and read the campaign again when it has. */
async function refresh(force) {
  if (polling || !hasKey()) return;
  polling = true;
  try {
    const c = client();
    const now = (await c.get('changed')).changed;
    if (!force && state && now === stamp) {
      // a pass of time in the stamp's own second: the clock itself is the tell
      const camp = await c.get('reminders').catch(() => null);
      if (!camp || camp.current_shift === state.shift) return;
    }
    const before = state;
    const next = await readState(c, E);
    stamp = now; failed = '';
    state = next;
    if (leads()) await shareWithTable(next, before);
    if (before && before.shift !== next.shift) Hooks.callAll('gmsAlmanac.timeChanged', { from: before.shift, to: next.shift, label: next.label, weather: next.weather });
    Hooks.callAll('gmsAlmanac.refreshed', next);
    app?.render();
  } catch (e) {
    if (failed !== e.message) { failed = e.message; console.warn(`${NAME}: ${e.message}`); app?.render(); }
  } finally { polling = false; }
}

/** The leading GM's client: share the table's view, and act on a pass of time. */
async function shareWithTable(next, before) {
  const was = setting('table');
  const table = tableState(next);
  const same = was && JSON.stringify({ ...was, at: 0 }) === JSON.stringify({ ...table, at: 0 });
  if (!same) await game.settings.set(ID, 'table', table);
  // the first reading after loading says nothing: only a move seen while the world is open is announced
  const from = before ? before.shift : (was && was.campaignId === next.campaignId ? was.shift : null);
  if (from === null || from === next.shift) return;
  if (setting('chat')) {
    const line = `<p><strong>${foundry.utils.escapeHTML(next.label)}</strong>${next.weather ? `<br>${foundry.utils.escapeHTML(next.weather)}` : ''}</p>`;
    await ChatMessage.create({ content: line, speaker: { alias: NAME } });
  }
  if (setting('worldTime')) await game.time.advance(shiftSeconds(next.shift - from, next.spd));
}

/** GM: move the Almanac's clock by n shifts. The label goes to the campaign's Discord channels. */
async function passShifts(n) {
  if (!state) throw new Error('GM\'s Almanac isn\'t connected.');
  const camp = await client().get('campaign');
  const to = camp.campaign.current_shift + n;
  await client().post('set_time', { current_shift: to, label: when(E, camp.campaign.calendar, to).label });
  await refresh(true);
}

// ---------------------------------------------------------------- the journal
/** GM: make or update the journal entry that mirrors the Encyclopedia, a page per entry. */
async function syncJournal() {
  if (!game.user.isGM) return;
  const enc = await client().get('encyclopedia');
  const title = `${state?.name || NAME} Encyclopedia`;
  let entry = game.journal.get(setting('journal'));
  if (!entry) {
    entry = await JournalEntry.create({ name: title, ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }, flags: { [ID]: { encyclopedia: true } } });
    await game.settings.set(ID, 'journal', entry.id);
  }
  const existing = entry.pages.filter(p => p.flags?.[ID]?.entryId).map(p => ({ id: p.id, entryId: p.flags[ID].entryId, gm: !!p.flags[ID].gm }));
  const plan = journalPages(enc, existing, () => foundry.utils.randomID());
  if (plan.create.length) await entry.createEmbeddedDocuments('JournalEntryPage', plan.create, { keepId: true });
  if (plan.update.length) await entry.updateEmbeddedDocuments('JournalEntryPage', plan.update);
  if (plan.remove.length) await entry.deleteEmbeddedDocuments('JournalEntryPage', plan.remove);
  ui.notifications.info(`${NAME}: ${plan.create.length} new pages, ${plan.update.length} updated, ${plan.remove.length} removed in "${entry.name}".`);
  return entry;
}

/** Open the journal page for an Encyclopedia entry, if the journal has been synced. */
function openEntry(entryId) {
  const entry = game.journal.get(setting('journal'));
  const page = entry?.pages.find(p => p.flags?.[ID]?.entryId === entryId && !p.flags[ID].gm);
  if (!page) return ui.notifications.warn(`${NAME}: that entry isn't in the journal yet. ${game.user.isGM ? 'Press Sync journal first.' : 'Ask your GM to sync the journal.'}`);
  entry.sheet.render({ force: true, pageId: page.id });
}

// ---------------------------------------------------------------- the window
const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
  n.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  return n;
};

class AlmanacWindow extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'gms-almanac-window',
    classes: ['gms-almanac'],
    window: { title: NAME, icon: 'fa-solid fa-moon', resizable: true },
    position: { width: 320, height: 'auto' },
    actions: {
      endShift: AlmanacWindow.#endShift,
      passTime: AlmanacWindow.#passTime,
      sync: AlmanacWindow.#sync,
      refresh: AlmanacWindow.#refresh,
      openSite: AlmanacWindow.#openSite,
      openEntry: AlmanacWindow.#openEntry,
      tick: AlmanacWindow.#tick,
      trustSite: AlmanacWindow.#trustSite,
    },
  };
  #query = '';

  async _renderHTML() {
    const s = shown();
    const box = h('div', { class: 'gma' });
    if (keyHeld()) box.append(h('div', { class: 'gma-warn' },
      h('p', {}, `This world's GM's Almanac address is now ${siteBase(setting('site')) || 'empty'}. Your API key was saved for ${setting('keySite') || 'another address'}, so it has not been sent to the new one.`),
      h('button', { type: 'button', 'data-action': 'trustSite' }, 'Use my key with this address')));
    if (!s) {
      box.append(h('p', { class: 'gma-empty' }, failed || (game.user.isGM
        ? 'Not connected yet. In Game Settings → Configure Settings → GM\'s Almanac Bridge, set the site address and your API key.'
        : 'Waiting for your GM to connect GM\'s Almanac.')));
      return box;
    }
    box.append(h('div', { class: 'gma-now' },
      h('div', { class: 'gma-campaign' }, s.name),
      h('div', { class: 'gma-shift' }, s.shiftName),
      h('div', { class: 'gma-date' }, s.date),
      s.weather ? h('div', { class: 'gma-weather' }, s.weather) : null,
      s.moons?.length ? h('div', { class: 'gma-moons' }, s.moons.map(m => h('span', { title: `${m.name}: ${m.label}` }, `${m.icon || ''} ${m.name}: ${m.label}`))) : null));
    if (failed) box.append(h('p', { class: 'gma-warn' }, failed));
    const write = !!state && game.user.isGM;
    if (s.clocks?.length) {
      box.append(h('div', { class: 'gma-clocks' }, h('h4', {}, 'Clocks'), s.clocks.map(k => h('div', { class: 'gma-clock' },
        h('span', { class: 'gma-clock-name' }, k.name),
        h('span', { class: 'gma-clock-fill', title: typeof k.filled === 'number' ? `${k.filled} of ${k.segments}` : 'How full is hidden' },
          typeof k.filled === 'number' ? Array.from({ length: k.segments }, (_, i) => h('i', { class: i < k.filled ? 'on' : '' })) : '?'),
        write ? h('button', { type: 'button', 'data-action': 'tick', 'data-id': k.id, 'data-tooltip': 'Fill one segment', 'aria-label': `Fill one segment of ${k.name}` }, '+') : null))));
    }
    const entries = state?.entries || [];
    if (entries.length || setting('journal')) {
      const input = h('input', { type: 'search', placeholder: 'Look up a name in the Encyclopedia', 'aria-label': 'Look up a name in the Encyclopedia', value: this.#query });
      const out = h('div', { class: 'gma-hits' });
      const draw = () => out.replaceChildren(...lookup(entries, this.#query).map(e => h('button', { type: 'button', 'data-action': 'openEntry', 'data-id': e.id }, e.name, e.secret ? ' (GM only)' : '')));
      input.addEventListener('input', () => { this.#query = input.value; draw(); });
      draw();
      if (entries.length) box.append(h('div', { class: 'gma-lookup' }, input, out));
    }
    const row = h('div', { class: 'gma-actions' });
    if (write) row.append(h('button', { type: 'button', 'data-action': 'endShift' }, 'End shift'), h('button', { type: 'button', 'data-action': 'passTime' }, 'Pass time…'),
      h('button', { type: 'button', 'data-action': 'sync', 'data-tooltip': 'Make or update the journal that mirrors the Encyclopedia' }, 'Sync journal'));
    if (state) row.append(h('button', { type: 'button', 'data-action': 'refresh', 'data-tooltip': 'Look for changes now' }, 'Refresh'));
    if (setting('site')) row.append(h('button', { type: 'button', 'data-action': 'openSite' }, 'Open GM\'s Almanac'));
    box.append(row);
    return box;
  }
  _replaceHTML(result, content) { content.replaceChildren(result); }

  static async #guard(fn) { try { await fn(); } catch (e) { ui.notifications.error(`${NAME}: ${e.message}`); } }
  static #endShift() { return AlmanacWindow.#guard(() => passShifts(1)); }
  static async #passTime() {
    const n = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'Pass time' },
      content: '<label>Shifts to pass <input name="n" type="number" value="1" min="-1000" max="100000" step="1" autofocus></label>',
      ok: { label: 'Pass time', callback: (event, button) => Number(button.form.elements.n.value) },
      rejectClose: false,
    });
    if (!Number.isInteger(n) || n === 0) return;
    return AlmanacWindow.#guard(() => passShifts(n));
  }
  static #sync() { return AlmanacWindow.#guard(() => syncJournal()); }
  static #refresh() { return refresh(true); }
  static #openSite() { window.open(`${client().base}/index.html${shown()?.campaignId ? `#/c/${shown().campaignId}/table` : ''}`, '_blank', 'noopener'); }
  static async #trustSite() {
    const to = siteBase(setting('site'));
    if (!to) return;
    const yes = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Send your API key to this address?' },
      content: `<p>Your GM's Almanac API key will be sent to <strong>${foundry.utils.escapeHTML(to)}</strong> from now on.</p><p>Only say yes if you changed the address yourself, or know who did and why. Whoever runs that address can use the key as you. If in doubt, say no and revoke the key on your Account page in GM's Almanac.</p>`,
      rejectClose: false,
    });
    if (yes) await game.settings.set(ID, 'keySite', to);
  }
  static #openEntry(event, target) { openEntry(Number(target.dataset.id)); }
  static #tick(event, target) { return AlmanacWindow.#guard(async () => { await client().post('clock_tick', { id: Number(target.dataset.id), by: 1 }); await refresh(true); }); }
}

function open() {
  app ??= new AlmanacWindow();
  app.render({ force: true });
  return app;
}

// ---------------------------------------------------------------- hooks
Hooks.once('init', () => {
  registerSettings();
  game.keybindings.register(ID, 'open', { name: "Open GM's Almanac", editable: [{ key: 'KeyA', modifiers: ['Alt'] }], onDown: () => { open(); return true; } });
});

Hooks.once('ready', () => {
  if (!E) return ui.notifications.error(`${NAME}: the calendar engine didn't load.`);
  game.modules.get(ID).api = {
    /** The window. */
    open,
    /** What this client knows: its own reading with a key, else what the GM shared. */
    get state() { return shown(); },
    refresh: () => refresh(true),
    /** GM, with a read-and-write key: move the Almanac's clock by n shifts. */
    passShifts,
    syncJournal,
    openEntry,
    /** Ask the site, as this client's key may: get('clocks'), post('clock_tick', { id, by: 1 }). The key itself is not handed out. */
    get: (action, query) => client().get(action, query),
    post: (action, body) => client().post(action, body),
  };
  // a key saved before the module kept its address: it was for the address the world has now
  if (String(setting('apiKey') || '').trim() && !setting('keySite')) game.settings.set(ID, 'keySite', siteBase(setting('site')));
  restart();
  if (setting('openOnLoad') && (hasKey() || setting('table'))) open();
});

// A button with the journal notes tools: an object of controls from Foundry 13, a list before it.
Hooks.on('getSceneControlButtons', controls => {
  try {
    const tool = { name: 'gmsAlmanac', title: NAME, icon: 'fa-solid fa-moon', button: true, visible: true, order: 99, onChange: () => open(), onClick: () => open() };
    if (Array.isArray(controls)) controls.find(c => c.name === 'notes')?.tools.push(tool);
    else if (controls?.notes?.tools) controls.notes.tools.gmsAlmanac = tool;
  } catch (e) { console.warn(`${NAME}: no toolbar button (${e.message}). Alt+A opens the window.`); }
});
