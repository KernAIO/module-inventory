-- Row-level security. Hand-written, because drizzle-kit does not generate it.
--
-- **Every statement here is idempotent, and that is not decoration.** A module's migrations are the
-- first thing the kernel runs, so one that throws does not break its own module — it takes down the
-- whole host service, and `core` hosts five. `create policy` has no `if not exists`, so each is
-- preceded by an explicit drop; the same for the exclusion constraint. This file was replayed
-- against a schema that already had it (a regenerated journal is enough to cause that) and answered
-- `policy "categories_ws_isolation" for table "categories" already exists`, which stopped core
-- booting for everything, not only for inventory.
--
-- This is the last line, not the first: the API already checks membership and permission. It exists
-- for the query that skips them — a job, a report, a mistake — and for anyone who reaches the
-- database another way. A tenant table without a policy is simply readable.
--
-- `@kernhq/kernel` exports `rlsPolicySql('mod_inventory', '<table>')`, which emits exactly this
-- block per table. Superusers bypass RLS, so a database owned by one will pass a test that proves
-- nothing: run the application as a plain role.

alter table "mod_inventory"."counters" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."counters" force row level security;--> statement-breakpoint
drop policy if exists "counters_ws_isolation" on "mod_inventory"."counters";--> statement-breakpoint
create policy "counters_ws_isolation" on "mod_inventory"."counters"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_inventory"."categories" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."categories" force row level security;--> statement-breakpoint
drop policy if exists "categories_ws_isolation" on "mod_inventory"."categories";--> statement-breakpoint
create policy "categories_ws_isolation" on "mod_inventory"."categories"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_inventory"."assets" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."assets" force row level security;--> statement-breakpoint
drop policy if exists "assets_ws_isolation" on "mod_inventory"."assets";--> statement-breakpoint
create policy "assets_ws_isolation" on "mod_inventory"."assets"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_inventory"."field_defs" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."field_defs" force row level security;--> statement-breakpoint
drop policy if exists "field_defs_ws_isolation" on "mod_inventory"."field_defs";--> statement-breakpoint
create policy "field_defs_ws_isolation" on "mod_inventory"."field_defs"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_inventory"."custody_periods" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."custody_periods" force row level security;--> statement-breakpoint
drop policy if exists "custody_periods_ws_isolation" on "mod_inventory"."custody_periods";--> statement-breakpoint
create policy "custody_periods_ws_isolation" on "mod_inventory"."custody_periods"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_inventory"."asset_history" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."asset_history" force row level security;--> statement-breakpoint
drop policy if exists "asset_history_ws_isolation" on "mod_inventory"."asset_history";--> statement-breakpoint
create policy "asset_history_ws_isolation" on "mod_inventory"."asset_history"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_inventory"."repairs" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."repairs" force row level security;--> statement-breakpoint
drop policy if exists "repairs_ws_isolation" on "mod_inventory"."repairs";--> statement-breakpoint
create policy "repairs_ws_isolation" on "mod_inventory"."repairs"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_inventory"."attachments" enable row level security;--> statement-breakpoint
alter table "mod_inventory"."attachments" force row level security;--> statement-breakpoint
drop policy if exists "attachments_ws_isolation" on "mod_inventory"."attachments";--> statement-breakpoint
create policy "attachments_ws_isolation" on "mod_inventory"."attachments"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));

-- Custody is effective-dated: a change closes the open row and inserts a new one. This constraint
-- is what makes two overlapping custody periods for one asset impossible at the database level —
-- two concurrent transfers cannot both win. `effective_to` null means "still open", which tstzrange
-- treats as unbounded, so an open period conflicts with everything that would follow it.
alter table "mod_inventory"."custody_periods"
  drop constraint if exists "inventory_custody_no_overlap";--> statement-breakpoint
alter table "mod_inventory"."custody_periods"
  add constraint "inventory_custody_no_overlap"
  exclude using gist (
    asset_id with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  );
