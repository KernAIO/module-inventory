import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm'
import { type Category as CategoryModel, MAX_LIVE_CATEGORIES } from '../../contract/models.js'
import { categories } from '../schema.js'
import { violated } from './db-errors.js'

type Row = typeof categories.$inferSelect

/** The unique index `0000_init.sql` put on (workspace_id, name). */
const NAME_TAKEN = 'inventory_categories_ws_name_uq'

/** What `reorder` returns: the live sequence as it now stands, and which rows actually moved. */
export interface Reordered {
  rows: Row[]
  /** Only the ids whose `order` changed — a change event for a row that did not move is a lie. */
  moved: string[]
}

/** The wire shape: drizzle gives Date objects for timestamps, the contract promises ISO strings. */
export function toCategory(row: Row): CategoryModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId as CategoryModel['workspaceId'],
    name: row.name,
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

/**
 * How a workspace groups what it owns.
 *
 * Small on purpose. A category is a name and a position in a list; everything interesting about an
 * asset belongs to the asset. The one thing here worth reading twice is that nothing deletes — see
 * `archive` below.
 */
export class CategoryService {
  /**
   * Ordered by `order` and then by name.
   *
   * `order` is the sequence somebody dragged their categories into, and no two **live** categories
   * share a number: `inventory_categories_ws_order_live_uq` is what makes that true rather than
   * intended. So for the live set the tiebreak never fires.
   *
   * It stays because `list` also reads the archived rows, and those are outside the index: an
   * archived category keeps the number it had when it left, and the very next reorder renumbers a
   * live row onto it. A duplicate must sort the same way twice, and a name is the only column a
   * person could predict.
   */
  async list(tx: Tx, workspaceId: string, includeArchived: boolean): Promise<CategoryModel[]> {
    const filters = [eq(categories.workspaceId, workspaceId)]
    if (!includeArchived) filters.push(isNull(categories.archivedAt))
    const rows = await tx
      .select()
      .from(categories)
      .where(and(...filters))
      .orderBy(asc(categories.order), asc(categories.name))
    return rows.map(toCategory)
  }

  async get(tx: Tx, workspaceId: string, categoryId: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, categoryId)))
    if (!row) throw KernError.notFound('Category')
    return row
  }

  /**
   * A new category joins the **end** of the sequence, and a duplicate name is a `CONFLICT` with the
   * name in it, never a 500.
   *
   * The unique index is what actually decides the name — checking first and inserting after is a
   * race that two people adding "Laptops" at once will find — so the check is the insert, and the
   * driver's 23505 is translated into a sentence rather than shown as "Failed query: insert into
   * mod_inventory.categories …".
   *
   * The position is decided the same way, in the statement rather than around it. It used to be an
   * optional number the caller passed and defaulted to 0, so every category anybody added landed at
   * the *front*, tied with whatever was already there, and the list resolved the tie by name — a
   * new category appearing in the middle of a sequence somebody had arranged by hand.
   *
   * **The subquery is not what makes the number unique — the lock above it is.** This used to say
   * that a subquery inside the insert stopped two creates in flight from taking the same maximum,
   * and that is false: under READ COMMITTED each statement takes its own snapshot, so both read a
   * list without the other's row in it and both appended to the same place. `lockAppends` is what
   * serialises them, and `inventory_categories_ws_order_live_uq` is what refuses the pair if
   * anything ever reaches the table around it.
   */
  async create(tx: Tx, workspaceId: string, name: string): Promise<Row> {
    await CategoryService.lockAppends(tx, workspaceId)
    await CategoryService.roomForOneMore(tx, workspaceId)
    try {
      const [row] = await tx
        .insert(categories)
        .values({ id: uuidv7(), workspaceId, name, order: CategoryService.appended(workspaceId) })
        .returning()
      return row!
    } catch (err) {
      throw CategoryService.nameTaken(err, name)
    }
  }

  /** A rename, and nothing else — the sequence is `reorder`'s to write. */
  async update(tx: Tx, workspaceId: string, categoryId: string, patch: { name?: string }): Promise<Row> {
    const previous = await this.get(tx, workspaceId, categoryId)
    // `undefined` means "not mentioned". The column is not nullable, so there is no "clear it" here
    // and no reason for the `null`-versus-`undefined` care `assets.update` needs.
    const values = {
      name: patch.name ?? previous.name,
      updatedAt: new Date(),
    }
    try {
      const [row] = await tx
        .update(categories)
        .set(values)
        .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, categoryId)))
        .returning()
      return row!
    } catch (err) {
      throw CategoryService.nameTaken(err, values.name)
    }
  }

  /**
   * Archive and restore, which are one procedure because they are one column.
   *
   * **Nothing here deletes, and that is the decision this file exists to record.**
   * `assets.category_id` carries no foreign key — a module keeps its ids plain — so a delete would
   * leave every asset filed under this category pointing at a row that is not there: a blank column
   * on the row, a picker that cannot explain what the asset used to be, and an `asset_history`
   * entry saying "category changed to <nothing>". None of it recoverable, all of it caused by a
   * settings screen. An archived category disappears from every picker and every filter and leaves
   * each asset able to say what it is.
   *
   * **A restore appends**, for the reason `create` appends. The row kept the position it had when
   * it left, and every live category has been renumbered since — so putting it back where its old
   * number points lands it in the middle of somebody's arrangement, tied with whatever is there
   * now. The end of the list is the one place a person can find it again. Archiving leaves the
   * number alone: it is out of every list that reads it, and it is about to be overwritten anyway.
   *
   * A restore appends, so it races exactly as `create` does and is serialised the same way — and it
   * is the one place other than `create` where the live set grows, so it is the other place the
   * limit is enforced. Archiving needs neither: it takes a row out of the live set, and out of the
   * partial index with it.
   */
  async archive(tx: Tx, workspaceId: string, categoryId: string, archived: boolean): Promise<Row> {
    if (!archived) {
      await CategoryService.lockAppends(tx, workspaceId)
      await CategoryService.roomForOneMore(tx, workspaceId)
    }
    const [row] = await tx
      .update(categories)
      .set({
        archivedAt: archived ? new Date() : null,
        ...(archived ? {} : { order: CategoryService.appended(workspaceId) }),
        updatedAt: new Date(),
      })
      .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, categoryId)))
      .returning()
    if (!row) throw KernError.notFound('Category')
    return row
  }

  /**
   * The sequence, rewritten from the ids somebody put it in — the only thing that writes `order`.
   *
   * Three refusals before a single row is touched, and all three are the same idea: this call
   * describes the whole live list, so a list that does not match the workspace is not a partial
   * instruction to be completed, it is an ordering of something else.
   *
   *   - **an id twice** — arithmetic that cannot be carried out, `BAD_REQUEST`;
   *   - **an id that is not this workspace's** — `NOT_FOUND`, the answer `update` and `archive`
   *     already give for one, and the answer that does not confirm the row exists elsewhere;
   *   - **a live category the list does not name, or an archived one it does** — somebody added,
   *     archived or restored a category while this page was open. Renumbering what was named would
   *     put the missing one wherever its stale number happened to land, silently. `CONFLICT` with
   *     `inventory.category.order_stale`, which the client turns into "reload and try again".
   *
   * All of it inside one transaction, opened by the router, so a refusal writes nothing and a
   * renumbering is never half-applied. The `for update` is what makes two reorders arriving at once
   * queue rather than interleave — without it both read the same list, both pass the check, and the
   * writes of one land between the writes of the other, which is how a sequence ends up being
   * neither of the two orders anybody asked for. Locking in id order is what stops two of them
   * taking the same rows in opposite orders and deadlocking.
   */
  async reorder(tx: Tx, workspaceId: string, categoryIds: string[]): Promise<Reordered> {
    const named = new Set(categoryIds)
    if (named.size !== categoryIds.length)
      throw KernError.badRequest('That list of categories names the same one more than once.')

    const current = await tx
      .select()
      .from(categories)
      .where(eq(categories.workspaceId, workspaceId))
      .orderBy(asc(categories.id))
      .for('update')
    const known = new Map(current.map((row) => [row.id, row]))

    if (categoryIds.some((id) => !known.has(id))) throw KernError.notFound('Category')
    const live = current.filter((row) => !row.archivedAt)
    if (live.some((row) => !named.has(row.id)) || categoryIds.some((id) => known.get(id)?.archivedAt))
      throw KernError.conflict(
        'The categories changed while this list was open, so this order was not saved. Reload the list and arrange it again.',
        'inventory.category.order_stale',
      )

    // Only the rows that actually move are touched — a workspace has tens of categories, they are
    // already locked, and a change event for a row whose position did not change would tell every
    // screen in the workspace about a write that did not happen. `moved` is settled here, before a
    // single write, so it stays the honest list whatever the two passes below do.
    const now = new Date()
    const going = categoryIds
      .map((id, index) => ({ id, index }))
      .filter(({ id, index }) => known.get(id)?.order !== index)
    const moved = going.map(({ id }) => id)

    /**
     * Parked out of the way first, and only then put down where they belong.
     *
     * `inventory_categories_ws_order_live_uq` is a plain unique index, and Postgres checks one of
     * those row by row rather than at the end of the statement. There is no deferrable form to reach
     * for either: a unique *constraint* can be deferred and cannot be partial, and this one has to be
     * partial. So the single-pass loop writes a collision the moment two rows swap — putting the
     * first on 1 while the second still holds 1 — and a swap is the commonest reorder there is.
     *
     * `park` sits above both the highest number any row in this workspace holds **and** the last
     * place in the new sequence. That is what makes the two passes safe: the parked values are
     * distinct from one another and from every row staying put, and the `0…n-1` the second pass
     * writes into is empty, because every live row that could have been sitting there is either
     * parked or already on the number it is being given.
     *
     * Only the rows that actually move are written, so a reorder that shifts one row does not stamp
     * `updated_at` across the whole list — and `updated_at` is left off the parking pass, which is
     * bookkeeping rather than a change anybody made.
     */
    if (going.length > 0) {
      const park = Math.max(...current.map((row) => row.order), categoryIds.length - 1) + 1
      for (const [offset, { id }] of going.entries()) {
        await tx
          .update(categories)
          .set({ order: park + offset })
          .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, id)))
      }
      for (const { id, index } of going) {
        await tx
          .update(categories)
          .set({ order: index, updatedAt: now })
          .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, id)))
      }
    }

    const rows = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, workspaceId), isNull(categories.archivedAt)))
      .orderBy(asc(categories.order), asc(categories.name))
    return { rows, moved }
  }

  /**
   * One past the highest position this workspace has used, archived rows counted.
   *
   * Archived rows count because one of them can be restored, and a restored category landing on a
   * live one's number is the tie this whole change exists to remove.
   *
   * **Only correct under `lockAppends`.** A subquery inside the write saves a round trip and settles
   * nothing about concurrency: under READ COMMITTED it is evaluated against the snapshot its own
   * statement started with, so two transactions appending at the same instant read the same maximum
   * and take the same number. That is the defect `0008` exists for.
   */
  private static appended(workspaceId: string) {
    return sql<number>`(select coalesce(max(${categories.order}), -1) + 1 from ${categories} where ${categories.workspaceId} = ${workspaceId})`
  }

  /**
   * Hold the right to append to this workspace's list until the transaction ends.
   *
   * An advisory lock rather than `select … for update`, because the thing being protected is the
   * *next* number rather than any row that exists: a workspace with no categories at all has no row
   * to lock, and two creates against it would still collide. Taken per workspace, so two workspaces
   * adding a category at the same moment never wait for each other.
   *
   * The first key is a constant for this list, so another module taking an advisory lock on the same
   * workspace does not queue behind this one by accident.
   *
   * It cannot deadlock against `reorder`, which takes row locks and never asks for this one — so
   * there is no pair of waits pointing at each other.
   */
  private static async lockAppends(tx: Tx, workspaceId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('mod_inventory.categories.order'), hashtext(${workspaceId}))`,
    )
  }

  /**
   * Refuse the one that would take a workspace past `MAX_LIVE_CATEGORIES`, and say so.
   *
   * The number exists because `categories.reorder` is handed every live category at once and that
   * array needs a bound. Leaving the bound only on the array is a silent ceiling: a workspace could
   * pass it one category at a time and then discover that the only procedure that can order them is
   * the one it can no longer call. Enforced here, the array can always name every live category a
   * workspace is allowed to have.
   *
   * **Live rows, not every row ever made**, so that archiving one frees a place — which is what the
   * refusal tells the reader to do, and the advice has to be true.
   */
  private static async roomForOneMore(tx: Tx, workspaceId: string): Promise<void> {
    const [row] = await tx
      .select({ n: count() })
      .from(categories)
      .where(and(eq(categories.workspaceId, workspaceId), isNull(categories.archivedAt)))
    if ((row?.n ?? 0) < MAX_LIVE_CATEGORIES) return
    throw KernError.conflict(
      `This workspace already has ${MAX_LIVE_CATEGORIES} categories, which is as many as Inventory keeps in one order. Archive one it no longer uses to make room.`,
      'inventory.category.limit_reached',
    )
  }

  /**
   * The unique index refused it, or something else did and must not be disguised.
   *
   * Rethrowing the original for anything that is not this constraint matters: turning every failed
   * insert into "that name is taken" would hide a real fault behind a sentence a person would act
   * on by renaming something, for ever.
   */
  private static nameTaken(err: unknown, name: string): unknown {
    if (!violated(err, NAME_TAKEN)) return err
    return KernError.conflict(
      `This workspace already has a category called “${name}”.`,
      'inventory.category.name_taken',
    )
  }
}
