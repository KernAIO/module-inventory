-- Custody, the history read side, and archivable categories.
--
-- Generated from `src/server/schema.ts` with `pnpm db:generate` and then guarded, in that order.
-- Hand-writing the SQL is what puts an unguarded `ALTER TABLE … ADD PRIMARY KEY` in a file instead
-- of an inline key inside a `CREATE TABLE IF NOT EXISTS`; generating first and adding the guards
-- after keeps the file the schema's own output.
--
-- **Append-only from here.** 0.2.0 is published and `core` depends on it, so this file adds and
-- never rewrites: a nullable column and an index, both of which the 0.2.0 image can read straight
-- past. Nothing is dropped, renamed or narrowed, so rolling that image back needs no dump.
--
-- **Both statements are idempotent.** A module's migrations are the first thing the kernel runs, so
-- one that throws does not break its own feature — it takes down the whole host service, and `core`
-- hosts five modules. `migrations.test.ts` applies this folder twice against a database created
-- from nothing and is what proves the guards are real rather than intended.

ALTER TABLE "mod_inventory"."categories" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint

-- `assets.history` pages by id, not by `created_at`: an id is uuidv7 so it already carries the
-- clock, and it is unique where a timestamp two rows written in one transaction share is not. The
-- index `0000_init.sql` created starts (workspace_id, asset_id, created_at) and cannot serve
-- `order by id desc`; this one can.
CREATE INDEX IF NOT EXISTS "inventory_asset_history_ws_asset_row_idx" ON "mod_inventory"."asset_history" USING btree ("workspace_id","asset_id","id");
