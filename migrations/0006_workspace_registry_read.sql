-- The one read in this module that has no workspace to be bound to.
--
-- Hand-written, because drizzle-kit does not generate policies — the same reason `0001_rls.sql` is
-- hand-written, and it carries the same guard: `create policy` has no `if not exists`, so it is
-- preceded by an explicit drop. `migrations.test.ts` applies this folder twice against a database
-- created from nothing and is what proves the guard is real rather than intended.
--
-- **Append-only.** 0.2.0 is published and `core` depends on it. This adds a policy and changes no
-- table, column or index, so the 0.2.0 image reads the schema afterwards exactly as it read it
-- before and rolling back needs no dump.
--
-- ## What was wrong
--
-- `mod_inventory.workspaces` is the registry the two nightly sweeps enumerate: a cron handler is
-- woken by a clock, so it has no workspace and `app.workspace_id` is unset for it by definition.
-- The table is a tenant table like every other — it carries `workspace_id` — so `0004` gave it
-- `enable`, `force` and the standard per-workspace policy, and the enumeration was left resting on
-- "the application connects as the schema's owner, and an owner bypasses RLS".
--
-- That is false, and `force row level security` is exactly the clause that makes it false: forcing
-- subjects the **table owner** to the policies as well. Only a superuser (or a role with BYPASSRLS)
-- is exempt. So on every deployment whose application role is an ordinary login role — which is what
-- the project's own RLS note asks for — `select workspace_id from mod_inventory.workspaces` with no
-- workspace bound returned **zero rows**. Not an error, not a warning: both sweeps found nothing to
-- do, every night, for ever. The development database runs as a superuser, which is precisely why
-- nothing noticed.
--
-- ## Why this shape of fix
--
-- Permissive policies are OR-ed, so this adds a second `for select` policy rather than touching the
-- first. It admits a session with **no workspace bound** — which is the scheduler, by construction,
-- since every request-bound read in this module goes through `kernel.database.withWorkspace` and
-- sets the GUC. A request-bound session therefore still matches only the original policy and still
-- sees exactly its own row: this widens nothing for anybody holding a workspace.
--
-- It is keyed on the *absence of a binding* rather than on a role name because a role name is a
-- deployment's choice — `kern`, `kern_app`, whatever an operator called it — and a migration that
-- named one would be right on one instance and wrong on the next. `set_config(..., true)` is
-- transaction-local, so an unbound read on a pooled connection sees the setting unset (NULL) or
-- empty; both are covered.
--
-- The table holds nothing but workspace ids and a timestamp — it is this module's own bookkeeping,
-- not tenant data anybody reads through the API. `assets`, `custody_periods`, `repairs` and the rest
-- are untouched and keep answering nothing at all to a session with no workspace, which is what
-- `inventory.int.test.ts` proves against a plain login role.

drop policy if exists "workspaces_unbound_read" on "mod_inventory"."workspaces";--> statement-breakpoint
create policy "workspaces_unbound_read" on "mod_inventory"."workspaces"
  for select
  using (coalesce(current_setting('app.workspace_id', true), '') = '');
