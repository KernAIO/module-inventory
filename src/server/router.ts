import type { WorkspaceId } from '@kernhq/contracts'
import {
  defineModule,
  defineServerModule,
  type Kernel,
  packageVersion,
  type RequestContext,
  requires,
  type Tx,
  workspaceScoped,
} from '@kernhq/kernel'
import { implement } from '@orpc/server'
import { inventoryContract, inventoryEvents, MODULE_ID } from '../contract/index.js'
import { toAsset, type Written } from './services/assets.js'
import { inventoryServices } from './services/index.js'

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
   * Everything a write announces, once the transaction that wrote it has actually committed.
   *
   * Three things, and all three are after the commit on purpose: the core activity feed's copy of
   * the history row, the event for whatever reacts later, and the realtime change that redraws a
   * screen somebody is looking at now. A mutation that skips them leaves the product believing the
   * old answer; a mutation that fires them *inside* the transaction tells the rest of the instance
   * about a row a rollback then took away, which is worse — it cannot be retracted.
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
  }

  /** Every handler is this: a workspace-bound transaction, tagged with who is asking, and a service. */
  const run = <T>(context: RequestContext, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: context.principal.userId })

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

      create: scoped.assets.create
        .use(requires('inventory.asset.manage'))
        .handler(async ({ input, context }) => {
          const actorId = context.principal.userId
          // Module settings are read *before* the transaction opens. They come from core over the
          // broker, and awaiting that inside the transaction holds a pooled connection and the
          // counter row lock across a network call to another service.
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
          const written = await run(context, input.workspaceId, (tx) =>
            svc.assets.archive(tx, input.workspaceId, actorId, input.assetId, input.archived),
          )
          // This procedure is the restore path too, and it used to announce `archived` either way —
          // telling every subscriber that a restored item had just been retired, while the module's
          // own history row beside it said `restored`.
          const event = input.archived ? inventoryEvents.assetArchived : inventoryEvents.assetRestored
          await announce(input.workspaceId, written, event, 'updated', actorId)
          return toAsset(written.row)
        }),
    },
  })
}
