-- A repair cannot come back before it was sent.
--
-- Generated from `src/server/schema.ts` with `pnpm db:generate` and then guarded, in that order —
-- generating first is what keeps the file the schema's own output rather than a hand-written guess
-- at it. The `drop constraint if exists` and the `not valid` are what was added afterwards.
--
-- **Append-only.** 0.2.0 is published and `core` depends on it, so this file adds a constraint and
-- nothing else: no table is created, dropped, renamed or narrowed, and the 0.2.0 image reads the
-- schema afterwards exactly as it read it before. Rolling that image back needs no dump.
--
-- **Idempotent.** `add constraint` has no `if not exists`, so it is preceded by an explicit drop —
-- the same shape `0001_rls.sql` uses for the custody exclusion constraint, and for the same reason:
-- a module's migrations are the first thing the kernel runs, so one that throws does not degrade its
-- own feature, it stops the host service booting, and `core` hosts five modules. A regenerated
-- `migrations/meta/_journal.json` is enough to cause a replay. `migrations.test.ts` applies this
-- folder twice against a database created from nothing to prove the guard is real.
--
-- **`not valid`, and that is the whole difference between a safe upgrade and an outage.** The
-- constraint is enforced on every insert and update from the moment it exists; what `not valid`
-- skips is the scan of rows that are already there. Those rows are exactly the ones this defect may
-- have written — `repairs.update` would move `sent_on` past a `returned_on` — and a validating
-- constraint that met one of them would throw *during migration*, on somebody's instance, during an
-- upgrade, taking core down with it. An instance that wants the scan can run
-- `alter table … validate constraint …` by hand once it has corrected its data; nothing needs it to.
--
-- Why the database as well as the service: `repairs.update` and `repairs.complete` each check the
-- pair before writing it, and two transactions can each pass that check and still commit a pair that
-- fails it — one moving `sent_on` while the other logs the item back. The service check is what
-- gives an ordinary mistake a sentence; this is what makes the rule true of the table.

ALTER TABLE "mod_inventory"."repairs"
  DROP CONSTRAINT IF EXISTS "inventory_repairs_returned_after_sent";--> statement-breakpoint
ALTER TABLE "mod_inventory"."repairs"
  ADD CONSTRAINT "inventory_repairs_returned_after_sent"
  CHECK (returned_on is null or returned_on >= sent_on) NOT VALID;
