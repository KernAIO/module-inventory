import type { WorkspaceId } from '@kernhq/contracts'
import {
  defineModule,
  defineServerModule,
  type Kernel,
  packageVersion,
  type RequestContext,
  requires,
  requiresCapability,
  type Tx,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { inventoryContract, inventoryEvents, MODULE_ID } from '../contract/index.js'
import { type Disposed, toAsset, type Written } from './services/assets.js'
import { toAttachment } from './services/attachments.js'
import { toCategory } from './services/categories.js'
import { type CustodyWritten, toCustodyPeriod } from './services/custody.js'
import { toFieldDef } from './services/fields.js'
import { inventoryServices } from './services/index.js'
import { requireWorkspaceMember } from './services/members.js'
import { type RepairWritten, toRepair } from './services/repairs.js'

/**
 * oRPC router for `/api/inventory`.
 *
 * Deliberately thin: it opens the workspace-bound transaction and hands straight over to a service,
 * which is where the logic lives. Kept apart from `index.ts` so `module.test.ts` can walk it as data
 * without booting a kernel.
 *
 * Two middlewares on every procedure, and the test fails if either is missing: `workspaceScoped`
 * (a real membership, and the module switched on for that workspace) and `requires` (the permission
 * this particular call needs). A capability adds a third, between them.
 */
export { defineModule, defineServerModule, packageVersion }

const os = implement(inventoryContract).$context<RequestContext>()

export function inventoryRouter(kernel: Kernel) {
  const svc = inventoryServices(kernel)
  const scoped = os.use(workspaceScoped(MODULE_ID))
  /**
   * The capability gate, between the workspace gate and the permission check.
   *
   * That order is the whole point: a workspace with Inventory switched off is refused before
   * anything reveals which capabilities it would have had, and a workspace with `repairs` off
   * answers **404** rather than 403 — the surface is not part of its API, so it answers like
   * anything else that is not there. `module.test.ts` checks the identity and the position of all
   * three, because a missing one is invisible to `tsc`.
   */
  const cap = (id: string) => requiresCapability(MODULE_ID, id)

  /**
   * Everything a write announces, once the transaction that wrote it has actually committed.
   *
   * Four things, and all four are after the commit on purpose: the core activity feed's copy of the
   * history row, the event for whatever reacts later, the realtime change that redraws a screen
   * somebody is looking at now, and the search index. A mutation that skips them leaves the product
   * believing the old answer; a mutation that fires them *inside* the transaction tells the rest of
   * the instance about a row a rollback then took away, which is worse — it cannot be retracted.
   *
   * `reindex` needs no direction argument: it re-reads the row, and an archived one comes back as
   * `null`, which is what takes it out of the index. So archive and restore are the same call here,
   * exactly as they are the same procedure.
   */
  const announce = async (
    workspaceId: WorkspaceId,
    written: Written,
    event: (typeof inventoryEvents)[keyof typeof inventoryEvents],
    op: 'created' | 'updated' | 'deleted',
    actorId: string | null,
  ) => {
    const assetId = written.row.id
    if (written.activity) await svc.notify.activity(written.activity)
    await kernel.emit(event, { assetId, workspaceId }, { workspaceId, actorId: actorId ?? undefined })
    await svc.notify.change(workspaceId, 'asset', assetId, op)
    await svc.search.reindex(workspaceId, assetId)
  }

  /**
   * The same three, plus the one interruption this module makes.
   *
   * Custody is announced as a change to the **asset** rather than to a custody entity, and that is
   * deliberate: `src/client/query.ts` keys the timeline and the period list under the asset's own
   * prefix, so one `entity: 'asset'` invalidates the row, the list, the panel and both of its tabs.
   * A second entity name would need a second subscription for no gain.
   */
  const announceCustody = async (
    workspaceId: WorkspaceId,
    written: CustodyWritten,
    actorId: string | null,
  ) => {
    const assetId = written.asset.id
    await svc.notify.activity(written.activity)
    await kernel.emit(
      inventoryEvents.custodyChanged,
      {
        assetId,
        workspaceId,
        userId: written.userId,
        previousUserId: written.previousUserId,
      },
      { workspaceId, actorId: actorId ?? undefined },
    )
    await svc.notify.change(workspaceId, 'asset', assetId, 'updated')
    // The document carries `custodianUserId` and `status`, and both just moved.
    await svc.search.reindex(workspaceId, assetId)
    if (written.notifyUserId)
      await svc.notify.notify({
        workspaceId,
        userIds: [written.notifyUserId],
        type: 'inventory.custody.assigned',
        // The tag first, because that is what is printed on the sticker the person is looking for.
        title: `${written.asset.code} was handed to you`,
        body: written.asset.name,
        object: { module: MODULE_ID, type: 'asset', id: assetId },
        url: `/inventory?asset=${assetId}`,
        groupKey: assetId,
        actorId,
        exclude: [actorId],
      })
  }

  /**
   * A disposition's four, with the one thing `announce` cannot carry: which disposition it was.
   *
   * The history row is always written here (a disposition that changed nothing is refused rather
   * than recorded), so `activity` is never null. The event names the disposition so a subscriber
   * to `disposed` can tell a loss from a write-off without re-reading the row; `reinstated` names
   * the one it came back *from*, for the same reason.
   */
  const announceDisposition = async (
    workspaceId: WorkspaceId,
    written: Disposed,
    event: typeof inventoryEvents.assetDisposed | typeof inventoryEvents.assetReinstated,
    actorId: string | null,
  ) => {
    const assetId = written.row.id
    await svc.notify.activity(written.activity)
    await kernel.emit(
      event,
      { assetId, workspaceId, disposition: written.disposition },
      { workspaceId, actorId: actorId ?? undefined },
    )
    await svc.notify.change(workspaceId, 'asset', assetId, 'updated')
    // The document carries `status`, which just moved.
    await svc.search.reindex(workspaceId, assetId)
  }

  /**
   * A repair's three, and the second entity it has to invalidate.
   *
   * `entity: 'asset'` refreshes the panel, the row and the list — the query keys hang the asset's
   * repairs one segment under the asset's own key for exactly that reason. The workspace-wide
   * repair list (the *what is away* card) cannot hang there, because it belongs to no single asset,
   * so it is keyed under `['inventory', 'repair', …]` and needs its own change. Two changes for one
   * write is the honest cost of one entity being asked about at two scopes.
   */
  const announceRepair = async (
    workspaceId: WorkspaceId,
    written: RepairWritten,
    event: typeof inventoryEvents.repairOpened | typeof inventoryEvents.repairCompleted | null,
    op: 'created' | 'updated',
    actorId: string | null,
  ) => {
    if (written.activity) await svc.notify.activity(written.activity)
    if (event)
      await kernel.emit(
        event,
        { assetId: written.asset.id, repairId: written.repair.id, workspaceId },
        { workspaceId, actorId: actorId ?? undefined },
      )
    await svc.notify.change(workspaceId, 'asset', written.asset.id, 'updated')
    await svc.notify.change(workspaceId, 'repair', written.repair.id, op)
    // Sending an item away and logging it back both move `assets.status`, which the document
    // carries. An edit does not, and reindexing anyway is one cheap call rather than a fourth
    // branch that has to stay right.
    await svc.search.reindex(workspaceId, written.asset.id)
  }

  /** Every handler is this: a workspace-bound transaction, tagged with who is asking, and a service. */
  const run = <T>(context: RequestContext, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: context.principal.userId })

  /**
   * A file id in a request is a claim about somebody else's row, and it is checked before it is
   * stored.
   *
   * `attachments.add` has always asked core whose file an id belongs to; `assets.create` and
   * `assets.update` did not, so `photoFileId` was the one file id this module accepted on trust —
   * and a member of one workspace could point an asset at another workspace's file and read its
   * name and size back out through the panel. The module boundary is no help: core answers this
   * module as a service, so the id is the only thing standing between the two workspaces.
   *
   * The same check, deliberately, rather than a second one that might drift: `describe` is what
   * refuses a foreign file and an upload that never finished, and it is called **before** the
   * transaction opens for the reason its own docblock gives — a broker round trip while holding a
   * pooled connection starves the pool and fails the write whenever core is briefly away.
   *
   * `undefined` means the request never mentioned a photo and `null` means "take it off", and
   * neither is a file to check.
   */
  const checkPhoto = async (workspaceId: WorkspaceId, photoFileId?: string | null): Promise<void> => {
    if (typeof photoFileId === 'string') await svc.attachments.describe(workspaceId, [photoFileId])
  }

  /**
   * Does this workspace record repairs? Asked by the procedures that are **not** behind the
   * capability but whose answer depends on it.
   *
   * `under_repair` is a status the `repairs` capability owns, and custody and archiving both decide
   * it — custody because `deriveStatus` reads the open repair, archiving because it refuses an item
   * that is away. With the capability off both of those were reading a fact the workspace can no
   * longer act on: `repairs.complete` answers 404, so an asset went `under_repair` and stayed there,
   * behind an archive that refused it and told the person to complete a repair they cannot reach.
   *
   * Read **before** the transaction opens, like every other settings lookup in this module and for
   * the reason `AssetService.codeFormat` gives — `kernel.capabilities` resolves module settings over
   * the broker, and awaiting one while holding a pooled connection starves the pool and fails the
   * write whenever core is briefly away. The result is cached by the kernel for fifteen seconds, so
   * this is not a round trip per request.
   */
  const recordsRepairs = async (workspaceId: WorkspaceId): Promise<boolean> =>
    (await kernel.capabilities(workspaceId, MODULE_ID)).has('repairs')

  return os.router({
    assets: {
      list: scoped.assets.list
        .use(requires('inventory.asset.view'))
        .handler(({ input, context }) => run(context, input.workspaceId, (tx) => svc.assets.list(tx, input))),

      get: scoped.assets.get
        .use(requires('inventory.asset.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, async (tx) =>
            toAsset(await svc.assets.get(tx, input.workspaceId, input.assetId)),
          ),
        ),

      history: scoped.assets.history
        .use(requires('inventory.asset.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) =>
            svc.assets.history(tx, input.workspaceId, input.assetId, input),
          ),
        ),

      create: scoped.assets.create
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          // Module settings are read *before* the transaction opens. They come from core over the
          // broker, and awaiting that inside the transaction holds a pooled connection and the
          // counter row lock across a network call to another service.
          await checkPhoto(input.workspaceId, input.photoFileId)
          const format = await svc.assets.codeFormat(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.assets.create(tx, input.workspaceId, actorId, input, format),
          )
          await announce(input.workspaceId, written, inventoryEvents.assetCreated, 'created', actorId)
          return toAsset(written.row)
        }),

      update: scoped.assets.update
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          await checkPhoto(input.workspaceId, input.photoFileId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.assets.update(tx, input.workspaceId, actorId, input.assetId, input),
          )
          await announce(input.workspaceId, written, inventoryEvents.assetUpdated, 'updated', actorId)
          return toAsset(written.row)
        }),

      archive: scoped.assets.archive
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const repairsOn = await recordsRepairs(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.assets.archive(tx, input.workspaceId, actorId, input.assetId, input.archived, repairsOn),
          )
          // This procedure is the restore path too, and it used to announce `archived` either way —
          // telling every subscriber that a restored item had just been retired, while the module's
          // own history row beside it said `restored`.
          const event = input.archived ? inventoryEvents.assetArchived : inventoryEvents.assetRestored
          await announce(input.workspaceId, written, event, 'updated', actorId)
          return toAsset(written.row)
        }),

      /**
       * The three disposition verbs. Each reads the `repairs` switch first, for the reason
       * `archive` does — `retire` refuses an item that is away, and a refusal that names a
       * procedure answering 404 is a dead end — and `deriveStatus` needs the same fact either way.
       *
       * `announceDisposition` below carries which disposition it was in the event, so a subscriber
       * knows whether to open an insurance claim or close a ledger line without re-reading the row.
       */
      markLost: scoped.assets.markLost
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const repairsOn = await recordsRepairs(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.assets.markLost(tx, input.workspaceId, actorId, input.assetId, input.note ?? null, repairsOn),
          )
          await announceDisposition(input.workspaceId, written, inventoryEvents.assetDisposed, actorId)
          return toAsset(written.row)
        }),

      retire: scoped.assets.retire
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const repairsOn = await recordsRepairs(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.assets.retire(tx, input.workspaceId, actorId, input.assetId, input.note ?? null, repairsOn),
          )
          await announceDisposition(input.workspaceId, written, inventoryEvents.assetDisposed, actorId)
          return toAsset(written.row)
        }),

      reinstate: scoped.assets.reinstate
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const repairsOn = await recordsRepairs(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.assets.reinstate(
              tx,
              input.workspaceId,
              actorId,
              input.assetId,
              input.note ?? null,
              repairsOn,
            ),
          )
          await announceDisposition(input.workspaceId, written, inventoryEvents.assetReinstated, actorId)
          return toAsset(written.row)
        }),
    },

    /**
     * A workspace's own fields, gated exactly as categories are and for the same reasons: reading
     * rides `asset.view` because the form and the panel need the definitions to render a value,
     * and every write is `field.manage`. No kernel event and one realtime change per row that
     * moved — the same two decisions `categories` makes, argued there.
     */
    fields: {
      list: scoped.fields.list
        .use(requires('inventory.asset.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, async (tx) =>
            (await svc.fields.list(tx, input.workspaceId, input.archived)).map(toFieldDef),
          ),
        ),

      create: scoped.fields.create
        .use(requires('inventory.field.manage'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, (tx) =>
            svc.fields.create(tx, input.workspaceId, input),
          )
          await svc.notify.change(input.workspaceId, 'field', row.id, 'created')
          return toFieldDef(row)
        }),

      update: scoped.fields.update
        .use(requires('inventory.field.manage'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, (tx) =>
            svc.fields.update(tx, input.workspaceId, input.fieldId, input),
          )
          await svc.notify.change(input.workspaceId, 'field', row.id, 'updated')
          return toFieldDef(row)
        }),

      archive: scoped.fields.archive
        .use(requires('inventory.field.manage'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, (tx) =>
            svc.fields.archive(tx, input.workspaceId, input.fieldId, input.archived),
          )
          await svc.notify.change(input.workspaceId, 'field', row.id, 'updated')
          return toFieldDef(row)
        }),

      reorder: scoped.fields.reorder
        .use(requires('inventory.field.manage'))
        .handler(async ({ input, context }) => {
          const { rows, moved } = await run(context, input.workspaceId, (tx) =>
            svc.fields.reorder(tx, input.workspaceId, input.fieldIds),
          )
          for (const id of moved) await svc.notify.change(input.workspaceId, 'field', id, 'updated')
          return rows.map(toFieldDef)
        }),
    },

    custody: {
      /**
       * Reads ride `inventory.asset.view`, writes take `inventory.custody.manage`.
       *
       * The split is argued where the keys are declared: `custodianUserId` is already a field of
       * `Asset` under `asset.view`, so gating the timeline behind a second key would refuse the
       * history while the row above it named the same person.
       */
      history: scoped.custody.history.use(requires('inventory.asset.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, async (tx) => {
          // 404 first: a timeline for an asset in another workspace must answer "not yours"
          // rather than an empty list, which reads as "nothing has ever happened to it".
          await svc.assets.get(tx, input.workspaceId, input.assetId)
          const rows = await svc.custody.history(tx, input.workspaceId, input.assetId, input.limit)
          return rows.map(toCustodyPeriod)
        }),
      ),

      /**
       * What one person holds, answered by the asset list with the custodian filter fixed.
       *
       * One query path rather than two: `assets.list` already has the filter, the index and the
       * keyset cursor, and a second query answering the same question is a second query to keep in
       * step. Archived rows are out, because an item somebody still holds cannot be archived at
       * all — `assets.archive` refuses it — so an archived row here would be one this module has
       * already made impossible.
       */
      byUser: scoped.custody.byUser.use(requires('inventory.asset.view')).handler(({ input, context }) =>
        run(context, input.workspaceId, (tx) =>
          svc.assets.list(tx, {
            workspaceId: input.workspaceId,
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            custodianUserId: input.userId,
            archived: false,
            sort: 'recent',
          }),
        ),
      ),

      assign: scoped.custody.assign
        .use(requires('inventory.custody.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          // Core is asked whether this person is really a member **before** the transaction opens,
          // for the reason `AssetService.codeFormat` documents — and because writing the row first
          // and checking afterwards would mean rolling back a handover somebody has already been
          // notified about. `requireWorkspaceMember` argues what it refuses and why it refuses
          // rather than swallowing a failure.
          await requireWorkspaceMember(kernel, input.workspaceId, input.userId)
          const repairsOn = await recordsRepairs(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.custody.assign(
              tx,
              input.workspaceId,
              actorId,
              input.assetId,
              input.userId,
              input.note ?? null,
              repairsOn,
            ),
          )
          await announceCustody(input.workspaceId, written, actorId)
          return { asset: toAsset(written.asset), period: written.period && toCustodyPeriod(written.period) }
        }),

      transfer: scoped.custody.transfer
        .use(requires('inventory.custody.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          // The same check as `assign`, for the same reason: this is the other verb that writes a
          // person into `custody_periods.user_id` and then sends them a notification.
          await requireWorkspaceMember(kernel, input.workspaceId, input.userId)
          const repairsOn = await recordsRepairs(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.custody.transfer(
              tx,
              input.workspaceId,
              actorId,
              input.assetId,
              input.userId,
              input.note ?? null,
              repairsOn,
            ),
          )
          await announceCustody(input.workspaceId, written, actorId)
          return { asset: toAsset(written.asset), period: written.period && toCustodyPeriod(written.period) }
        }),

      return: scoped.custody.return
        .use(requires('inventory.custody.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const repairsOn = await recordsRepairs(input.workspaceId)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.custody.return(tx, input.workspaceId, actorId, input.assetId, input.note ?? null, repairsOn),
          )
          await announceCustody(input.workspaceId, written, actorId)
          return { asset: toAsset(written.asset), period: null }
        }),
    },

    /**
     * A workspace's own filing, and the one entity name every change here carries.
     *
     * **`update` and `archive` used to announce a second change as `entity: 'asset'` carrying the
     * category's id.** No asset has that id, so the change described a row that does not exist: a
     * subscriber that acts on `{entity, id}` — patching a cached row, logging what moved, deciding
     * what to refetch — is acting on a lie, and the client's own
     * `invalidateQueries(['inventory', 'asset', id])` matched nothing, because the segment after
     * the entity in this module's keys is the *workspace*. What it did was work by accident: the
     * blunter `['inventory', 'asset']` invalidation fires on any asset change whatever its id.
     *
     * It is not needed either, and that is why it is gone rather than corrected. A category's name
     * is resolved on the client from the categories query itself — `AssetsPage` and
     * `AssetDetailPanel` both build their `id → name` map from `inventoryKeys.categories(ws, true)`
     * — so refreshing that one query is what makes every asset row on screen say the new name. The
     * asset rows themselves did not change: archiving a category leaves `assets.category_id`
     * exactly where it was, which is the whole reason categories archive rather than delete.
     */
    categories: {
      /**
       * Reading rides `inventory.asset.view` because the picker on the asset form needs it — a
       * `category.manage` on the read would leave everybody who may edit an asset unable to see
       * what to file it under.
       */
      list: scoped.categories.list
        .use(requires('inventory.asset.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, (tx) => svc.categories.list(tx, input.workspaceId, input.archived)),
        ),

      create: scoped.categories.create
        .use(requires('inventory.category.manage'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, (tx) =>
            svc.categories.create(tx, input.workspaceId, input.name),
          )
          // No event: nothing outside this module has an opinion about a workspace's own filing.
          // The realtime change is what the settings page, the filter and the form picker need.
          await svc.notify.change(input.workspaceId, 'category', row.id, 'created')
          return toCategory(row)
        }),

      update: scoped.categories.update
        .use(requires('inventory.category.manage'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, (tx) =>
            svc.categories.update(tx, input.workspaceId, input.categoryId, input),
          )
          // One change, naming the row that actually moved. Every screen that prints a category's
          // name resolves it from the categories query, so this is what re-renders the asset list,
          // the filter and the picker as well as the settings page.
          await svc.notify.change(input.workspaceId, 'category', row.id, 'updated')
          return toCategory(row)
        }),

      archive: scoped.categories.archive
        .use(requires('inventory.category.manage'))
        .handler(async ({ input, context }) => {
          const row = await run(context, input.workspaceId, (tx) =>
            svc.categories.archive(tx, input.workspaceId, input.categoryId, input.archived),
          )
          // Archiving takes the category out of every picker and every filter and leaves each asset
          // still filed under it — so the row that changed is the category, and only the category.
          await svc.notify.change(input.workspaceId, 'category', row.id, 'updated')
          return toCategory(row)
        }),

      /**
       * The sequence, rewritten from the ids somebody dragged it into.
       *
       * **One change per row that actually moved, and no kernel event** — the same two decisions
       * the three procedures above make, for the same two reasons. Moving one category down a list
       * of ten renumbers the handful between where it was and where it went, and each of those rows
       * really did change; announcing the ones that did not would tell every open screen in the
       * workspace about a write nobody performed. And nothing outside this module has an opinion
       * about the order a workspace keeps its own filing in, so there is nothing to emit an event
       * to: `inventoryEvents` stays the set of things another module could plausibly react to.
       *
       * After the commit, like everything else here. A change announced from inside the transaction
       * describes rows a rollback then takes away, and it cannot be retracted.
       */
      reorder: scoped.categories.reorder
        .use(requires('inventory.category.manage'))
        .handler(async ({ input, context }) => {
          const { rows, moved } = await run(context, input.workspaceId, (tx) =>
            svc.categories.reorder(tx, input.workspaceId, input.categoryIds),
          )
          for (const id of moved) await svc.notify.change(input.workspaceId, 'category', id, 'updated')
          return rows.map(toCategory)
        }),
    },

    /**
     * Repairs, behind the `repairs` capability.
     *
     * Every one of these carries three middlewares in this order — `workspaceScoped`, `cap`,
     * `requires` — so a workspace that does not record repairs gets 404 from all four, which is
     * what makes the hidden tab and the API agree.
     */
    repairs: {
      list: scoped.repairs.list
        .use(cap('repairs'))
        .use(requires('inventory.asset.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, async (tx) => {
            // 404 first when the question is about one asset: a repair list for an asset in another
            // workspace must answer "not yours" rather than an empty list, which reads as "it has
            // never been repaired". The same reasoning `custody.history` gives.
            if (input.assetId) await svc.assets.get(tx, input.workspaceId, input.assetId)
            return svc.repairs.list(tx, input.workspaceId, input)
          }),
        ),

      create: scoped.repairs.create
        .use(cap('repairs'))
        .use(requires('inventory.repair.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const written = await run(context, input.workspaceId, (tx) =>
            svc.repairs.create(tx, input.workspaceId, actorId, input.assetId, input),
          )
          await announceRepair(input.workspaceId, written, inventoryEvents.repairOpened, 'created', actorId)
          return { repair: toRepair(written.repair), asset: toAsset(written.asset) }
        }),

      update: scoped.repairs.update
        .use(cap('repairs'))
        .use(requires('inventory.repair.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const written = await run(context, input.workspaceId, (tx) =>
            svc.repairs.update(tx, input.workspaceId, input.repairId, input),
          )
          // No event: correcting a vendor or a cost is not a fact anything outside this module
          // reacts to. The realtime change is what the panel and the card need.
          await announceRepair(input.workspaceId, written, null, 'updated', actorId)
          return { repair: toRepair(written.repair), asset: toAsset(written.asset) }
        }),

      complete: scoped.repairs.complete
        .use(cap('repairs'))
        .use(requires('inventory.repair.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const written = await run(context, input.workspaceId, (tx) =>
            svc.repairs.complete(tx, input.workspaceId, actorId, input.repairId, input),
          )
          await announceRepair(
            input.workspaceId,
            written,
            inventoryEvents.repairCompleted,
            'updated',
            actorId,
          )
          return { repair: toRepair(written.repair), asset: toAsset(written.asset) }
        }),
    },

    /**
     * Files, behind the `attachments` capability.
     *
     * Writing takes `inventory.asset.manage` rather than a key of its own: filing a receipt against
     * an asset is editing the asset's record, and a workspace that lets somebody correct a serial
     * number lets them attach the warranty card it came with.
     */
    attachments: {
      list: scoped.attachments.list
        .use(cap('attachments'))
        .use(requires('inventory.asset.view'))
        .handler(({ input, context }) =>
          run(context, input.workspaceId, async (tx) => {
            await svc.assets.get(tx, input.workspaceId, input.assetId)
            return svc.attachments.list(tx, input.workspaceId, input.assetId)
          }),
        ),

      add: scoped.attachments.add
        .use(cap('attachments'))
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          // Core is asked what these files are **before** the transaction opens. It is a call over
          // the broker, and awaiting one while holding a pooled connection is the failure
          // `AssetService.codeFormat` documents — the pool starves under concurrent writes, and an
          // attach fails outright whenever core is briefly away.
          const files = await svc.attachments.describe(input.workspaceId, input.fileIds)
          const written = await run(context, input.workspaceId, (tx) =>
            svc.attachments.add(tx, input.workspaceId, actorId, input.assetId, input.repairId ?? null, files),
          )
          for (const activity of written.activities) await svc.notify.activity(activity)
          // No event and no notification: a filed receipt is not something outside this module
          // reacts to, and it is certainly not worth interrupting anybody about.
          if (written.rows.length)
            await svc.notify.change(input.workspaceId, 'asset', input.assetId, 'updated')
          return written.rows.map(toAttachment)
        }),

      remove: scoped.attachments.remove
        .use(cap('attachments'))
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          const removed = await run(context, input.workspaceId, (tx) =>
            svc.attachments.remove(tx, input.workspaceId, actorId, input.attachmentId),
          )
          await svc.notify.activity(removed.activity)
          await svc.notify.change(input.workspaceId, 'asset', removed.row.assetId, 'updated')
          return { id: removed.row.id }
        }),
    },

    stats: {
      /**
       * Not behind a capability: it counts assets, which is `core`.
       *
       * The capability it does read is `repairs`, and it reads it here rather than as middleware —
       * `outForRepair` comes back **null** for a workspace that does not track repairs, where 404
       * would take the whole count line and the dashboard card away because a *different* feature
       * is off. Read before the transaction opens, like every other settings lookup in this module.
       */
      summary: scoped.stats.summary
        .use(requires('inventory.asset.view'))
        .handler(async ({ input, context }) => {
          const on = await kernel.capabilities(input.workspaceId, MODULE_ID)
          return run(context, input.workspaceId, (tx) =>
            svc.stats.summary(tx, input.workspaceId, on.has('repairs')),
          )
        }),
    },
  })
}
