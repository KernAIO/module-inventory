---
'@kernhq/module-inventory': minor
---

Build the register the README described: custody, history, categories, repairs and files

At 0.2.0 this module had five procedures and a README with a "Not built yet" section listing five
things its own schema already had tables for. It has twenty-three now, and that section is gone.

**Custody** answers who is holding an item and who held it before. Handing over, handing on and
taking back are each one transaction that closes the open period, opens the next, and moves the
custodian, the date and the status together. The database is the arbiter rather than the service:
`custody_periods` has carried a GiST exclusion constraint since the schema was written and nothing
had ever called it, so two people handing the same item over at the same instant now settles in
Postgres and the one who loses is told to reload rather than shown a driver error.

**History** is the asset's own timeline, read newest first and paged, rendered as sentences a person
can read rather than a JSON diff. Somebody who has since left reads as a former member, not a uuid.

**Repairs** record what went away, to whom, what it cost and when it came back — one open repair per
item, decided by a partial unique index rather than by a service that checks and then writes. A
repair wins the status column and does not touch custody: a laptop at the workshop is still the
person's it was handed to, so completing a repair returns it to them rather than to stock.

**Files** are receipts, warranty cards and manuals. This module records that an asset has a file and
never holds a byte — the browser uploads to core, this stores the id it is handed, and removing one
detaches it rather than deleting core's copy.

**Categories** group what a workspace owns, and archive rather than delete, because
`assets.category_id` carries no foreign key and deleting one would leave every asset filed under it
pointing at nothing.

Assets now reach the rest of the product: they are in the workspace-wide search index so a tag read
off a sticker finds the item from the command palette, and `inventory:asset:<id>` resolves anywhere
— a chat message, a tracker issue — into the tag, the name and a link. Two nightly sweeps warn about
a warranty running out and a repair away too long. When somebody leaves, the workspace gets a return
list of what is still recorded as theirs — raised by core's own event, and by the People module's if
that module happens to be installed. Inventory works without it and declares no dependency on it,
and nothing is moved: custody changes because a person did something, and a hook that quietly
returned an item would write a handover nobody performed into the one record a company later argues
from.

**Repairs and Files are capabilities**, so a workspace that does not want them switches them off and
their procedures answer 404 rather than 403 — the surface is not there, rather than withheld.
Switching `repairs` off makes its facts inert instead of stranding an asset: an item cannot be left
`under_repair` behind a procedure that no longer answers, and switching back on restores it.

## The defects found on the way, because most of them were only reachable under load

- **The timeline could render "removed the file" above "added the file".** History was ordered by its
  uuidv7 primary key, and a uuidv7 is only ordered to the millisecond — the kernel fills the low ten
  bytes from `randomUUID()` with no intra-millisecond counter, so entries written inside one
  millisecond sorted at random. Paging never dropped or repeated a row, which is why it hid. History
  now carries its own sequence and pages on it. **Any module ordering an append-only table by
  uuidv7 has the same weakness.**
- **`assets.status` was a lost update.** Custody and repairs both derive it from both facts and
  neither locked the asset, so a handover and a repair completing at the same instant interleaved
  into a status that matched neither.
- **`assets.archive` refused on unlocked reads**, so archiving while an assign committed left an
  archived asset with an open custody period — a state the code called impossible.
- **Two handovers inside one millisecond wrote a period nobody held the item for.** Closing at
  `now()` and opening at `now()` makes `[t, t)`, and an empty range overlaps nothing, so the
  exclusion constraint waved it through.
- **Both nightly sweeps marked an item "told" when the notification never left.** Each is sent once
  per item and never again, so one bad night cancelled it permanently.
- **The scheduler could not read its own workspace registry.** `force row level security` subjects
  the table's owner to the policies too, so the enumeration returned zero workspaces for anything but
  a superuser — silently, nightly, for ever.
- **`custody.assign` never checked the new custodian was a member**, and then notified them; and
  `photoFileId` and `categoryId` were foreign ids accepted on trust.
- **A repair could be re-dated to before it came back**, and one dated far enough ahead disarmed the
  overdue sweep permanently.
- **The currency picker offered JPY and KWD against a hard-coded 1/100 minor unit** — ¥1000 stored as
  ¥10. The minor-unit exponent comes from the currency now.
- **Four real refusals reached every reader as "Something in the form was not accepted"**, sending
  people to inspect fields that were fine.

`module.test.ts`'s capability assertion was opt-in — it only checked procedures already listed in the
map, so one that should have been gated and was never added passed. It derives the expectation from
the router now, and a repairs procedure without its gate fails.
