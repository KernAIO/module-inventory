# Changelog

## 0.4.0

### Minor Changes

- b02714d: Order categories by dragging them, and stop asking for a position number

  The categories settings page asked an administrator to type a **position** into a number field, with
  a hint explaining that lower comes first and that two categories sharing a number fall back to their
  names. That is a database column with a form around it: nobody arranges their filing by integer, the
  field invited the one state it then had to explain, and moving a category two places meant working
  out a number that would land it there.

  It is a list you drag now. `categories.reorder` takes the ids in the order they were dragged into
  and renumbers the live set in one transaction — the only thing that writes `order`. It insists on
  being handed every live category exactly once: a list that leaves one out is not an instruction to
  leave it alone, it is an ordering of a workspace that changed while the page was open, so the whole
  call is refused with `inventory.category.order_stale` rather than dropping the missing category
  wherever its stale number happened to land. An id from another workspace is `NOT_FOUND`, before
  anything is written.

  **A drag is a gesture, never a requirement, and the move-up and move-down buttons are the keyboard
  route to the same thing.** They are the _only_ one: the drag library ships a keyboard drag of its
  own, and shipping both left both half-working — a tab stop on every row that announced nothing, and
  a write on every arrow key of which all but the first were discarded — so it is switched off rather
  than kept as a worse duplicate of two real buttons. The result is spoken into a live region —
  "Cameras is after Laptops", never a position number. Presses that arrive while a save is in flight
  are coalesced into one follow-up write instead of being dropped, so three quick presses move the row
  three places and each one is announced where it actually landed.

  A refusal is recoverable. `inventory.category.order_stale` used to roll the screen back to the list
  the server had just refused, so every retry earned the same refusal under a message telling the
  reader to try again; the list now re-seeds from what the server actually has, and the message says
  that this order was not saved rather than implying the drag only needed repeating.

  `CategoryInput` no longer takes `order`, on create or on update: a second way to set the sequence
  would disagree with the first the moment anybody used it. **A new category now joins the end** of
  the list instead of landing at position 0 tied with everything else, and a restored one joins the
  end too rather than returning to a number that belongs to somebody else by now.

  **No two live categories share a place, and `0008_category_order_unique.sql` is what makes that a
  fact rather than an intention.** Appending took `max("order") + 1`, and putting that subquery inside
  the write removed a round trip without removing the race: under READ COMMITTED two transactions
  appending at the same instant both read a list without the other's row in it and both took the same
  number. Creates and restores are now serialised per workspace, `reorder` parks the rows it is moving
  above the sequence before putting them down so a swap never trips the index on the way, and a
  partial unique index over the live rows refuses the pair whatever else reaches the table. The
  migration renumbers any duplicates an existing instance is holding _before_ it builds the index —
  an index that met them would throw during boot, and a module's migrations are the first thing the
  host service runs.

  The ceiling on `categories.reorder` is stated rather than silent. Its input array is bounded, as any
  array a client fills has to be, and the same number — `MAX_LIVE_CATEGORIES`, exported from the
  contract — is enforced by `create` and by a restore, with `inventory.category.limit_reached` and a
  sentence naming the figure in the reader's own digits. A workspace can no longer grow past the bound
  one category at a time and then find that the only procedure able to order them refuses to run.

  The module also reports its own name in the reader's language now: `name` on the client manifest is
  `get name() { return t('nav') }` rather than an English literal, which is what the dashboard's widget
  picker heads this module's group with.

## 0.3.0

### Minor Changes

- a7d7de5: Build the register the README described: custody, history, categories, repairs and files

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

## 0.2.0

### Minor Changes

- f97a02b: Rebuild the asset register on a schema that applies and a list that really pages

  Two defects stood between this module and a database created from nothing, so they come first.

  `0001_rls.sql` copied HR's custody exclusion constraint — `asset_id with =`, `tstzrange(…) with &&`
  — without HR's `CREATE EXTENSION IF NOT EXISTS btree_gist`. Run the published migrations against a
  database created from nothing and the second one stops with "data type uuid has no default operator
  class for access method gist", inside the module's own migration, so the host service never
  finishes booting. It was invisible because every database it had ever run against already had the
  extension from somewhere else. `0000_init.sql` creates it now: core creates `pg_trgm`, `pgcrypto`,
  `ltree` and `vector`, and a module reaching past those declares its own.

  `mod_inventory.counters` gave `workspace_id` and `key` a column-level `.primaryKey()` each. That
  reads like a compound key and is not one — drizzle-kit 0.31 emits `PRIMARY KEY` on both columns,
  and Postgres answers "multiple primary keys for table are not allowed", SQLSTATE 42P16. The
  committed SQL happened to carry a composite constraint and applied cleanly, so the defect was one
  `pnpm db:generate` away rather than already in the tree; this change _is_ that regeneration, and
  without the fix it would have shipped a `0000_init.sql` no database accepts. A module's migration is
  the first thing the kernel runs, so that is not a broken table but a host service that never binds
  its port. It is a composite `primaryKey({ columns: [...] })` now.

  `counters` was also the one tenant table in this schema carrying no row-level security. RLS here is
  the last line rather than the first, and the line that matters is the query which skipped the API —
  a job, a report, a mistake. One row per workspace holding the next asset number is the wrong thing
  to leave open to every other tenant: read it and you know how much the company owns; write it and
  two workspaces hand out the same tag. It has `counters_ws_isolation` now, and
  `inventory.int.test.ts` fails on any table carrying `workspace_id` that is not held to a policy, so
  the next table added cannot repeat it.

  **The migrations were regenerated rather than appended to, and an existing database will not tell
  you.** `0000_init.sql` and `0001_rls.sql` are new files, not a `0002_`. That is defensible exactly
  once, and the reason is narrower than it first looks: **no Kern release has shipped this module.**
  There are no tags and no releases, so no instance runs it — not that the migrations never applied.
  They did apply, on every machine that ran `pnpm dev`.

  It is worth being precise about why, because the obvious argument is wrong. Published `0.1.x`
  cannot apply _standalone_ — `0001_rls.sql` reaches for `btree_gist` and nothing had created it, so
  the folder rolls back and leaves no trace. But `core` does not migrate this module standalone: it
  migrates `[tracker, quire, hr, billing, inventory]` in that order, and `module-hr`'s own
  `0000_init.sql` creates `btree_gist` three modules earlier. So inside `core` the old folder applied
  cleanly, and every development database that has ever booted `core` holds the **old** schema —
  `assets.status` still the four-value `public.asset_status`, `assets.custom` absent.

  The regenerated journal carries later timestamps than the one it replaced, so drizzle replays both
  files. Both are idempotent by design (`create … if not exists` throughout `0000`, a drop before
  every create in `0001`, because a migration that throws takes down a `core` hosting five modules) —
  which removes the crash and _not_ the problem. A replayed `create table if not exists` reports
  success and changes nothing, so `__migrations` gains a row, the boot log is clean, and the schema
  is still the old one. Every inventory procedure then fails on a column that is not there.

  So if you have ever run this module's migrations, drop the schema and let them run again:

  ```sql
  drop schema mod_inventory cascade;
  drop type if exists public.asset_status;
  ```

  The second line is not optional and is easy to miss: cascading a schema drop leaves the type behind
  in `public`, orphaned — which is the very thing moving off `pgEnum` was meant to stop.

  After the first tagged Kern release this repository is append-only forever, and a change of this
  shape becomes a `0002_` that adds and backfills.

  `src/server/migrations.test.ts` is new and exists so none of the above has to be remembered: it
  applies the whole folder to a database created from nothing, applies it **again**, and asserts every
  policy exists exactly once with row-level security forced. Deleting a single `drop policy if exists`
  turns it red with `policy "assets_ws_isolation" for table "assets" already exists` — the error that
  took `core` down.

  `assets.status` moved off a `public.asset_status` pgEnum onto `text`. A generic type name in the
  shared `public` schema collides with whatever module names a status next, and it outlives the
  module — removing Inventory leaves the type behind for a schema nobody owns. Every other Kern module
  stores a status as text. `assets.custom jsonb` arrived in the same pass, because `field_defs` has
  described values in a column that did not exist since the day it was written.

  `assets.list` pages for real. It takes an opaque cursor and orders by the sort column _and_ the id —
  `name` is not unique, and a keyset cursor on a non-unique column either repeats a row or skips one —
  and it filters on `q`, `status`, `categoryId`, `custodianUserId` and `archived` in SQL. The screen
  and the dashboard card used to ask for a page and then drop rows in the browser, which is only ever
  right for a list that is entirely loaded: twenty rows came back, eleven were shown, and the list
  looked short rather than paged. A workspace whose twenty most recent assets were all archived got a
  card that was empty without being empty. The screen is rebuilt on `Page`, `PageHeader` and `Table`,
  so search, the status filter, the archived switch and "load more" are all one server query.

  The cursor carries the bookmarked row's id and the sort it was issued under, and nothing else — the
  sort key is read back from that row in SQL. Carrying the key itself was wrong three ways, each of
  them reachable by anyone who can type into the address bar. `decode` checked only that the id was a
  _string_, and the id is interpolated into a `::uuid` cast, so a marker holding `not-a-uuid` reached
  Postgres as a 22P02 nobody caught: an unhandled 500 and an error-level log line per request, at the
  600 a minute the rate limiter allows. It was not bound to its sort, so a cursor issued under
  `recent` and replayed under `code` compared a uuid against a code — page two came back equal to page
  one and "Load more" never ended. And it was unbounded: `sort=name` on a 200-character Persian name
  encoded to 602 characters, against the `max(512)` that `Cursor` in `@kernhq/contracts` allows, so a
  long enough name broke paging in exactly the locales least likely to be tested. The id alone is a
  fixed ~60 characters whatever somebody called the asset.

  `assets.update` is a patch, and every editable field reads the same way now: `undefined` means _not
  mentioned_ and keeps what is there, `null` means _clear it_. `description` did not, so a patch that
  moved an asset to another desk cleared the description on the way past — silently, because the
  request succeeded and the screen redrew with the field simply empty, and the paragraph explaining
  where the serial number is hiding was gone. `inventory.int.test.ts` holds each field to both halves
  of that rule, and the timeline to it as well: an update writes a diff naming only what actually
  moved, and writes nothing at all for an update that moved nothing.

  The two files that had grown into everything are split. `src/contract.ts` is now `src/contract/` —
  `models`, `router`, `permissions`, `events`, `capabilities`, `settings` behind a barrel — and
  `src/server/_impl.ts` is a thin `src/server/router.ts` over `src/server/services/`. Handlers open the
  workspace-bound transaction and hand straight over, which is what gives the keyset SQL somewhere to
  live that is not a route handler.

  Two things moved out of that transaction, and the split is what made both visible. Module settings
  are read before it opens: `kernel.settings.module` is a `core.settings.getModule` call over the
  broker, and `nextCode` awaited it holding both a pooled connection and the `counters` row lock — the
  one row every concurrent create in the workspace queues behind. The pool starves under load, and a
  create fails outright whenever core is briefly away, which is the exact thing this module's own
  side-effect layer exists to prevent. And core's copy of the history row is recorded after the
  commit rather than fired off with `void` during it, because a transaction that rolled back had
  already told the workspace's activity feed about an asset that does not exist. The `asset_history`
  row stays inside the transaction: it is the authoritative record, and the mirror is not.

  `assets.archive` is the restore path too, and it announced `inventory.asset.archived` whichever way
  the flag pointed — telling every subscriber that a restored item had just been retired, while the
  history row written beside it in the same transaction said `restored`. There is an
  `inventory.asset.restored` event now, and the procedure picks between them.

  Every export the package had it still has, but one of the paths under them had to move with the
  files. `exports["./contract"]` still named `./dist/contract.js`, which the build had stopped
  emitting. A consumer importing `@kernhq/module-inventory/contract` off a clean build would have got
  `ERR_MODULE_NOT_FOUND`; it names `./dist/contract/index.js` now. Nothing here caught it, because
  `tsc` does not empty `dist/` and every local build still had yesterday's `contract.js` sitting in
  it. Both tsconfigs still listed `src/contract.ts` in `include` for the same reason, and compiled
  only because `src/server` reaches the contract through its own imports — so a contract file the
  server does not import would have been neither type-checked nor emitted. They name the directory
  now, as `module-tracker` and `module-chat` do.

  The module shipped four locales where every other module ships five, so a Turkish workspace read
  English in the middle of its own interface. `tr` is here, and `reserved` and `lost` have labels in
  all five: a screen renders a status with `` t(`status_${status}`) ``, which no type-checker can see,
  so adding a status to the enum and forgetting the translations puts the literal key
  `inventory.status_lost` in the middle of a table in every language at once. `messages.test.ts` is
  the guard — one key set across five bundles, all six CLDR categories for Arabic, every placeholder
  preserved in every plural form, and a label for each status the contract can hold. `module.test.ts`
  gained the capability assertions beside it: the capability-to-procedure map may name only
  capabilities and procedures that exist, and anything it names has to be carrying the middleware.
  Only `core` is declared, and it is `required` — a switch with nothing behind it teaches an
  administrator that the switchboard means nothing.

  The assets list refreshes on a realtime change. `realtime.svelte.ts` invalidates `[module, entity]`
  with whatever the server put in the change event, and the router emits `entity: 'asset'` — while
  `query.ts` spelled the list key `['inventory', 'assets', …]`, which that prefix never matches:
  `partialMatchKey` compares segment by segment, and `'assets'` is not `'asset'`. The detail key was
  already singular, so a colleague's create refreshed the panel nobody had open and left the table and
  the dashboard card behind it stale until somebody reloaded. Every other module keys the list and the
  row off one singular entity name; so does this one.

  The table has row actions, so `update` and `archive` are reachable at all. Both procedures shipped
  with nothing on the screen able to call them: the register could gain an asset and never correct a
  typo in one or retire one, and the only recourse was the API. The row menu edits, archives and
  restores. Archiving opens a dialog naming the asset and saying what happens to it, rather than
  asking "Are you sure?"; restoring is not destructive, so it asks nothing. For somebody without
  `inventory.asset.manage` the menu is absent rather than disabled, and the column that carries it
  is not in the grid — a door that will not open teaches people to stop trying doors.

  The dialog creates and edits, and it guards a double submit with a plain flag set in the same tick
  as the click. `disabled={create.isPending}` reaches the button on the next render and two quick
  clicks are one render apart, so a double-click filed two assets: two rows, two tags, one of them a
  duplicate somebody reconciles by hand.

  **A price typed `1.234,56` was stored as €1.23, and nothing said so.** The dialog parsed with
  `Number.parseFloat(raw.replace(',', '.'))`, which turns a comma into a decimal point and leaves
  every group separator where it stands. `1.234,56` — how German and Turkish write twelve hundred —
  becomes `1.234.56`, and `parseFloat` stops at the second dot and answers `1.234`. English's
  `1,234.56` arrives at that same string by the same route, and `String.replace` given a string
  pattern replaces only the first match, so `1,234,567.89` fares no better: all three stored 123 minor
  units. A €1,234.56 laptop went into the register at €1.23, and nothing about the row afterwards
  looked wrong. The parser answered `null` for anything it could not read at all and the form treated
  that as "no price", so `abc`, `-5` and a Persian reader's `۱٬۲۳۴٫۵۶` each saved an asset with the
  price silently missing rather than an error. `src/client/price.ts` asks `Intl` what the reader's own
  separators are rather than tabulating them, folds Persian and Arabic digits, refuses a group
  separator that does not precede exactly three digits, and formats a stored price back into the field
  the same way it reads one — so seeding the edit form cannot hand the parser a number it then calls
  invalid. Every outcome is a number or a rejection the form shows; there is no third one where a
  wrong number is stored quietly. `price.test.ts` holds it to all five locales.

  The README described custody, history and repairs in the present tense. Custody and repairs have
  tables and nothing else; history has writes and no way to read them back. This repository is public,
  so all three read as a promise to strangers. It says what the module does today now, and marks each
  unbuilt feature with the state it is actually in — a blanket "none of this exists" would have been
  its own kind of wrong, because the history trail really is written and tested.

## 0.1.2

### Patch Changes

- bd04ee4: Declare the framework this is built against: `@kernhq/contracts@0.7.0`.

  `^0.6.1` cannot install 0.7.0 — a caret on 0.x never crosses a minor — so a host resolving this
  module from the registry would be told it needs a contracts two releases behind the one every
  service now runs. Typechecked against 0.7.0 in the workspace before the range moved, which is the
  only order that means anything: the umbrella pins contracts to `workspace:*`, so raising a range
  first and compiling second compiles against the old copy and proves nothing.

  The lockfile is refreshed in the same change, because `--frozen-lockfile` compares specifiers and
  a range edit alone fails install before anything is built.

## 0.1.1

### Patch Changes

- e50598b: fix: raise @kernhq ranges to what is published

  A caret on 0.x never crosses a minor, so `@kernhq/ui: ^0.8.0` could not install the published 0.9.0. Raised it to `^0.9.0`.

- c95f157: Reach the published framework, and refresh the lockfile that the range edit invalidated.

  `^0.9.0` cannot install `@kernhq/ui@0.10.0` — a caret on 0.x never crosses a minor — so a consumer
  installing this module from the registry resolved a framework it was not built against. Raising the
  range then leaves the committed `pnpm-lock.yaml` out of date with the manifest, and
  `--frozen-lockfile` compares specifiers, so the next publish dies at install having built nothing.
  Both halves are here because one without the other is not a fix.

  `scripts/check-ranges.mjs` now checks the lockfile as well, so the second half cannot be forgotten
  again — and checks this package's hosts against its peers, which `pnpm install` does not: pnpm 10
  resolved a `^0.6.1` peer against `contracts@0.5.2` and exited 0 without a warning.

## 0.1.0

First release: the asset register. Assets with an auto-assigned tag, purchase and warranty
details, serial numbers, categories, and a full change history per asset.
