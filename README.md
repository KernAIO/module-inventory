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

The status column holds one of `in_stock`, `assigned`, `reserved`, `under_repair`, `lost` and
`retired`, and the screen can filter by any of them — but until custody and repairs ship, nothing
sets it, so every asset is `in_stock` and the other five filters correctly return nothing. The
filter is not wrong; there is simply nothing else to find yet.

- The **Assets** screen lists them in a table, searches by name, tag or serial number, filters by
  status, hides archived rows until the switch asks for them, and pages a workspace with more
  assets than one screen holds. All four are one server query; nothing is filtered in the browser.
- Adding an asset opens a dialog, and editing one opens the same dialog seeded from the row. The tag
  is the server's job — people read tags off stickers rather than inventing them.
- Each row carries a menu: edit, archive, restore. Archiving asks first and names what it is about
  to archive; restoring does not, because it takes nothing away.
- A **dashboard card** shows the most recently added assets.
- **Settings → Inventory → General** sets the shape of an asset tag — the prefix and how many digits
  it is padded to, so a workspace that already labels its laptops `LT-` keeps doing that. The number
  itself is a counter in the database rather than a setting: a number an administrator can edit is a
  number that produces a duplicate tag.
- Two permissions gate it: `inventory.asset.view` and `inventory.asset.manage`.
- Its strings ship in the five languages the platform speaks — English, Arabic, German, Persian,
  Turkish.

The whole API is five procedures under `/api/inventory`: list, get, create, update and archive an
asset. An asset's photo is settable through `create` and `update` and by nothing on the screen yet;
its custom values are settable by neither, and wait on custom fields below.

## Not built yet

Nothing here has a screen. Most of it is a table in `mod_inventory` and nothing more; each bullet
says how far it actually got. A register is worth designing whole, and a migration that adds a
column later is cheaper than one that reshapes a table. A table is not a feature, and this section
stays until each one ships.

- **Custody** — who is holding an item now, who held it before, and handing it on.
- **History** — an append-only timeline of every change to an asset. The writes exist: create,
  update, archive and restore each append an `asset_history` row, and the integration suite holds
  them to it. Nothing reads them back — there is no procedure and no screen.
- **Repairs** — what went away for repair, to whom, what it cost and when it came back.
- **Categories** — the column and the list filter exist; nothing can create a category.
- **Custom fields** — a workspace's own fields on an asset. `assets.custom` holds the values;
  nothing defines a field, so `create` and `update` refuse to write into it at all.
- **Attachments** — receipts, warranties and manuals against an asset or a repair.

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
