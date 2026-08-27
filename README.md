# @kernhq/module-inventory

The asset register for [Kern](https://github.com/KernAIO/app): a list of what the company owns, item
by item.

This is a first-party Kern module. Contract, server, screens, strings and manifest ship in one
package — `core` imports `inventoryModule`, the app shell registers `inventoryClientModule`, and
deleting the package removes the feature completely. Enable it per workspace in
**Settings → Modules**.

## What it does today

An **asset** carries an asset tag the server assigns (`INV-0042`), a name and description, a serial
number, a purchase date and vendor, a price, a warranty expiry, a location, a photo and a status.

A price is written the way the reader's own language writes one — `1.234,56` in German, `۱٬۲۳۴٫۵۶`
in Persian — and is stored in the currency's own minor units. How many decimal places that is comes
from the currency, so a yen amount takes none and a dinar takes three; anything the field cannot
read, including more decimal places than the currency has, is refused rather than rounded.

The status column holds one of `in_stock`, `assigned`, `reserved`, `under_repair`, `lost` and
`retired`. Three of them are derived from two facts and written in the same transaction as the fact
that moved: an open repair makes an item `under_repair`, a custodian makes it `assigned`, and
neither makes it `in_stock`. **A repair wins that column and does not touch custody** — a laptop at
the workshop is still the person's it was handed to, so completing a repair returns it to `assigned`
rather than to stock. `reserved`, `lost` and `retired` wait on the features that set them, so those
three filters correctly return nothing yet.

- The **Assets** screen lists them in a table, searches by name, tag or serial number, filters by
  status and by category, hides archived rows until the switch asks for them, and pages a workspace
  with more assets than one screen holds. All of it is one server query; nothing is filtered in the
  browser.
- Adding an asset opens a dialog, and editing one opens the same dialog seeded from the row. The tag
  is the server's job — people read tags off stickers rather than inventing them.
- Each row carries a menu: open, edit, archive, restore. Archiving asks first and names what it is
  about to archive; restoring does not, because it takes nothing away.
- The line above the table says how many assets the workspace has — the real number, from
  `stats.summary`, rather than how many rows happen to be loaded.
- Opening an asset puts `?asset=<id>` on the URL and slides a **detail panel** over the list, so the
  list keeps its filters and its place and the panel can be linked to and reloaded. It has up to five
  sections: **Details**, **Custody**, **Repairs**, **Files** and **History** — Repairs and Files are
  capabilities, so a workspace that switches one off sees three.
- **Custody** answers who is holding an item and who held it before. Hand it over, hand it on to
  somebody else, or take it back — each is one transaction that closes the open period, opens the
  next, moves the custodian, the date and the status together, and writes a line of history. Two
  people handing the same item over at the same instant is settled by a database exclusion
  constraint, and the one who loses is told to reload rather than shown a driver error. The person
  receiving an item is notified; the person doing the handing is not.
- **Repairs** record what went away to be fixed, to whom, what it cost and when it came back. One
  repair can be open per item — a partial unique index decides that, not the service, so two people
  sending the same laptop away at the same instant end with one repair and a sentence rather than
  two. Sending an item away puts it in `under_repair` and leaves whoever holds it holding it;
  logging it back returns it to them, or to stock if nobody has it. An item that is away cannot be
  archived, for the same reason one somebody is holding cannot be.
- **Files** are receipts, warranty cards and manuals, kept against the asset or against one of its
  repairs — a repair's invoice sits inside that repair rather than in with everything else. This
  module records that an asset has a file and never holds a byte: the browser uploads to core, this
  stores the id it is handed, and removing one detaches it rather than deleting core's copy. The
  asset's **photo** is set on the Details tab and is a field of the asset rather than one of these,
  so a workspace with Files switched off still has one.
- **History** is the asset's own timeline, read newest first and paged. It renders as sentences —
  "Ada handed it to Bruno", "Warranty until changed from Mar 14, 2027 to Mar 14, 2028" — not as a
  JSON diff, and somebody who has since left the workspace reads as a former member rather than as a
  uuid. "It", not the tag: the timeline is inside that asset's own panel, whose header is already
  showing `INV-0042`, so repeating it on every line would be the one word in the sentence a reader
  does not need.
- **Categories** group what a workspace owns. They are managed in **Settings → Inventory →
  Categories**, chosen on the asset form, shown as a chip on the row, and are the list's category
  filter. They archive rather than delete: `assets.category_id` carries no foreign key, so deleting
  one would leave every asset filed under it pointing at nothing, and an archived category still
  names itself on the rows that carry it.
- Two **dashboard cards**: the most recently added assets, above a strip saying how many there are,
  how many nobody is holding and how many are away; and — for a workspace that records repairs — what
  is out for repair right now, with the tag and name of each item.
- Assets are in the **workspace-wide search index**, so a tag read off a sticker finds the item from
  the command palette. Name, tag, serial number, location, description and category name are all
  searched. Archiving an item takes it out of the index; restoring puts it back.
- `inventory:asset:<id>` **resolves anywhere in the product** — a chat message, a tracker issue, a
  notification — into the tag, the name and a link to the item. Somebody without
  `inventory.asset.view` gets plain text rather than a title they were not entitled to read, and an
  archived item still resolves and says it is archived rather than turning into a dead link.
- Two **nightly notices**, each sent once per item and never again: a **warranty about to run out**,
  to whoever is holding it or to whoever may replace it when nobody is; and a **repair that has been
  away too long**, to the person who logged it and to whoever is still holding the item. Both windows
  are settings.
- When somebody **leaves**, the workspace gets a **return list** of what is still recorded as theirs.
  It is raised by core's own "member removed" event, and by the People module's status change if that
  module is installed — Inventory works without it and declares no dependency on it. Nothing is moved:
  custody changes because a person did something, and a hook that quietly returned an item would write
  a handover nobody performed into the one record a company later argues from.
- Switching the module on for a workspace **seeds five categories** — Laptops, Phones, Monitors,
  Furniture, Vehicles — so the asset form's picker is not empty on day one. All five are renamable and
  archivable, and switching the module off and on again never seeds a second time or re-creates one
  somebody renamed.
- **Settings → Inventory → General** sets the shape of an asset tag — the prefix and how many digits
  it is padded to, so a workspace that already labels its laptops `LT-` keeps doing that. The number
  itself is a counter in the database rather than a setting: a number an administrator can edit is a
  number that produces a duplicate tag. The same page sets the two notice windows: how far ahead of a
  warranty expiring somebody is told, and how long an item may be at a repairer before somebody is
  asked to chase it.
- Five permissions gate it: `inventory.asset.view`, `inventory.asset.manage`,
  `inventory.custody.manage`, `inventory.repair.manage` and `inventory.category.manage`. Reading who
  holds what and what has been repaired rides `asset.view` rather than a key of its own — "who has
  the projector" and "where is it" are the questions an asset register exists to answer, and the
  custodian is already a field of every row the list returns.
- Three **capabilities** decide how much of it a workspace has: `core` is required and always on,
  and `repairs` and `attachments` are switches an administrator can turn off. A capability that is
  off answers **404, not 403** — a workspace that does not record repairs has no such surface, so
  the API says the same thing the hidden tab does. Switching one off destroys nothing: the rows stay
  exactly where they were and come back when it is switched on again.
- Its strings ship in the five languages the platform speaks — English, Arabic, German, Persian,
  Turkish.

The API is twenty-three procedures under `/api/inventory`:
`assets.{list,get,create,update,archive,history}`,
`custody.{assign,transfer,return,history,byUser}`,
`categories.{list,create,update,archive}`,
`repairs.{list,create,update,complete}`,
`attachments.{list,add,remove}` and
`stats.summary`.
An asset's custom values are settable by nothing, and wait on custom fields below.

Two more answers are reachable only from another service, over `kernel.call` —
`inventory.asset.byId` and `inventory.assets.byCustodian`. They run with elevated access and are
refused to anybody who is not a service, so that a module holding an id never has to learn the shape
of `mod_inventory`.

## Not built yet

Nothing here has a screen. It is a table in `mod_inventory` and nothing more. A register is worth
designing whole, and a migration that adds a column later is cheaper than one that reshapes a table.
A table is not a feature, and this section stays until each one ships.

- **Custom fields** — a workspace's own fields on an asset. `assets.custom` holds the values;
  nothing defines a field, so `create` and `update` refuse to write into it at all.

Further off, and with nothing in the schema yet: locations and stock control (bins, counts, reorder
points), purchasing, depreciation, and reservations.

## Developing

```bash
pnpm install
pnpm typecheck   # tsc + svelte-check over the client
pnpm test
pnpm build
pnpm db:generate # drizzle-kit → migrations/ (RLS policies are hand-written)
```

This package follows the standard Kern module shape: one contract shared by both halves, a server
module hosted by core, and a client module whose screens ship inside this package. See
`docs/adr/0008-a-module-ships-its-own-screens.md` in the app repository for the reasoning.

## Licence

AGPL-3.0-only. This module is part of the Kern product; anything you build for your own Kern
instance does not have to be released, but modifications to this module do.
