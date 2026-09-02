---
'@kernhq/module-inventory': minor
---

Finish the register: custom fields, lost and retired items, and the last unreachable corners.

A workspace can now define its own fields on an asset — text, number, date, select, multiselect,
checkbox or URL, required or not, for every asset or for one category — in **Settings → Inventory →
Fields**; the asset form asks them, the panel shows them, the timeline names them, and every value
is checked against the definition on the server before it is stored (`fields.*`,
`inventory.field.manage`, `AssetInput.custom`).

An item can be **marked lost** (while somebody still holds it — they are still answerable) or
**retired** (once nobody does and nothing is at a repairer), and **reinstated** when it turns up or
the write-off was a mistake; either wins the status column, closes custody and repairs to the item,
and is recorded with a note (`assets.markLost`, `assets.retire`, `assets.reinstate`,
`Asset.disposition`, `inventory.asset.disposed` / `.reinstated`). The status filter stops offering
`reserved`, which nothing records.

The list sorts by name and by tag as well as by what was added last, and the custody tab says how
many other items the holder has — the first screen to call `custody.byUser`.

The archive history action is written as `archived` rather than `retired`, now that the word means
something else; earlier rows are read as the sentence they always meant. `migrations/meta` is
current again after three hand-written migrations, and `check-snapshot-drift.mjs` and
`journal.test.ts` keep it so.
