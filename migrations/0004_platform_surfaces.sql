-- The platform surfaces: a workspace registry the scheduler can read, and the two "already told
-- somebody" markers the two sweeps need.
--
-- Generated from `src/server/schema.ts` with `pnpm db:generate` and then guarded, in that order.
-- Hand-writing the SQL is what puts an unguarded `ALTER TABLE … ADD PRIMARY KEY` in a file instead
-- of an inline key inside a `CREATE TABLE IF NOT EXISTS`; generating first keeps the file the
-- schema's own output. The `if not exists` on the table, the two columns and the index, and the
-- `drop policy if exists` under them, are what was added afterwards.
--
-- **Append-only.** 0.2.0 is published and `core` depends on it, so this file only adds: a new table,
-- two nullable columns and an index. Nothing is dropped, renamed or narrowed, so the 0.2.0 image
-- reads the schema afterwards exactly as it read it before and rolling back needs no dump.
--
-- **Every statement is idempotent.** A module's migrations are the first thing the kernel runs, so
-- one that throws does not break its own feature — it takes down the whole host service, and `core`
-- hosts five modules. `migrations.test.ts` applies this folder twice against a database created from
-- nothing and is what proves the guards are real rather than intended.
--
-- Why `workspaces` exists at all: a cron handler is woken by a clock, so it starts with no workspace
-- and nothing to derive one from. Core would answer, and asking it every tick makes an overnight
-- sweep fail whenever core is briefly away. `module-tracker` keeps the same table for the same
-- reason. It gets a policy like every other table carrying `workspace_id`; the enumeration itself
-- cannot honour that policy — `app.workspace_id` is unset there by definition — and reads as the
-- owner, which is what every module's scheduler here already does.

CREATE TABLE IF NOT EXISTS "mod_inventory"."workspaces" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

alter table "mod_inventory"."workspaces" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."workspaces" force row level security;--> statement-breakpoint
drop policy if exists "workspaces_ws_isolation" on "mod_inventory"."workspaces";--> statement-breakpoint
create policy "workspaces_ws_isolation" on "mod_inventory"."workspaces"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

-- A warranty falls inside the notice window on every one of the days before it expires, so a sweep
-- with no marker sends the same notice every morning for a month. Cleared when `warranty_until`
-- itself moves.
ALTER TABLE "mod_inventory"."assets" ADD COLUMN IF NOT EXISTS "warranty_notified_at" timestamp with time zone;--> statement-breakpoint

-- The same, for a repair that has been away too long: it is still too long tomorrow.
ALTER TABLE "mod_inventory"."repairs" ADD COLUMN IF NOT EXISTS "overdue_notified_at" timestamp with time zone;--> statement-breakpoint

-- What the overdue sweep reads: one workspace's still-open repairs, oldest first.
-- `inventory_repairs_ws_asset_idx` starts (workspace_id, asset_id, sent_on) and cannot answer this
-- without visiting every asset, and `inventory_repairs_one_open_uq` is partial on the right
-- predicate but keyed by `asset_id` alone, so it cannot be scoped to a workspace.
CREATE INDEX IF NOT EXISTS "inventory_repairs_ws_open_idx" ON "mod_inventory"."repairs" USING btree ("workspace_id","sent_on") WHERE returned_on is null;
