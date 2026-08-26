import {
  defineModule,
  defineServerModule,
  KernError,
  type Kernel,
  packageVersion,
  type RequestContext,
  requires,
  type Tx,
  uuidv7,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { type Asset as AssetModel, inventoryContract, inventoryEvents, MODULE_ID } from '../contract.js'
import { assetHistory, assets, counters } from './schema.js'

/**
 * The router, kept apart from `index.ts` so `module.test.ts` can walk it without booting a kernel.
 *
 * Two middlewares on every procedure, and the test fails if either is missing:
 * `workspaceScoped` (a real membership, and the module switched on for that workspace) and
 * `requires` (the permission this particular call needs).
 */
export { defineModule, defineServerModule, packageVersion }

const os = implement(inventoryContract).$context<RequestContext>()

/** The wire shape: drizzle gives Date objects for timestamps, the contract promises ISO strings. */
function toAsset(row: typeof assets.$inferSelect): AssetModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId as AssetModel['workspaceId'],
    code: row.code,
    name: row.name,
    description: row.description,
    categoryId: row.categoryId,
    status: row.status,
    custodianUserId: row.custodianUserId,
    custodySince: row.custodySince?.toISOString() ?? null,
    serialNumber: row.serialNumber,
    location: row.location,
    purchasedOn: row.purchasedOn ?? null,
    purchasedFrom: row.purchasedFrom,
    priceMinor: row.priceMinor,
    currency: row.currency,
    warrantyUntil: row.warrantyUntil ?? null,
    photoFileId: row.photoFileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

/**
 * The next asset tag for a workspace. One narrow row per workspace and key, incremented under the
 * insert's conflict lock — two concurrent creates each read the value their own update returned, so
 * codes stay unique without a retry loop. `INV-0042`, because people say asset tags out loud.
 */
async function nextCode(
  tx: Parameters<Parameters<Kernel['database']['withWorkspace']>[1]>[0],
  workspaceId: string,
) {
  const [row] = await tx
    .insert(counters)
    .values({ workspaceId, key: 'asset_code', value: 1 })
    .onConflictDoUpdate({
      target: [counters.workspaceId, counters.key],
      set: { value: sql`${counters.value} + 1` },
    })
    .returning()
  return `INV-${String(row!.value).padStart(4, '0')}`
}

export function implement_(kernel: Kernel) {
  const scoped = os.use(workspaceScoped(MODULE_ID))

  const changed = (workspaceId: string, id: string, op: 'created' | 'updated' | 'deleted') =>
    kernel.realtime.change(workspaceId, { module: MODULE_ID, entity: 'asset', id, op })

  async function record(
    tx: Tx,
    input: { workspaceId: string },
    assetId: string,
    actorId: string | null | undefined,
    action: string,
    changes: { field: string; from: unknown; to: unknown }[] = [],
    data?: Record<string, unknown>,
  ) {
    await tx.insert(assetHistory).values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      assetId,
      actorId: actorId ?? null,
      action,
      changes,
      data: data ?? null,
    })
  }

  return os.router({
    assets: {
      list: scoped.assets.list.use(requires('inventory.asset.view')).handler(({ input }) =>
        kernel.database.withWorkspace(input.workspaceId, async (tx) => {
          const filters = [eq(assets.workspaceId, input.workspaceId)]
          if (input.q) {
            // A code is something somebody reads off a sticker; matching name, code and serial
            // loosely matters more than word-splitting here. Full-text arrives with the core indexer.
            filters.push(
              or(
                ilike(assets.name, `%${input.q}%`),
                ilike(assets.code, `%${input.q}%`),
                ilike(sql`coalesce(${assets.serialNumber}, '')`, `%${input.q}%`),
              )!,
            )
          }
          if (input.categoryId) filters.push(eq(assets.categoryId, input.categoryId))
          if (input.status) filters.push(eq(assets.status, input.status))

          const order =
            input.sort === 'name' ? assets.name : input.sort === 'code' ? assets.code : desc(assets.createdAt)

          const rows = await tx
            .select()
            .from(assets)
            .where(and(...filters))
            .orderBy(order)
            .limit(input.limit)
          return { items: rows.map(toAsset), nextCursor: null }
        }),
      ),

      get: scoped.assets.get.use(requires('inventory.asset.view')).handler(({ input }) =>
        kernel.database.withWorkspace(input.workspaceId, async (tx) => {
          const [row] = await tx
            .select()
            .from(assets)
            .where(and(eq(assets.workspaceId, input.workspaceId), eq(assets.id, input.assetId)))
          if (!row) throw KernError.notFound('Asset')
          return toAsset(row)
        }),
      ),

      create: scoped.assets.create
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const row = await kernel.database.withWorkspace(input.workspaceId, async (tx) => {
            const [r] = await tx
              .insert(assets)
              .values({
                id: uuidv7(),
                workspaceId: input.workspaceId,
                code: await nextCode(tx, input.workspaceId),
                name: input.name,
                description: input.description,
                categoryId: input.categoryId ?? null,
                serialNumber: input.serialNumber ?? null,
                location: input.location ?? null,
                purchasedFrom: input.purchasedFrom ?? null,
                purchasedOn: input.purchasedOn ?? null,
                warrantyUntil: input.warrantyUntil ?? null,
                priceMinor: input.priceMinor ?? null,
                currency: input.currency ?? null,
              })
              .returning()
            await record(tx, input, r!.id, context.principal.userId, 'created')
            return r!
          })

          // Both, every time. The event is for anything that reacts later; the realtime change is
          // what redraws a screen somebody is looking at now. A mutation that does neither leaves
          // the rest of the product believing the old answer.
          await kernel.emit(
            inventoryEvents.assetCreated,
            { assetId: row.id, workspaceId: input.workspaceId },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, row.id, 'created')

          return toAsset(row)
        }),

      update: scoped.assets.update
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const row = await kernel.database.withWorkspace(input.workspaceId, async (tx) => {
            const [prev] = await tx
              .select()
              .from(assets)
              .where(and(eq(assets.workspaceId, input.workspaceId), eq(assets.id, input.assetId)))
              .for('update')
            if (!prev) throw KernError.notFound('Asset')

            const patch = {
              name: input.name ?? prev.name,
              description: input.description ?? prev.description,
              categoryId: input.categoryId !== undefined ? (input.categoryId ?? null) : prev.categoryId,
              serialNumber:
                input.serialNumber !== undefined ? (input.serialNumber ?? null) : prev.serialNumber,
              location: input.location !== undefined ? (input.location ?? null) : prev.location,
              purchasedFrom:
                input.purchasedFrom !== undefined ? (input.purchasedFrom ?? null) : prev.purchasedFrom,
              purchasedOn: input.purchasedOn !== undefined ? (input.purchasedOn ?? null) : prev.purchasedOn,
              warrantyUntil:
                input.warrantyUntil !== undefined ? (input.warrantyUntil ?? null) : prev.warrantyUntil,
              priceMinor: input.priceMinor !== undefined ? (input.priceMinor ?? null) : prev.priceMinor,
              currency: input.currency !== undefined ? (input.currency ?? null) : prev.currency,
              updatedAt: new Date(),
            }

            const [r] = await tx.update(assets).set(patch).where(eq(assets.id, input.assetId)).returning()

            // Field-level diffs are the timeline — write only what actually moved.
            const fields = [
              'name',
              'description',
              'categoryId',
              'serialNumber',
              'location',
              'purchasedFrom',
              'purchasedOn',
              'warrantyUntil',
              'priceMinor',
              'currency',
            ] as const
            const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v) ?? null
            const changes = fields
              .filter((f) => iso(patch[f]) !== iso(prev[f]))
              .map((f) => ({ field: f, from: iso(prev[f]), to: iso(patch[f]) }))
            if (changes.length > 0)
              await record(tx, input, input.assetId, context.principal.userId, 'updated', changes)

            return r!
          })

          await kernel.emit(
            inventoryEvents.assetUpdated,
            { assetId: row.id, workspaceId: input.workspaceId },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, row.id, 'updated')
          return toAsset(row)
        }),

      archive: scoped.assets.archive
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const row = await kernel.database.withWorkspace(input.workspaceId, async (tx) => {
            const [r] = await tx
              .update(assets)
              .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
              .where(and(eq(assets.workspaceId, input.workspaceId), eq(assets.id, input.assetId)))
              .returning()
            if (!r) throw KernError.notFound('Asset')
            await record(
              tx,
              input,
              input.assetId,
              context.principal.userId,
              input.archived ? 'retired' : 'restored',
            )
            return r
          })

          await kernel.emit(
            inventoryEvents.assetArchived,
            { assetId: row.id, workspaceId: input.workspaceId },
            { workspaceId: input.workspaceId, actorId: context.principal.userId },
          )
          await changed(input.workspaceId, row.id, 'updated')
          return toAsset(row)
        }),
    },
  })
}
