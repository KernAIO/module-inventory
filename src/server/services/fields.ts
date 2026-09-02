import { KernError, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm'
import {
  type FieldCreateInput,
  type FieldDef as FieldDefModel,
  type FieldPatchInput,
  type FieldType,
  MAX_LIVE_FIELDS,
} from '../../contract/models.js'
import { fieldDefs } from '../schema.js'
import { violated } from './db-errors.js'

type Row = typeof fieldDefs.$inferSelect

/** The unique index `0000_init.sql` put on (workspace_id, key). */
const KEY_TAKEN = 'inventory_field_defs_ws_key_uq'

/** The two types that carry a list of choices; every other type carries none. */
const CHOICE_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['select', 'multiselect'])

/** What `reorder` returns: the live sequence as it now stands, and which rows actually moved. */
export interface Reordered {
  rows: Row[]
  moved: string[]
}

/** The wire shape: drizzle gives Date objects for timestamps, the contract promises ISO strings. */
export function toFieldDef(row: Row): FieldDefModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId as FieldDefModel['workspaceId'],
    categoryId: row.categoryId,
    key: row.key,
    name: row.name,
    description: row.description,
    type: row.type as FieldType,
    options: row.options ?? [],
    required: row.required,
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

/**
 * What a patch to `assets.custom` is checked against, and what comes out of it.
 *
 * `current` is what the row holds; `patch` is what the request said, where `null` under a key
 * clears it and a key not mentioned is left alone. `categoryId` is the category the asset will be
 * filed under *after* this write, because that is what decides which required fields apply.
 */
export interface CustomWrite {
  current: Record<string, unknown>
  patch: Record<string, unknown> | undefined
  categoryId: string | null
  /** `create` has to satisfy every applicable required field; `update` only may not clear one. */
  creating: boolean
}

/**
 * A workspace's own fields, and the one place a value written under one is checked.
 *
 * Shaped like `CategoryService` — a name and a position in a list, archived rather than deleted,
 * the sequence rewritten whole by `reorder` — because it is the same kind of thing: workspace
 * configuration everybody's assets are filed against. The part that is new is `apply`, which is
 * what stops `assets.custom` from becoming a bag: every key in a request is a claim about a field
 * definition in this workspace, and it is checked before it is stored.
 */
export class FieldService {
  /**
   * Ordered by `order` and then by name, for the reason `CategoryService.list` gives — two live
   * rows never share a number under the advisory lock below, and the tiebreak is for the archived
   * ones, which keep whatever number they left with.
   */
  async list(tx: Tx, workspaceId: string, includeArchived: boolean): Promise<Row[]> {
    const filters = [eq(fieldDefs.workspaceId, workspaceId)]
    if (!includeArchived) filters.push(isNull(fieldDefs.archivedAt))
    return tx
      .select()
      .from(fieldDefs)
      .where(and(...filters))
      .orderBy(asc(fieldDefs.order), asc(fieldDefs.name))
  }

  async get(tx: Tx, workspaceId: string, fieldId: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(fieldDefs)
      .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, fieldId)))
    if (!row) throw KernError.notFound('Field')
    return row
  }

  /**
   * A new field joins the **end** of the sequence, and a duplicate key is a `CONFLICT` naming it,
   * never a 500 — the same two decisions `CategoryService.create` makes, for the same reasons.
   *
   * The type decides whether `options` means anything: a `select` with no choices is a question
   * nobody can answer, and a `text` field with choices is a list nothing will ever read. Both are
   * refused here rather than stored and puzzled over on the form.
   */
  async create(tx: Tx, workspaceId: string, input: FieldCreateInput): Promise<Row> {
    const options = FieldService.checkOptions(input.type, input.options)
    await FieldService.lockAppends(tx, workspaceId)
    await FieldService.roomForOneMore(tx, workspaceId)
    try {
      const [row] = await tx
        .insert(fieldDefs)
        .values({
          id: uuidv7(),
          workspaceId,
          categoryId: input.categoryId ?? null,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          options,
          required: input.required ?? false,
          order: FieldService.appended(workspaceId),
        })
        .returning()
      return row!
    } catch (err) {
      throw FieldService.keyTaken(err, input.key)
    }
  }

  /**
   * Everything but the key and the type. `undefined` means "not mentioned"; `null` on the two
   * nullable columns means "clear it".
   *
   * Changing the options of a `select` leaves every value already written exactly as it is — the
   * value *is* the word, and a rename here cannot reach into a thousand asset rows to change it.
   * That is stated on the settings screen rather than silently done or silently refused.
   */
  async update(tx: Tx, workspaceId: string, fieldId: string, patch: FieldPatchInput): Promise<Row> {
    const previous = await this.get(tx, workspaceId, fieldId)
    const options =
      patch.options !== undefined
        ? FieldService.checkOptions(previous.type as FieldType, patch.options)
        : previous.options
    const [row] = await tx
      .update(fieldDefs)
      .set({
        name: patch.name ?? previous.name,
        description: patch.description !== undefined ? (patch.description ?? null) : previous.description,
        categoryId: patch.categoryId !== undefined ? (patch.categoryId ?? null) : previous.categoryId,
        options,
        required: patch.required ?? previous.required,
        updatedAt: new Date(),
      })
      .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, fieldId)))
      .returning()
    return row!
  }

  /**
   * Archive and restore, one procedure because they are one column — and nothing deletes, because
   * every asset that carries a value under this key goes on carrying it. An archived field is asked
   * about nowhere and writable by nothing; a restore appends, exactly as a category's does.
   */
  async archive(tx: Tx, workspaceId: string, fieldId: string, archived: boolean): Promise<Row> {
    if (!archived) {
      await FieldService.lockAppends(tx, workspaceId)
      await FieldService.roomForOneMore(tx, workspaceId)
    }
    const [row] = await tx
      .update(fieldDefs)
      .set({
        archivedAt: archived ? new Date() : null,
        ...(archived ? {} : { order: FieldService.appended(workspaceId) }),
        updatedAt: new Date(),
      })
      .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, fieldId)))
      .returning()
    if (!row) throw KernError.notFound('Field')
    return row
  }

  /**
   * The sequence, rewritten from the ids somebody put it in. The three refusals are
   * `CategoryService.reorder`'s, and are argued there: an id twice, an id that is not this
   * workspace's, and a list that no longer describes the live set.
   *
   * One pass rather than the park-then-place two that categories need: there is no unique index
   * on `(workspace_id, "order")` here, so two rows may pass through the same number mid-statement
   * without Postgres objecting. The end state is the same, and the advisory lock in `create` is
   * what keeps the *next* number unique.
   */
  async reorder(tx: Tx, workspaceId: string, fieldIds: string[]): Promise<Reordered> {
    const named = new Set(fieldIds)
    if (named.size !== fieldIds.length)
      throw KernError.badRequest('That list of fields names the same one more than once.')

    const current = await tx
      .select()
      .from(fieldDefs)
      .where(eq(fieldDefs.workspaceId, workspaceId))
      .orderBy(asc(fieldDefs.id))
      .for('update')
    const known = new Map(current.map((row) => [row.id, row]))

    if (fieldIds.some((id) => !known.has(id))) throw KernError.notFound('Field')
    const live = current.filter((row) => !row.archivedAt)
    if (live.some((row) => !named.has(row.id)) || fieldIds.some((id) => known.get(id)?.archivedAt))
      throw KernError.conflict(
        'The fields changed while this list was open, so this order was not saved. Reload the list and arrange it again.',
        'inventory.field.order_stale',
      )

    const now = new Date()
    const going = fieldIds
      .map((id, index) => ({ id, index }))
      .filter(({ id, index }) => known.get(id)?.order !== index)
    for (const { id, index } of going) {
      await tx
        .update(fieldDefs)
        .set({ order: index, updatedAt: now })
        .where(and(eq(fieldDefs.workspaceId, workspaceId), eq(fieldDefs.id, id)))
    }

    const rows = await tx
      .select()
      .from(fieldDefs)
      .where(and(eq(fieldDefs.workspaceId, workspaceId), isNull(fieldDefs.archivedAt)))
      .orderBy(asc(fieldDefs.order), asc(fieldDefs.name))
    return { rows, moved: going.map(({ id }) => id) }
  }

  /**
   * The values an asset will hold after a write, or a refusal naming the field.
   *
   * **This is the whole reason `assets.custom` is allowed to exist.** Every key in the patch is
   * looked up; a key nothing defines, a field that has been archived, a value of the wrong shape,
   * and a required field being cleared are each a `BAD_REQUEST` carrying a stable `reason` and the
   * field's own name, so the client can say «Cost centre needs a number» in the reader's language
   * rather than printing this file's English.
   *
   * A patch **merges**. A form only knows about the fields it rendered — the ones for the asset's
   * category, plus the workspace-wide ones — and must not be able to wipe a value it never saw by
   * omitting it. `null`, `''` and `[]` under a key all mean "clear it", because those are what an
   * emptied control produces and a stored empty string is a value nobody meant.
   *
   * **Required is enforced against the fields that apply**, which is the workspace-wide ones plus
   * those scoped to the category the asset ends up in. On create every one of those has to arrive;
   * on update none of them may be cleared, and one an older asset never had is left missing rather
   * than refused — a field made required last week cannot make every existing asset uneditable.
   */
  async apply(tx: Tx, workspaceId: string, write: CustomWrite): Promise<Record<string, unknown>> {
    const defs = await this.list(tx, workspaceId, true)
    const byKey = new Map(defs.map((def) => [def.key, def]))
    const next: Record<string, unknown> = { ...write.current }

    for (const [key, raw] of Object.entries(write.patch ?? {})) {
      const def = byKey.get(key)
      if (!def)
        throw KernError.badRequest(`No field is defined under the key “${key}” in this workspace.`, {
          reason: 'inventory.field.unknown',
          field: key,
        })
      if (def.archivedAt)
        throw KernError.badRequest(
          `The field “${def.name}” is archived, so nothing can be written under it.`,
          {
            reason: 'inventory.field.archived',
            field: def.name,
          },
        )
      const value = FieldService.normalise(def.type as FieldType, raw)
      if (value === null) delete next[key]
      else next[key] = FieldService.check(def, value)
    }

    const applies = (def: Row) => def.categoryId === null || def.categoryId === write.categoryId
    for (const def of defs) {
      if (def.archivedAt || !def.required || !applies(def)) continue
      const present = next[def.key] !== undefined
      const cleared = write.current[def.key] !== undefined && !present
      if ((write.creating && !present) || cleared)
        throw KernError.badRequest(`The field “${def.name}” is required.`, {
          reason: 'inventory.field.required',
          field: def.name,
        })
    }
    return next
  }

  /** What "nothing here" looks like from each control, collapsed to `null`. */
  private static normalise(type: FieldType, raw: unknown): unknown {
    if (raw === null || raw === undefined) return null
    if (type === 'multiselect' && Array.isArray(raw) && raw.length === 0) return null
    if (typeof raw === 'string' && raw.trim() === '') return null
    return raw
  }

  /** The value, if it is the shape the field's type promises, or the refusal naming the field. */
  private static check(def: Row, value: unknown): unknown {
    const type = def.type as FieldType
    const options = def.options ?? []
    const ok = (() => {
      switch (type) {
        case 'text':
          return typeof value === 'string' && value.length <= 4000
        case 'number':
          return typeof value === 'number' && Number.isFinite(value)
        case 'date':
          return (
            typeof value === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
          )
        case 'checkbox':
          return typeof value === 'boolean'
        case 'select':
          return typeof value === 'string' && options.includes(value)
        case 'multiselect':
          return (
            Array.isArray(value) &&
            value.every((item) => typeof item === 'string' && options.includes(item)) &&
            new Set(value).size === value.length
          )
        case 'url':
          return typeof value === 'string' && value.length <= 2000 && FieldService.isHttpUrl(value)
      }
    })()
    if (!ok)
      throw KernError.badRequest(`“${def.name}” does not hold a value of that kind.`, {
        reason: 'inventory.field.invalid',
        field: def.name,
        type,
      })
    return typeof value === 'string' ? value.trim() : value
  }

  private static isHttpUrl(value: string): boolean {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  /**
   * The choices, if the type takes any — and none, if it does not.
   *
   * Trimmed, de-duplicated by exact text, and refused when a choice type is left with nothing to
   * choose from. A `text` field handed options is refused rather than silently emptied: somebody
   * built a list, and dropping it says less than telling them the type does not read one.
   */
  private static checkOptions(type: FieldType, options: string[] | undefined): string[] {
    const cleaned = [...new Set((options ?? []).map((option) => option.trim()).filter(Boolean))]
    if (CHOICE_TYPES.has(type)) {
      if (cleaned.length === 0)
        throw KernError.badRequest('A choice field needs at least one choice.', {
          reason: 'inventory.field.no_options',
        })
      return cleaned
    }
    if (cleaned.length > 0)
      throw KernError.badRequest(`A ${type} field does not take a list of choices.`, {
        reason: 'inventory.field.options_unused',
      })
    return []
  }

  /** One past the highest position this workspace has used, archived rows counted. Under `lockAppends` only. */
  private static appended(workspaceId: string) {
    return sql<number>`(select coalesce(max(${fieldDefs.order}), -1) + 1 from ${fieldDefs} where ${fieldDefs.workspaceId} = ${workspaceId})`
  }

  /** Hold the right to append to this workspace's list until the transaction ends. See `CategoryService`. */
  private static async lockAppends(tx: Tx, workspaceId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('mod_inventory.field_defs.order'), hashtext(${workspaceId}))`,
    )
  }

  private static async roomForOneMore(tx: Tx, workspaceId: string): Promise<void> {
    const [row] = await tx
      .select({ n: count() })
      .from(fieldDefs)
      .where(and(eq(fieldDefs.workspaceId, workspaceId), isNull(fieldDefs.archivedAt)))
    if ((row?.n ?? 0) < MAX_LIVE_FIELDS) return
    throw KernError.conflict(
      `This workspace already has ${MAX_LIVE_FIELDS} fields, which is as many as an asset form will hold. Archive one it no longer uses to make room.`,
      'inventory.field.limit_reached',
    )
  }

  private static keyTaken(err: unknown, key: string): unknown {
    if (!violated(err, KEY_TAKEN)) return err
    return KernError.conflict(
      `This workspace already has a field with the key “${key}”.`,
      'inventory.field.key_taken',
    )
  }
}
