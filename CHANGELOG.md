# Changelog

## 0.1.0

First version. Not yet run in a live Foundry world: see "Status" in the README.

- A window for the whole table with the campaign's date, shift, weather, moons and the clocks everyone can read.
  Only the GM needs an API key; players' windows read what the GM's client shares.
- The GM passes time from Foundry (*End shift*, *Pass time…*) and fills clocks.
- A chat line when time passes, and optionally Foundry's world time moves with it.
- *Sync journal* makes and updates a journal that mirrors the Encyclopedia, a page per entry, with GM-only entries,
  paragraphs and notes hidden from players by Foundry's own permissions.
- A lookup box that opens an entry's journal page.
- An API for macros and other modules, and two hooks.
