// node --test: core.mjs against a stand-in for GM's Almanac's API, with the real calendar engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlmanacClient, siteBase, readState, tableState, journalPages, lookup, when, shiftSeconds, ID } from '../scripts/core.mjs';

await import('../scripts/vendor/engine.js');   // a plain script, as Foundry loads it: it leaves globalThis.Engine
const E = globalThis.Engine;
const KEY = 'a'.repeat(64);
const calendar = () => structuredClone(E.PRESETS[Object.keys(E.PRESETS)[0]].calendar);

/** A fetch that answers from a table of actions and notes what was asked. */
function fakeSite(answers) {
  const asked = [];
  const fetch = async (url, opt) => {
    const u = new URL(url), a = u.searchParams.get('a');
    asked.push({ a, method: opt.method, key: opt.headers['X-Chronicle-Key'], body: opt.body ? JSON.parse(opt.body) : undefined, query: Object.fromEntries(u.searchParams) });
    const r = typeof answers[a] === 'function' ? answers[a](asked.at(-1)) : answers[a];
    if (!r) return { ok: false, status: 404, json: async () => ({ error: 'not_found', message: 'No such action' }) };
    return { ok: true, status: 200, json: async () => r };
  };
  return { fetch, asked };
}

test('the site address is taken however it was pasted', () => {
  for (const [typed, base] of [['https://x.test/almanac/', 'https://x.test/almanac'], ['x.test/almanac/index.html#/c/3/table', 'https://x.test/almanac'],
    ['http://x.test/api/index.php?a=campaign', 'http://x.test'], ['https://x.test/panel.html', 'https://x.test'], ['', '']]) assert.equal(siteBase(typed), base);
});

test('a call sends the key in its header, and an error carries the site\'s own words', async () => {
  const site = fakeSite({ campaign: { ok: 1 }, set_time: { ok: true } });
  const c = new AlmanacClient({ base: 'https://x.test/a/', key: KEY, fetch: site.fetch });
  assert.deepEqual(await c.get('campaign'), { ok: 1 });
  assert.deepEqual(site.asked[0], { a: 'campaign', method: 'GET', key: KEY, body: undefined, query: { a: 'campaign' } });
  await c.post('set_time', { current_shift: 9 });
  assert.deepEqual(site.asked[1].body, { current_shift: 9 });
  await assert.rejects(c.get('nope'), /No such action/);
  await assert.rejects(new AlmanacClient({ base: '', key: KEY, fetch: site.fetch }).get('campaign'), /Set the site address/);
  await assert.rejects(new AlmanacClient({ base: 'x.test', key: 'short', fetch: site.fetch }).get('campaign'), /Set the site address/);
  const down = new AlmanacClient({ base: 'x.test', key: KEY, fetch: async () => { throw new Error('offline'); } });
  await assert.rejects(down.get('campaign'), /can't be reached/);
});

test('the state is the date and shift in words, the weather, the moons and the running clocks', async () => {
  const cal = calendar(), spd = E.slotsPerDay(E.prep(structuredClone(cal)));
  const site = fakeSite({
    campaign: { role: 'gm', campaign: { id: 7, name: 'Reik', calendar: cal, settings: {}, current_shift: 2 * spd + 1 }, encyclopedia: [{ id: 1, name: 'Altdorf', category: 'location', aliases: ['The Capital'], is_secret: false }] },
    day: q => ({ day: { abs_day: Number(q.query.d), weather: { type: 'rain', temp: 12, wind: 0 } } }),
    clocks: { clocks: [{ id: 1, name: 'Siege', segments: 6, filled: 2, visibility: 'shown', archived: false }, { id: 2, name: 'Coup', segments: 4, filled: 1, visibility: 'secret', archived: false },
      { id: 3, name: 'Debt', segments: 4, filled: null, visibility: 'vague', archived: false }, { id: 4, name: 'Old', segments: 4, filled: 4, visibility: 'shown', archived: true }] },
  });
  const s = await readState(new AlmanacClient({ base: 'x.test', key: KEY, fetch: site.fetch }), E);
  const w = when(E, calendar(), 2 * spd + 1);
  assert.equal(s.label, w.label);
  assert.equal(s.label, `${E.shiftNames(E.prep(calendar()))[1]}, ${E.fmtDate(E.prep(calendar()), 2)}`);
  assert.equal(site.asked.find(x => x.a === 'day').query.d, '2');
  assert.match(s.weather, /12/);
  assert.deepEqual(s.clocks.map(k => k.name), ['Siege', 'Coup', 'Debt']);
  assert.deepEqual(s.entries, [{ id: 1, name: 'Altdorf', category: 'location', aliases: ['The Capital'], secret: false }]);
  // what goes to the table: only the clocks everyone can read, and no Encyclopedia list
  const t = tableState(s);
  assert.deepEqual(t.clocks.map(k => k.name), ['Siege']);
  assert.equal(t.entries, undefined);
  assert.equal(t.label, s.label);
  assert.equal(tableState(null), null);
});

test('n shifts are their share of a day in seconds', () => {
  assert.equal(shiftSeconds(1, 4), 21600);
  assert.equal(shiftSeconds(-2, 4), -43200);
  assert.equal(shiftSeconds(3, 24), 10800);
});

test('the journal has a page per entry, GM things on GM-only pages, and pages keep their ids from one sync to the next', () => {
  let n = 0;
  const newId = () => `id${String(++n).padStart(14, '0')}`;
  const enc = {
    entries: [
      { id: 1, name: 'Altdorf', category: 'location', aliases: ['The Capital'], notes: '<p>Seat of the Emperor.</p><aside>The cult meets here.</aside>', gm_notes: '<p>Plague in spring</p>', is_secret: false },
      { id: 2, name: 'Gunther', category: 'person', notes: '<p>Makes swords.</p>', is_secret: false },
      { id: 3, name: 'Cult of {Change}', notes: '<p>Very secret.</p>', is_secret: true },
    ],
    relations: [{ from_id: 2, to_id: 1, type_id: 5, note: 'since <1490>', is_secret: false }, { from_id: 3, to_id: 1, type_id: 6, note: null, is_secret: false }, { from_id: 2, to_id: 99, type_id: 5 }],
    relation_types: [{ id: 5, label: 'Resident of', inverse_label: 'Has resident' }, { id: 6, label: 'Hides in', inverse_label: 'Hides' }, { id: null, label: 'Ally of', inverse_label: '' }],
  };
  const first = journalPages(enc, [], newId);
  assert.equal(first.update.length, 0);
  assert.deepEqual(first.create.map(p => p.name), ['Altdorf', 'Altdorf (GM notes)', 'Gunther', 'Cult of {Change}']);
  const [altdorf, altdorfGm, gunther, cult] = first.create;
  assert.equal(altdorf.ownership.default, -1);
  assert.equal(altdorfGm.ownership.default, 0);
  assert.equal(cult.ownership.default, 0);
  assert.deepEqual(altdorf.flags[ID], { entryId: 1, gm: false });
  // players' page: the GM-only paragraph is a Foundry secret block, and nothing names the cult
  assert.match(altdorf.text.content, /<section class="secret" id="secret-id\d+"><p>The cult meets here\.<\/p><\/section>/);
  assert.ok(altdorf.text.content.includes(`Has resident @UUID[.${gunther._id}]{Gunther}: since &lt;1490&gt;`));
  assert.ok(!altdorf.text.content.includes('Cult'));
  assert.ok(!altdorf.text.content.includes('Plague'));
  assert.ok(altdorfGm.text.content.includes('Plague in spring'));
  assert.ok(altdorfGm.text.content.includes(`Hides @UUID[.${cult._id}]{Cult of Change}`));
  assert.ok(gunther.text.content.includes(`Resident of @UUID[.${altdorf._id}]{Altdorf}`));
  assert.ok(cult.text.content.includes(`Hides in @UUID[.${altdorf._id}]{Altdorf}`));

  // again, with Gunther gone and a new entry: the pages there keep their ids, his is removed
  const existing = first.create.map(p => ({ id: p._id, entryId: p.flags[ID].entryId, gm: p.flags[ID].gm }));
  enc.entries = [enc.entries[0], enc.entries[2], { id: 4, name: 'Nuln', notes: '', is_secret: false }];
  const second = journalPages(enc, existing, newId);
  assert.deepEqual(second.update.map(p => p._id), [altdorf._id, altdorfGm._id, cult._id]);
  assert.deepEqual(second.create.map(p => p.name), ['Nuln']);
  assert.deepEqual(second.remove, [gunther._id]);
  assert.ok(!second.update[0].text.content.includes('Gunther'));
});

test('the lookup finds an entry by its name or another name, exact matches first', () => {
  const entries = [{ id: 1, name: 'Fordham', aliases: [] }, { id: 2, name: 'Burnt Ford', aliases: ['The Crossing'] }, { id: 3, name: 'Ford', aliases: [] }];
  assert.deepEqual(lookup(entries, 'ford').map(e => e.name), ['Ford', 'Fordham', 'Burnt Ford']);
  assert.deepEqual(lookup(entries, 'crossing').map(e => e.name), ['Burnt Ford']);
  assert.deepEqual(lookup(entries, '  '), []);
});
