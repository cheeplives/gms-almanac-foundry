# Changelog

## 0.1.1

Safer handling of your API key and of what comes back from the site.

- Your API key is only sent to the address it was saved for. The address is a world setting, so if anyone changes it,
  your key stays in your browser and the window asks you before it is ever sent to the new address. A key you had
  already saved is tied to the address your world has when you first load this version.
- Notes from the site are cleaned to plain formatting (paragraphs, lists, tables, links) before they are written into
  the journal, so nothing in a note can run in your world.
- For macros and other modules: `api.client` is gone, as it handed out the key. Use `api.get(action, query)` and
  `api.post(action, body)` instead.

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
