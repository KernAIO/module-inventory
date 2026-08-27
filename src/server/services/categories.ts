import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Category as CategoryModel } from '../../contract/models.js'
import { categories } from '../schema.js'
import { violated } from './db-errors.js'

type Row = typeof categories.$inferSelect

/** The unique index `0000_init.sql` put on (workspace_id, name). */
const NAME_TAKEN = 'inventory_categories_ws_name_uq'

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
   * Ordered by `order` and then by name, which is what makes a workspace that never touches the
   * order field still get an alphabetical picker rather than an arbitrary one — every row has
   * `order` 0, so the tiebreak is doing all the work and has to be a name rather than an id.
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
   * A duplicate name is a `CONFLICT` with the name in it, never a 500.
   *
   * The unique index is what actually decides — checking first and inserting after is a race that
   * two people adding "Laptops" at once will find — so the check is the insert, and the driver's
   * 23505 is translated into a sentence rather than shown as "Failed query: insert into
   * mod_inventory.categories …".
   */
  async create(tx: Tx, workspaceId: string, name: string, order: number): Promise<Row> {
    try {
      const [row] = await tx.insert(categories).values({ id: uuidv7(), workspaceId, name, order }).returning()
      return row!
    } catch (err) {
      throw CategoryService.nameTaken(err, name)
    }
  }

  async update(
    tx: Tx,
    workspaceId: string,
    categoryId: string,
    patch: { name?: string; order?: number },
  ): Promise<Row> {
    const previous = await this.get(tx, workspaceId, categoryId)
    // `undefined` means "not mentioned". Neither field is nullable, so there is no "clear it" here
    // and no reason for the `null`-versus-`undefined` care `assets.update` needs.
    const values = {
      name: patch.name ?? previous.name,
      order: patch.order ?? previous.order,
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
   */
  async archive(tx: Tx, workspaceId: string, categoryId: string, archived: boolean): Promise<Row> {
    const [row] = await tx
      .update(categories)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, categoryId)))
      .returning()
    if (!row) throw KernError.notFound('Category')
    return row
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
