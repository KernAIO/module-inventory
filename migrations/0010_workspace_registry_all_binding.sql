-- The registry read moves from "no workspace bound" to the `'*'` sentinel every other module uses.
--
-- Hand-written, because drizzle-kit does not generate policies — the same reason `0001_rls.sql` and
-- `0006_workspace_registry_read.sql` are hand-written, and it carries the same guard: `create
-- policy` has no `if not exists`, so it is preceded by an explicit drop. `migrations.test.ts`
-- applies this folder twice against a database created from nothing and is what proves the guard is
-- real rather than intended.
--
-- **Append-only.** It adds one policy and touches no table, column or index.
--
-- ## What was wrong
--
-- `0006` gave `mod_inventory.workspaces` a second `for select` policy so the two nightly sweeps
-- could enumerate it, and keyed that policy on the *absence* of a binding:
--
--     using (coalesce(current_setting('app.workspace_id', true), '') = '')
--
-- It reads the right rows. The shape is the problem: a policy that admits an unbound transaction
-- makes forgetting to bind a **leak** rather than a refusal, so any future code path that reaches
-- this table without setting `app.workspace_id` gets rows instead of nothing, silently. `chat` and
-- `mail` answer the identical question — a table that legitimately serves every workspace at once —
-- with a sentinel the caller has to type on purpose, and the project's own rules say to do the same:
-- "A table that legitimately serves every workspace at once binds `'*'`, never nothing."
--
-- `0006`'s comment argues for keying on absence-of-binding rather than on a role name, and that
-- reasoning is sound as far as it goes — a role name is a deployment's choice. It is a false choice
-- all the same: `'*'` is a third option and belongs to neither problem.
--
-- ## Why the old policy is still here
--
-- Every released version before this one enumerates this table **unbound**, and a rolling deploy
-- runs two adjacent releases against one schema on purpose — so dropping `workspaces_unbound_read`
-- in this migration would give the image being replaced zero rows back, which is precisely the
-- silent do-nothing sweep `0006` existed to fix. Permissive policies are OR-ed, so both stand and
-- both images work: the old one reads unbound, the new one binds `'*'`.
--
-- ## Follow-up: drop `workspaces_unbound_read`
--
-- It may be dropped in the **first release after the one carrying this migration** — by then no
-- running image enumerates the registry unbound, because `activeWorkspaces` binds the sentinel from
-- this version on and a rolling deploy only ever spans two adjacent releases. It cannot be dropped
-- before that without reintroducing the zero-row sweep on the image being replaced. That drop is a
-- migration of its own; nothing else has to change with it, because no caller in this module reads
-- the table unbound any more.

drop policy if exists "workspaces_all_read" on "mod_inventory"."workspaces";--> statement-breakpoint
create policy "workspaces_all_read" on "mod_inventory"."workspaces"
  for select
  using (current_setting('app.workspace_id', true) = '*');
