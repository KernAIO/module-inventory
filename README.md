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

The status column holds one of `in_stock`, `assigned`, `under_repair`, `lost` and `retired`
(`reserved` is in the contract and waits on reservations, which nothing records yet). Three of them
are derived from two facts and written in the same transaction as the fact that moved: an open
repair makes an item `under_repair`, a custodian makes it `assigned`, and neither makes it
`in_stock`. **A repair wins that column and does not touch custody** — a laptop at the workshop is
still the person's it was handed to, so completing a repair returns it to `assigned` rather than to
stock. The other two are things a person says: **mark it lost** when nobody knows where it is, which
is allowed while somebody still holds it because they are still answerable for it; and **retire it**
when the company is done with it — sold, scrapped, written off — which refuses an item somebody is
holding or that is away for repair, for the same reasons archiving does. Either wins the status
column over everything else, closes the doors that no longer make sense (nobody can be handed a lost
item, nothing retired goes for repair) and is undone by **reinstate**, which clears what was said and
hands the column back to custody and repairs — a laptop found under a desk reads `assigned` again
with no handover re-recorded. Retired is not archived: a retired item stays in the list until
somebody archives it, which it now allows.

- The **Assets** screen lists them in a table, searches by name, tag or serial number, filters by
  status and by category, sorts by what was added last, by name or by tag, hides archived rows until
  the switch asks for them, and pages a workspace with more assets than one screen holds. All of it
  is one server query; nothing is filtered in the browser.
- Adding an asset opens a dialog, and editing one opens the same dialog seeded from the row. The tag
  is the server's job — people read tags off stickers rather than inventing them.
- Each row carries a menu: open, edit, mark as lost, retire, reinstate, archive, restore. Archiving
  and retiring ask first and name what they are about to do; restoring and reinstating do not,
  because they take nothing away. A note can go with a loss or a write-off, and it is kept on the
  history entry rather than on the asset, because it describes the event.
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
  receiving an item is notified; the person doing the handing is not. Under the holder's name the
  panel says how many other items they are holding, and that line is a link to the list filtered
  to them — the same list an offboarding notice links to.
- **Custom fields** are a workspace's own questions about an asset — a cost centre, a supplier
  reference, a MAC address, an insurance renewal. They are defined in **Settings → Inventory →
  Fields**: a key that never changes, a name, one of seven types (text, number, date, select,
  multiselect, checkbox, URL), whether it is required, and whether it applies to every asset or only
  to those filed under one category. The asset form asks the ones that apply; the Details tab shows
  their answers; the timeline names the field when a value changes. Every value is checked on the
  server against the definition before it is stored — an unknown key, a wrong shape, a required
  field being cleared — so the column never becomes a bag. Fields archive rather than delete, and
  an archived field's values stay readable. Choices of a select are the words themselves, so
  renaming one leaves what was already recorded as it was, and the settings page says so.
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
  filter. The order they appear in everywhere else is set by **dragging them into it** — or, without
  a pointer, with the move-up and move-down buttons on each row, which do exactly the same thing and
  say where the row landed. A new category joins the end. They archive rather than delete:
  `assets.category_id` carries no foreign key, so deleting one would leave every asset filed under
  it pointing at nothing, and an archived category still names itself on the rows that carry it.
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
- Six permissions gate it: `inventory.asset.view`, `inventory.asset.manage`,
  `inventory.custody.manage`, `inventory.repair.manage`, `inventory.category.manage` and
  `inventory.field.manage`. Reading who holds what and what has been repaired rides `asset.view`
  rather than a key of its own — "who has the projector" and "where is it" are the questions an
  asset register exists to answer, and the custodian is already a field of every row the list
  returns. Marking an item lost or retiring it is `asset.manage`: a statement about the record,
  which a workspace that wants a narrower gate on write-offs makes with a custom role.
- Three **capabilities** decide how much of it a workspace has: `core` is required and always on,
  and `repairs` and `attachments` are switches an administrator can turn off. A capability that is
  off answers **404, not 403** — a workspace that does not record repairs has no such surface, so
  the API says the same thing the hidden tab does. Switching one off destroys nothing: the rows stay
  exactly where they were and come back when it is switched on again.
- Its strings ship in the five languages the platform speaks — English, Arabic, German, Persian,
  Turkish.

The API is thirty-two procedures under `/api/inventory`:
`assets.{list,get,create,update,archive,history,markLost,retire,reinstate}`,
`custody.{assign,transfer,return,history,byUser}`,
`categories.{list,create,update,archive,reorder}`,
`fields.{list,create,update,archive,reorder}`,
`repairs.{list,create,update,complete}`,
`attachments.{list,add,remove}` and
`stats.summary`.

Two more answers are reachable only from another service, over `kernel.call` —
`inventory.asset.byId` and `inventory.assets.byCustodian`. They run with elevated access and are
refused to anybody who is not a service, so that a module holding an id never has to learn the shape
of `mod_inventory`.

## Not built

Everything the schema holds has a screen. What is further off, and has nothing in the schema yet:
locations and stock control (bins, counts, reorder points), purchasing, depreciation, and
reservations — which is what the `reserved` status waits on.

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
