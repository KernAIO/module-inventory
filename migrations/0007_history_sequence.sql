-- The timeline's own ordering key, because a uuidv7 is only ordered to the millisecond.
--
-- Hand-written, because drizzle-kit does not generate a sequence, a backfill or a `setval` — the
-- same reason `0001_rls.sql` and `0006_workspace_registry_read.sql` are hand-written. Every
-- statement carries its own guard, and `migrations.test.ts` applies this folder twice against a
-- database created from nothing to prove the guards are real rather than intended.
--
-- ## What was wrong
--
-- `asset_history` is read newest-first ordered by its primary key, on the grounds that a uuidv7
-- already carries the clock and is unique where `occurred_at` is not. Half of that is true. The
-- kernel's `uuidv7()` puts the millisecond in bytes 0-5 and fills bytes 6-15 from `randomUUID()`
-- with **no intra-millisecond counter**, so two entries written in the same millisecond sort in an
-- order decided by ten random bytes. It is stable for a given set of rows, so keyset paging stayed
-- correct — no gaps, no repeats — and the defect never showed up as a broken list. What it showed
-- up as is a timeline that renders "Bruno removed the file" above "Bruno added the file", which is
-- the one record a company later argues from.
--
-- `occurred_at` is no rescue: it defaults to `now()`, which is the *transaction* timestamp, so two
-- entries written in one transaction share it exactly.
--
-- ## Why a sequence
--
-- A sequence is exact rather than probabilistic: `nextval` hands out strictly increasing values
-- whatever the clock does, at whatever rate, and two entries written a microsecond apart are two
-- values. It is also cheap — one `nextval` per history row, no extra round trip — and it is the one
-- ordering key a module can own outright, where the clock belongs to the machine.
--
-- The unique index is on `(workspace_id, asset_id, seq)` because that is what the timeline reads:
-- one asset's entries, newest first, paged on `seq`. `inventory_asset_history_ws_asset_row_idx` is
-- left where it is — dropping an index is a schema change and this file only adds — and goes one
-- release later.
--
-- ## Append-only, and readable by the image before this one
--
-- 0.2.0 is published and `core` depends on it, so this file only adds: a sequence, a column, an
-- index. The column is `not null` **with a default**, which is what keeps the previous image
-- writing: it never names `seq`, so the default fills it, and it never selects `seq`, so it reads
-- the table exactly as it read it before. Rolling that image back needs no dump.
--
-- The backfill orders existing rows by `(occurred_at, id)` rather than leaving them to the physical
-- order a rewrite would produce. Within one millisecond that is still the arbitrary uuid order this
-- migration exists to replace — nothing can recover an order that was never recorded — but across
-- milliseconds it is the order the timeline already showed, so an existing instance's history does
-- not visibly reshuffle on upgrade.

CREATE SEQUENCE IF NOT EXISTS "mod_inventory"."asset_history_seq" AS bigint;--> statement-breakpoint

ALTER TABLE "mod_inventory"."asset_history" ADD COLUMN IF NOT EXISTS "seq" bigint;--> statement-breakpoint

-- Only the rows that have none, so a replay matches nothing and changes nothing.
--
-- `created_at` rather than `occurred_at`: the drizzle field is `occurredAt` and the *column* it maps
-- to is `created_at`, because `asset_history` reuses the module's `created()` factory. A migration
-- talks to the column, and this file's first draft talked to the field — which fails at
-- `column "occurred_at" does not exist`, during the module's own migration, which is a host service
-- that never binds its port rather than a broken timeline.
UPDATE "mod_inventory"."asset_history" AS h
   SET "seq" = ordered.rn
  FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn
          FROM "mod_inventory"."asset_history"
         WHERE "seq" IS NULL) AS ordered
 WHERE h."id" = ordered."id";--> statement-breakpoint

-- `GREATEST` so this only ever moves the sequence forward. A replay against a live database must
-- not hand back a value some open transaction has already taken.
SELECT setval('mod_inventory.asset_history_seq',
              GREATEST((SELECT coalesce(max("seq"), 0) FROM "mod_inventory"."asset_history"),
                       (SELECT last_value FROM "mod_inventory"."asset_history_seq")),
              true);--> statement-breakpoint

ALTER TABLE "mod_inventory"."asset_history"
  ALTER COLUMN "seq" SET DEFAULT nextval('mod_inventory.asset_history_seq');--> statement-breakpoint

ALTER TABLE "mod_inventory"."asset_history" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint

-- So `drop schema mod_inventory cascade` takes the sequence with it, and so does dropping the
-- column one release from now.
ALTER SEQUENCE "mod_inventory"."asset_history_seq"
  OWNED BY "mod_inventory"."asset_history"."seq";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_asset_history_ws_asset_seq_uq"
  ON "mod_inventory"."asset_history" USING btree ("workspace_id","asset_id","seq");
