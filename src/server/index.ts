import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { core, Principal } from '@kernhq/contracts'
import { WorkspaceId } from '@kernhq/contracts'
import { KernError, type Kernel } from '@kernhq/kernel'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  Asset,
  InventorySettings,
  inventoryCapabilities,
  inventoryContract,
  inventoryEvents,
  inventoryNotificationTypes,
  inventoryPermissions,
  MODULE_ID,
} from '../contract/index.js'
import { inventoryJobs } from './jobs.js'
import { defineModule, defineServerModule, inventoryRouter, packageVersion } from './router.js'
import { assets, categories, schema, workspaces } from './schema.js'
import { toAsset } from './services/assets.js'
import { inventoryServices } from './services/index.js'
import { ASSET_ICON, assetUrl } from './services/search.js'

/**
 * The categories a workspace starts with.
 *
 * Five, because an empty picker on the asset form is a question a new workspace cannot answer yet —
 * "what do you file a laptop under" has an obvious answer and asking it costs somebody a trip to a
 * settings page before they can add their first asset. Ordered rather than alphabetical: this is the
 * order somebody scanning a list expects, and every one of them is renamable, archivable and
 * ignorable.
 */
const DEFAULT_CATEGORIES = ['Laptops', 'Phones', 'Monitors', 'Furniture', 'Vehicles'] as const

/**
 * The `procedures` below are this module's service-to-service surface, reachable only over
 * `kernel.call`. They deliberately run with elevated access — no workspace membership is checked,
 * because the caller is another service and has none — so they must never be callable by an end
 * user: anything a person does goes through the oRPC router and its permission middleware.
 *
 * Copied deliberately from `module-tracker`, down to the shape of the check, so that the one line
 * standing between "an internal read" and "a permission-free read of any workspace's register"
 * looks the same in every module somebody audits.
 */
function requireService(principal: Principal): void {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

/** HR's statuses that mean somebody is on their way out. Their own enum; read, never guessed. */
const LEAVING_STATUSES = new Set(['offboarding', 'terminated'])

export const inventoryModule = defineServerModule({
  definition: defineModule({
    id: MODULE_ID,
    name: 'Inventory',
    version: packageVersion(import.meta.url),
    description:
      'The asset register: what the company owns, item by item — tags, serial numbers, purchase and warranty details',
    icon: 'briefcase',
    permissions: inventoryPermissions,
    capabilities: inventoryCapabilities,
    events: inventoryEvents,
    notificationTypes: inventoryNotificationTypes,
    settings: InventorySettings,
    /**
     * `inventory:asset:<id>` is a thing the rest of the product may point at.
     *
     * This came *off* the manifest in 0.2.0 and is back now, and the difference is the two handlers
     * under it: `resolvers` turns the reference into a title, a URL and an icon, and `search` puts
     * the row where somebody can find it in the first place. A declared type with neither renders a
     * link to nothing, which reads to a person as a broken product rather than as a feature that
     * has not shipped — the same lie as a permission nothing checks.
     *
     * `channelable: false`, unlike a tracker issue: a channel per laptop is not a thing anybody
     * wants, and the conversation about an asset belongs wherever the work does.
     */
    objectTypes: [{ type: 'asset', label: 'Asset', icon: ASSET_ICON, channelable: false }],
  }),
  /** Attached so the developer panel can check the router against what was promised. */
  contract: inventoryContract,
  schema,
  migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  router: inventoryRouter,

  jobs: inventoryJobs(),

  /**
   * `inventory:asset:<id>` rendered wherever it is mentioned — a chat message, a tracker issue, a
   * notification.
   *
   * The permission is checked **once for the batch**, not per id: `inventory.asset.view` is a
   * workspace permission and every asset in a workspace has the same audience, so there is nothing
   * per-row to decide. Somebody without it gets nulls, which the caller renders as plain text
   * rather than as a link to a title they were not entitled to read — a resolver is a read like any
   * other, and the fact that it is called by another module does not make it exempt.
   */
  resolvers: [
    {
      type: 'asset',
      resolve: async (workspaceId, ids, principal, kernel) => {
        const may = await kernel.authz
          .can(principal, 'inventory.asset.view', { kind: 'workspace', workspaceId })
          .catch(() => false)
        if (!may) return ids.map(() => null)
        return kernel.database.withWorkspace(workspaceId, async (tx) => {
          const rows = await tx
            .select({
              id: assets.id,
              code: assets.code,
              name: assets.name,
              status: assets.status,
              archivedAt: assets.archivedAt,
            })
            .from(assets)
            .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids)))
          const byId = new Map(rows.map((row) => [row.id, row]))
          return ids.map((id) => {
            const row = byId.get(id)
            if (!row) return null
            return {
              id,
              // The tag first, because that is what is printed on the sticker somebody is holding.
              title: `${row.code} ${row.name}`,
              url: assetUrl(id),
              icon: ASSET_ICON,
              /**
               * An archived asset still resolves — a link written last year must not turn into
               * nothing — and says so, where the search index drops it. A reference is a fact about
               * the past; a search hit is an offer to go somewhere now.
               *
               * The value is the module's own status vocabulary, not a translated label, and
               * `archived` is lowercase for the same reason `in_stock` is: a resolver runs in a
               * service with no locale to render into, so it hands over the machine value and the
               * caller decides. Every module's resolver does this today — `module-tracker` returns
               * a raw `statusId`. Translating it needs the platform to give a resolver the reader's
               * locale, which it does not, and inventing an English sentence here would look
               * finished while being wrong in four of the five languages this module ships.
               */
              subtitle: row.archivedAt ? 'archived' : row.status,
            }
          })
        })
      },
    },
  ],

  /**
   * The register in the workspace-wide search index, so an asset tag read off a sticker finds the
   * item from the command palette.
   *
   * Both halves are `SearchService`'s, so the document a mutation writes and the document a full
   * reindex writes cannot drift: `load` answers `null` for an archived or missing row, which is what
   * takes it back out, and `scan` pages by keyset for `core.search.reindex`.
   */
  search: [
    {
      types: ['asset'],
      load: (workspaceId, id, kernel): Promise<core.SearchDocument | null> =>
        inventoryServices(kernel).search.load(workspaceId, id),
      scan: (workspaceId, kernel) => inventoryServices(kernel).search.scan(workspaceId),
    },
  ],

  /** Answers other modules and services may ask, without reaching into `mod_inventory`. */
  procedures: {
    /**
     * One asset, for whatever holds an id and needs to say what it is — an automation, a report, a
     * module that recorded an `ObjectRef` and now has to act on it.
     */
    'asset.byId': {
      input: z.object({ workspaceId: WorkspaceId, assetId: z.uuid() }),
      output: Asset,
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, async (tx) =>
          toAsset(await inventoryServices(kernel).assets.get(tx, input.workspaceId, input.assetId)),
        )
      },
    },
    /**
     * What one person is holding — the offboarding question, asked from outside.
     *
     * This module answers it for itself in the subscription below; the procedure exists because it
     * is the question *other* modules ask about a person, and the alternative is each of them
     * learning the shape of `mod_inventory.assets`. Answered through `AssetService.list` with the
     * custodian filter fixed, which is the same one query path `custody.byUser` uses rather than a
     * second one to keep in step.
     */
    'assets.byCustodian': {
      input: z.object({
        workspaceId: WorkspaceId,
        userId: z.uuid(),
        limit: z.number().int().min(1).max(200).default(100),
        cursor: z.string().max(500).optional(),
      }),
      output: z.object({ items: z.array(Asset), nextCursor: z.string().nullable() }),
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        return kernel.database.withWorkspace(input.workspaceId, (tx) =>
          inventoryServices(kernel).assets.list(tx, {
            workspaceId: input.workspaceId,
            limit: input.limit,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            custodianUserId: input.userId,
            archived: false,
            sort: 'recent',
          }),
        )
      },
    },
  },

  subscriptions: {
    /**
     * Register the workspace so the sweeps can find it.
     *
     * Both halves are needed and neither is redundant: `onWorkspaceEnabled` covers somebody
     * switching the module on for an existing workspace, and this covers a workspace created while
     * the module is already on by default. A workspace registered twice is one row either way.
     */
    'core.workspace.created': async (event, kernel) => {
      const { workspaceId } = event.payload as { workspaceId: string }
      await registerWorkspace(kernel, workspaceId)
    },

    /**
     * A member removed from the workspace does **not** silently vanish from the register.
     *
     * The obvious implementation — clear `custodian_user_id` for everything they held — is the one
     * this module refuses to write, and the reason is the same one `OffboardingService` gives:
     * custody is an effective-dated record of who was answerable for what, and an item does not
     * come back because an account was closed. Clearing the column would say the laptop is in stock
     * while it is in somebody's bag, and it would do it *without a custody period closing*, so the
     * timeline would show a handover that never ended and a return that never happened. `assets
     * .archive` already refuses to archive a held item for exactly this reason.
     *
     * So: nothing moves, and the people who can take the item back are told there is something to
     * collect. The custodian field keeps naming somebody who is no longer a member, and every
     * screen in this module already renders an unresolvable id as "a former member" rather than as
     * a uuid — which is the honest thing for it to say.
     */
    'core.member.removed': async (event, kernel) => {
      const { workspaceId, userId } = event.payload as { workspaceId: string; userId: string }
      await inventoryServices(kernel).offboarding.raise(workspaceId, userId, 'removed')
    },

    /**
     * HR says somebody is on their way out.
     *
     * **Inert without HR, in three independent ways**, because this module installs, boots and works
     * in a workspace that has never had HR and there is no `dependsOn: ['hr']` on the manifest:
     *
     * 1. the event only exists if HR is running — a subscription to a pattern nothing publishes is
     *    a subscription that never fires;
     * 2. `OffboardingService.raise` asks whether *Inventory* is switched on for that workspace
     *    before it does anything, because an event bus is instance-wide and one workspace having HR
     *    says nothing about another;
     * 3. the one thing it needs from HR — the account behind a `personId` — is a `kernel.call`, and
     *    a call to a procedure nothing hosts throws, which is caught here and logged as nothing to
     *    do. A module never imports another module.
     *
     * `offboarding` matters more than `terminated`: somebody in their notice period is still at
     * their desk, which is when a list of things to collect is worth having. `terminated` is the
     * backstop for a workspace that never uses the intermediate status.
     */
    'hr.person.status_changed': async (event, kernel) => {
      const payload = event.payload as { workspaceId: string; personId: string; to: string }
      if (!LEAVING_STATUSES.has(payload.to)) return
      const person = await kernel
        .call<{ userId: string | null } | null>('hr.person.get', {
          workspaceId: payload.workspaceId,
          personId: payload.personId,
        })
        .catch((err: unknown) => {
          /**
           * `UNAVAILABLE` is what the broker answers for a procedure nothing hosts, which is the
           * ordinary state of an instance without HR and not worth a line in a log. Anything else
           * is HR being *present and failing*, and swallowing the two the same way would mean the
           * one case somebody should fix looks exactly like the case they should ignore.
           */
          if ((err as { code?: string }).code !== 'UNAVAILABLE')
            kernel.log.warn(
              { err: err instanceof Error ? err.message : String(err), module: MODULE_ID },
              'inventory: could not ask People who is behind a person leaving',
            )
          return null
        })
      // No account: `user_id` is legitimately null for somebody who never had a Kern account, and
      // for somebody core has already removed — that path is the subscription above.
      if (!person?.userId) return
      await inventoryServices(kernel).offboarding.raise(payload.workspaceId, person.userId, 'leaving')
    },
  },

  /**
   * A workspace that switches Inventory on gets a filing system and a place in the scheduler.
   *
   * Idempotent, because it runs again every time somebody switches the module off and back on.
   * Neither half may double up:
   *
   * - the registry row is an `on conflict do nothing` on its own primary key;
   * - the categories are seeded **only into a workspace that has none at all**, archived ones
   *   included. Keying on the names instead would re-create "Laptops" for a workspace that had
   *   renamed it to "Notebooks" — the second toggle would quietly hand somebody a duplicate of
   *   their own category under the name they had rejected.
   */
  onWorkspaceEnabled: async (workspaceId, kernel) => {
    await registerWorkspace(kernel, workspaceId)
    await kernel.database.withWorkspace(workspaceId, async (tx) => {
      const [existing] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.workspaceId, workspaceId))
        .limit(1)
      if (existing) return
      await tx.insert(categories).values(
        DEFAULT_CATEGORIES.map((name, index) => ({
          workspaceId,
          name,
          order: index + 1,
        })),
      )
    })
  },
})

/**
 * Remember that this workspace exists, so a job woken by a clock can find it.
 *
 * Written inside `withWorkspace` rather than through the unbound handle: the table carries a
 * row-level security policy like every other tenant table, and a bound session satisfies it without
 * needing the connection to be the schema's owner. The enumeration in `jobs.ts` is the one place
 * that cannot do the same, and says so.
 */
async function registerWorkspace(kernel: Kernel, workspaceId: string): Promise<void> {
  await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx.insert(workspaces).values({ workspaceId }).onConflictDoNothing({ target: workspaces.workspaceId }),
  )
}

export default inventoryModule
export type InventoryModule = typeof inventoryModule
