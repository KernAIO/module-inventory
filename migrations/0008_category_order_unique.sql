-- No two live categories on the same place, enforced rather than intended.
--
-- Hand-written, because the repair below is not something drizzle-kit generates — the same reason
-- `0001_rls.sql`, `0006_workspace_registry_read.sql` and `0007_history_sequence.sql` are. Every
-- statement carries its own guard, and `migrations.test.ts` applies this folder twice against a
-- database created from nothing to prove the guards are real rather than intended.
--
-- ## What was wrong
--
-- The contract, the changeset and `CategoryService.list`'s own comment all said that `reorder` keeps
-- the live categories on distinct numbers, so the `order by "order", "name"` tiebreak never fires for
-- them. All three were describing an intention.
--
-- A category joins the end of the list by taking `(select coalesce(max("order"), -1) + 1)`, and a
-- restore appends the same way. Putting that subquery *inside* the insert removes a round trip; it
-- does not remove the race. Under READ COMMITTED every statement takes its own snapshot, so two
-- transactions appending at the same instant each read a list without the other's row in it and both
-- take the same number. `reorder`'s `select … for update` does not serialise them either: a row lock
-- cannot cover a row that does not exist yet, and a restore's subquery is evaluated against the
-- snapshot its statement started with rather than the one it would get after waiting.
--
-- Two live categories on one number is not a crash. It is a list whose order changes under somebody
-- when a name changes, and a *move up* that appears to do nothing because the row it swapped with
-- sorts back ahead of it by name.
--
-- ## Why an index
--
-- Because checking first and writing after is the race, not the fix — the same reason
-- `inventory_repairs_one_open_uq` is an index in `0003`. `CategoryService` takes a per-workspace
-- advisory lock so the ordinary append never meets this index at all; the index is what makes the
-- claim true whatever else reaches the table.
--
-- **Partial, over the live rows only.** An archived category keeps the number it had when it left,
-- and the next reorder renumbers a live row straight onto it. That collision is invisible — an
-- archived category is in no picker, no filter and no sequence — so a total unique index would refuse
-- an archive-and-reorder that is entirely correct.
--
-- ## The repair comes first, or the upgrade takes the host service down
--
-- A module's migrations are the first thing the kernel runs, so a `CREATE UNIQUE INDEX` that meets
-- rows already sharing a number does not break categories: it throws during boot, and `core` hosts
-- five modules and never binds its port. Every instance that has run 0.2.0 may hold such a pair, so
-- the duplicates are renumbered before the index is built.
--
-- The renumbering is confined to the workspaces that actually have a duplicate, and it walks them in
-- `("order", "name", "id")` — which is the order `list` already returns and therefore the order the
-- screen already showed. Nobody's arrangement visibly changes. `"order" <> ordered.rn - 1` is what
-- makes a replay match nothing rather than rewrite rows a second time.
--
-- ## Append-only, and readable by the image before this one
--
-- 0.2.0 is published and `core` depends on it. This changes no table and no column: it adds an index
-- and moves some integers within the range they already occupied, so the previous image reads the
-- table exactly as it read it before and rolling back needs no dump.

UPDATE "mod_inventory"."categories" AS c
   SET "order" = ordered.rn - 1
  FROM (SELECT "id",
               row_number() OVER (PARTITION BY "workspace_id" ORDER BY "order", "name", "id") AS rn
          FROM "mod_inventory"."categories"
         WHERE "archived_at" IS NULL
           AND "workspace_id" IN (SELECT "workspace_id"
                                    FROM "mod_inventory"."categories"
                                   WHERE "archived_at" IS NULL
                                   GROUP BY "workspace_id", "order"
                                  HAVING count(*) > 1)) AS ordered
 WHERE c."id" = ordered."id"
   AND c."order" <> ordered.rn - 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_categories_ws_order_live_uq"
  ON "mod_inventory"."categories" USING btree ("workspace_id","order") WHERE "archived_at" IS NULL;
