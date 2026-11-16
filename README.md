# GM's Almanac Bridge

A Foundry VTT module that brings a [GM's Almanac](https://github.com/cheeplives/campaigntracker) campaign into
Foundry. GM's Almanac stays where the campaign's time, weather, lore and clocks are kept; Foundry stays the place for
the battlemap. The bridge keeps the two in step.

## Status

**Version 0.1.0 has not been run in a live Foundry world yet.** Its working-out (talking to GM's Almanac, dates,
the journal's pages) is tested with `npm test`, and against a real GM's Almanac server. The Foundry side
(`scripts/main.mjs`: the window, settings, chat, journal writes) is written against Foundry 13 and 14's documented
API but still needs a first run. Until someone has done that, treat it as a preview, and please report what breaks.

It is not listed on foundryvtt.com. Install it by its manifest address (below).

## What it does

- **A window for the whole table** (Alt+A, or the moon button with the journal notes tools): the campaign's shift and
  date, the weather, the moons, and the clocks everyone can read. Only the GM needs an API key: the GM's Foundry reads
  GM's Almanac and shares what every player may see with the players' windows. Nothing GM-only is shared.
- **Pass time from Foundry** (GM): *End shift* and *Pass time…* move the Almanac's clock, and + fills a clock.
- **Time passing is announced**: a chat line with the new date, shift and weather. Optionally Foundry's world time
  moves by the same share of a day, so calendar and lighting modules follow.
- **The Encyclopedia as a journal** (GM): *Sync journal* makes one journal entry with a page per Encyclopedia entry,
  and updates it whenever you press it again. Pages keep their ids, so links to them keep working. GM-only entries
  are pages only the GM can open, GM-only paragraphs become Foundry's secret blocks, and GM notes and connections to
  GM-only entries go on a separate GM-only page.
- **Look up a name** (with a key): type in the window, and the entry's journal page opens.

## Install

1. In Foundry's setup screen: **Add-on Modules → Install Module**, and paste this into *Manifest URL*:
   `https://github.com/cheeplives/gms-almanac-foundry/releases/latest/download/module.json`
2. Turn on **GM's Almanac Bridge** in your world.
3. In GM's Almanac, open the campaign: **At the Table → Use in a VTT or on stream → New API key…**. Pick *Read and
   write* if you want to pass time and fill clocks from Foundry. Copy the key.
4. In Foundry: **Game Settings → Configure Settings → GM's Almanac Bridge**. Paste your site's address
   (for example `https://example.com/almanac`) and the key.

The key is a client setting: it stays in your browser and is never sent to your players. It acts as you, in that one
campaign, and you can revoke it in GM's Almanac at any time.

If Foundry is served over `https`, GM's Almanac must be too: browsers refuse to call an `http` site from an `https`
page.

## Settings

| Setting | Who | What |
| --- | --- | --- |
| GM's Almanac address | world | Where your GM's Almanac lives. |
| Your API key | each browser | The GM's key. A player with their own key may paste theirs; their window then shows the campaign as they see it. |
| Look for changes every | world | 15 seconds unless changed. One small request each time. |
| Say in chat when time passes | world | On. |
| Move Foundry's world time with the Almanac | world | Off. A shift is its share of a day: a quarter of a day with four shifts. |
| Open the window when the world loads | each browser | On. |

## For macros and other modules

```js
const almanac = game.modules.get('gms-almanac').api;
almanac.open();                 // the window
almanac.state;                  // { name, shift, day, shiftName, date, label, weather, moons, clocks, … }
await almanac.passShifts(2);    // GM, with a read-and-write key
await almanac.syncJournal();    // GM
await almanac.refresh();

Hooks.on('gmsAlmanac.timeChanged', ({ from, to, label, weather }) => { /* the Almanac's clock moved */ });
Hooks.on('gmsAlmanac.refreshed', state => { /* a fresh reading */ });
```

## What it doesn't do yet

- Pictures don't come into the journal (use GM's Almanac's *Export… → Foundry VTT journal and pictures* for those).
- Foundry's calendar modules aren't set to the Almanac's date; only the passing of time is carried over.
- Character sheets and map pins aren't synced.

## Development

`scripts/core.mjs` holds everything that doesn't need Foundry and is tested with `npm test` (Node 20 or later, no
dependencies). `scripts/vendor/engine.js` is a copy of GM's Almanac's `static/engine.js` (its calendar maths); copy it
again when GM's Almanac changes its calendars.

A release is a new version on `main`: change `version` in `module.json` (and note it in `CHANGELOG.md`), merge, and the
workflow makes the GitHub release `v<version>` with `module.json` and `module.zip`, which is what the manifest address
points at.

MIT licence.
