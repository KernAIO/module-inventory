import type { JobDef, Kernel } from '@kernhq/kernel'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { MODULE_ID } from '../contract/models.js'
import { InventorySettings } from '../contract/settings.js'
import { assets, repairs, workspaces } from './schema.js'
import { membersWithPermission } from './services/audience.js'
import { inventoryServices } from './services/index.js'
import { assetUrl } from './services/search.js'

/** More rows than any one workspace should reach in a day, and a bound all the same. */
const SWEEP_LIMIT = 500

/**
 * Inventory's scheduled work.
 *
 * **A cron expression fires in UTC, and this module's users do not live there** — `module-hr` says
 * that at the top of its own jobs file, and it is worth saying what follows from it here, because
 * the answer is different. HR's calendar jobs fan out per office and ask each whether *that
 * office's* local boundary has passed, since which month an accrual belongs to changes with the
 * answer. Nothing here has that property:
 *
 * - what these two sweeps *find* is a date comparison against a window thirty days or a fortnight
 *   wide, so an item is inside it for weeks and the hour it is noticed cannot change whether it is
 *   noticed;
 * - what they *send* is sent exactly once per row ever, because each writes a marker column, so
 *   firing on a different hour cannot send anything twice.
 *
 * So a daily UTC cron is honest here where it would have been a bug in HR. The one thing that must
 * not be borrowed from the deployment is **today**: `now()::date` in Postgres is the database
 * session's timezone, which is an accident of how the container was started. Today comes from
 * `todayUtc()` below and is passed into the query as a value.
 *
 * Both handlers are idempotent by construction rather than by scheduling: a retried run re-reads the
 * marker and finds nothing left to say. That matters, because pg-boss retries a throwing handler
 * three times.
 */

/** Today, as this module means it: the UTC date. The same clock `RepairService` dates a repair by. */
const todayUtc = (at: Date = new Date()): string => at.toISOString().slice(0, 10)

/** `YYYY-MM-DD`, `n` days either side. */
function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Workspaces this module is switched on in.
 *
 * Read from the module's own table rather than asked of core every tick, for the reason
 * `schema.ts` gives at `workspaces`: a sweep that depends on a broker round trip fails whenever
 * core is briefly away, which is exactly the condition an unattended overnight job has to survive.
 *
 * **Unbound on purpose, and the table's policy is what makes that legal.** A scheduler is woken by a
 * clock, so there is no workspace to bind to and `app.workspace_id` is unset here by definition. The
 * per-workspace policy every tenant table carries therefore matches nothing, and `workspaces` — like
 * every other table in this schema — carries `force row level security`, which subjects the schema's
 * **owner** to its policies as well. So this read answered *zero rows, silently, for ever* on any
 * deployment whose application role is not a superuser, and it would have gone on doing so with no
 * error to notice. `0006_workspace_registry_read.sql` adds the one policy that admits it: a select
 * policy on this table alone, for a session with no workspace bound. It is exported so the test
 * suite can run the real enumeration rather than a query that resembles it.
 */
export async function activeWorkspaces(kernel: Kernel): Promise<string[]> {
  const rows = await kernel.database.db.select({ id: workspaces.workspaceId }).from(workspaces)
  return rows.map((row) => row.id)
}

/**
 * Run `fn` for every workspace that still has the module on, logging per-workspace failures rather
 * than propagating them.
 *
 * One workspace's bad data must not stop the sweep for the next one — a job that throws half way
 * through is a job that has notified an arbitrary prefix of the instance and will do it again on the
 * retry. `isModuleEnabled` is asked because the row here outlives a workspace switching the module
 * off: nothing deletes it, deliberately, so switching Inventory back on does not lose the
 * registration.
 */
async function forEachWorkspace(
  kernel: Kernel,
  job: string,
  fn: (workspaceId: string) => Promise<void>,
): Promise<void> {
  for (const workspaceId of await activeWorkspaces(kernel)) {
    if (!(await kernel.isModuleEnabled(workspaceId, MODULE_ID).catch(() => false))) continue
    try {
      await fn(workspaceId)
    } catch (err) {
      kernel.log.warn(
        { err: err instanceof Error ? err.message : String(err), workspaceId, job, module: MODULE_ID },
        'inventory: scheduled job failed for a workspace',
      )
    }
  }
}

/**
 * The three statuses this module derives from its own rows, and therefore the only three it may
 * overwrite.
 *
 * `lost` and `retired` are what somebody said, kept in `assets.disposition`, and a reconciliation
 * that stamped over one would silently undo their decision — so a row carrying either is outside
 * this sweep entirely. The `case` below still reads the column first, so a row that somehow held a
 * disposition and a derived status would be put right rather than argued with. `reserved` is set by
 * nothing. `deriveStatus` says the same thing from the other side.
 */
const DERIVED_STATUSES = ['in_stock', 'assigned', 'under_repair'] as const

/**
 * Bring `assets.status` back into step with the facts, for one workspace.
 *
 * **Every write path already does this for the row it touches, and this is for the rows nobody
 * touches.** `status` is stored because every list filter asks for it, and derived from two facts —
 * custody, and an open repair *the workspace still records*. The second one has an input that no
 * row change can be hung off: switching the `repairs` capability off changes the answer for every
 * asset in the workspace at once, and switching it back on changes it back, without a single row
 * being written either time.
 *
 * That is what stranded an asset. With repairs off, `repairs.complete` answers 404 and the row that
 * decides `under_repair` can never be closed, so an item sat in a status nothing could move it out
 * of, behind an archive that refused it for pointing at the same 404. The refusal is withdrawn now
 * and every custody verb re-derives the status it writes — so anything anybody touches heals at
 * once — and this is the sweep for the spare in the cupboard that nobody touches for a month.
 *
 * It runs **in both directions and on every tick**, which is what makes the capability reversible
 * rather than one-way: with repairs off it releases anything still stamped `under_repair`, and with
 * repairs on it stamps back anything that has an open repair and lost the status while the switch
 * was off. Nothing is destroyed either way — the repair rows are untouched, and the status is a
 * derivation, not a record.
 *
 * One statement, and normally it matches nothing: the `is distinct from` is what keeps a nightly
 * job over every workspace from rewriting every asset row it has. Live rows only — an archived
 * asset is out of the register, and churning its `updated_at` would say something moved.
 */
export async function reconcileStatuses(
  kernel: Kernel,
  workspaceId: string,
  repairsOn: boolean,
): Promise<number> {
  // Correlated to the asset row being updated. Skipped entirely when the workspace does not record
  // repairs, which is the whole point — the same shape as `awayForRepair` in `status.ts`, expressed
  // once over a set instead of once per row.
  const away = repairsOn
    ? sql`exists (select 1 from ${repairs}
                   where ${repairs.workspaceId} = ${assets.workspaceId}
                     and ${repairs.assetId} = ${assets.id}
                     and ${repairs.returnedOn} is null)`
    : sql`false`
  const derived = sql`case
      when ${assets.disposition} in ('lost', 'retired') then ${assets.disposition}
      when ${away} then 'under_repair'
      when ${assets.custodianUserId} is not null then 'assigned'
      else 'in_stock' end`

  const rows = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .update(assets)
      .set({ status: derived, updatedAt: new Date() })
      .where(
        and(
          eq(assets.workspaceId, workspaceId),
          isNull(assets.archivedAt),
          inArray(assets.status, [...DERIVED_STATUSES]),
          sql`${assets.status} is distinct from (${derived})`,
        ),
      )
      .returning({ id: assets.id }),
  )
  return rows.length
}

/** A `date` column reads back as `YYYY-MM-DD`; this is how it is spoken in a sentence. */
const readableDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })

export function inventoryJobs(): JobDef<Record<string, unknown>>[] {
  return [
    {
      /**
       * Warranties about to run out.
       *
       * Told to whoever is holding the item, because they are the person who will be standing in
       * front of a broken laptop the week after — and to whoever may replace it when nobody is
       * holding it, since a spare in a cupboard has no other audience. One notice per asset, ever:
       * `warranty_notified_at` is what stops a thirty-day window sending thirty emails, and
       * `assets.update` clears it when the date itself moves.
       */
      name: 'warranty-sweep',
      cron: '0 7 * * *',
      handler: async (_input, { kernel }) => {
        const svc = inventoryServices(kernel)
        await forEachWorkspace(kernel, 'warranty-sweep', async (workspaceId) => {
          // Settings come from core over the broker, so they are read before any transaction opens
          // — the same rule `AssetService.codeFormat` documents.
          const settings = await kernel.settings.module(workspaceId, MODULE_ID, InventorySettings)
          const today = todayUtc()
          const horizon = shiftDays(today, settings.warrantyNoticeDays)

          const due = await kernel.database.withWorkspace(workspaceId, (tx) =>
            tx
              .select({
                id: assets.id,
                code: assets.code,
                name: assets.name,
                warrantyUntil: assets.warrantyUntil,
                custodianUserId: assets.custodianUserId,
              })
              .from(assets)
              .where(
                and(
                  eq(assets.workspaceId, workspaceId),
                  isNull(assets.archivedAt),
                  isNull(assets.warrantyNotifiedAt),
                  // Inside the window and not already past it. An expiry that came and went is not
                  // "about to run out", and saying so weeks later reads as a broken clock.
                  sql`${assets.warrantyUntil} is not null
                      and ${assets.warrantyUntil} >= ${today}::date
                      and ${assets.warrantyUntil} <= ${horizon}::date`,
                ),
              )
              .orderBy(asc(assets.warrantyUntil))
              .limit(SWEEP_LIMIT),
          )
          if (!due.length) return

          // Resolved once for the workspace rather than once per asset: it is a handful of broker
          // calls, and a hundred expiring warranties must not become a hundred audience lookups.
          let managers: string[] | null = null
          const fallback = async () => {
            managers ??= await membersWithPermission(kernel, workspaceId, 'inventory.asset.manage')
            return managers
          }

          let notified = 0
          let unheard = 0
          let undelivered = 0
          for (const asset of due) {
            const userIds = asset.custodianUserId ? [asset.custodianUserId] : await fallback()
            /**
             * Nobody to tell is **not** the same as told, so the row is left unmarked.
             *
             * Marking it anyway would mean a workspace that has nobody holding
             * `inventory.asset.manage` today silently loses the notice for ever — including for the
             * person who is given that permission tomorrow. The cost of leaving it is one audience
             * lookup per workspace per night, which is already resolved once and cached above.
             */
            if (!userIds.length) {
              unheard++
              continue
            }

            const delivered = await svc.notify.notify({
              workspaceId,
              userIds,
              type: 'inventory.warranty.expiring',
              // The tag leads, because that is what is printed on the sticker.
              title: `${asset.code} is out of warranty on ${readableDate(asset.warrantyUntil as string)}`,
              body: asset.name,
              object: { module: MODULE_ID, type: 'asset', id: asset.id },
              url: assetUrl(asset.id),
              groupKey: asset.id,
            })

            /**
             * **The marker means "everybody was told", so nothing is marked until everybody was.**
             *
             * `notify` is best-effort by design: a `core.notifications.create` that fails is logged
             * and swallowed, and it used to come back looking exactly like one that succeeded. This
             * column is written once per asset and never cleared, and the notice is sent once per
             * asset ever — so a marker written over a swallowed failure is not a delayed notice, it
             * is a notice nobody will ever receive, for the life of the row. Left unmarked the
             * sweep simply says it again tomorrow, which is the whole reason it runs every day.
             *
             * **A partial delivery is a failure, and it used to be recorded as a success.** A spare
             * with three managers in the audience needed one of the three writes to land for the row
             * to be stamped *told*; the other two were never told and never would be. There is one
             * column and it cannot hold two answers, so it holds the pessimistic one — whoever did
             * hear it hears it again tomorrow, `groupKey` collapses that where a client groups, and
             * nobody is silently left out.
             */
            if (delivered.delivered < delivered.targeted || !delivered.targeted) {
              undelivered++
              continue
            }

            await kernel.database.withWorkspace(workspaceId, (tx) =>
              tx
                .update(assets)
                .set({ warrantyNotifiedAt: new Date() })
                .where(and(eq(assets.workspaceId, workspaceId), eq(assets.id, asset.id))),
            )
            notified++
          }
          if (unheard)
            kernel.log.warn(
              { module: MODULE_ID, workspaceId, silent: unheard },
              'inventory: warranties are running out and nobody in the workspace may replace them',
            )
          if (undelivered)
            kernel.log.warn(
              { module: MODULE_ID, workspaceId, undelivered },
              'inventory: warranty notices could not be delivered; they stay unmarked and go again tomorrow',
            )
          if (notified)
            kernel.log.info(
              { module: MODULE_ID, workspaceId, notified },
              'inventory: warranties about to expire',
            )
        })
      },
    },

    {
      /**
       * Repairs nobody has chased.
       *
       * Told to the person who logged it — they committed the company to the money and they have the
       * repairer's number — and to whoever is still holding the item, who is the one waiting for it
       * back. Neither is a guess: both are columns. Only when the repair carries neither does this
       * fall back to asking who may manage repairs at all.
       *
       * **Asks the capability first, and acts on the answer either way.** A workspace with `repairs`
       * switched off has no repairs surface, so a sweep that notified about repair rows left over
       * from before it was switched off would be the feature answering 404 to a person and sending
       * them email about it. What it *does* still owe that workspace is a register that does not
       * claim `under_repair` for an item behind a procedure that answers 404 — so the status
       * reconciliation runs before the switch is consulted, in both directions. `reconcileStatuses`
       * argues it in full.
       */
      name: 'repair-overdue',
      cron: '20 7 * * *',
      handler: async (_input, { kernel }) => {
        const svc = inventoryServices(kernel)
        await forEachWorkspace(kernel, 'repair-overdue', async (workspaceId) => {
          const on = await kernel.capabilities(workspaceId, MODULE_ID)
          const repairsOn = on.has('repairs')

          const healed = await reconcileStatuses(kernel, workspaceId, repairsOn)
          if (healed)
            kernel.log.info(
              { module: MODULE_ID, workspaceId, healed, repairsOn },
              'inventory: brought asset statuses back into step with the repairs capability',
            )
          if (!repairsOn) return

          const settings = await kernel.settings.module(workspaceId, MODULE_ID, InventorySettings)
          const cutoff = shiftDays(todayUtc(), -settings.repairOverdueDays)

          const late = await kernel.database.withWorkspace(workspaceId, (tx) =>
            tx
              .select({
                id: repairs.id,
                assetId: repairs.assetId,
                summary: repairs.summary,
                vendor: repairs.vendor,
                sentOn: repairs.sentOn,
                createdBy: repairs.createdBy,
                code: assets.code,
                name: assets.name,
                custodianUserId: assets.custodianUserId,
              })
              .from(repairs)
              .innerJoin(
                assets,
                and(eq(assets.id, repairs.assetId), eq(assets.workspaceId, repairs.workspaceId)),
              )
              .where(
                and(
                  eq(repairs.workspaceId, workspaceId),
                  isNull(repairs.returnedOn),
                  isNull(repairs.overdueNotifiedAt),
                  sql`${repairs.sentOn} <= ${cutoff}::date`,
                ),
              )
              .orderBy(asc(repairs.sentOn))
              .limit(SWEEP_LIMIT),
          )
          if (!late.length) return

          let managers: string[] | null = null
          const fallback = async () => {
            managers ??= await membersWithPermission(kernel, workspaceId, 'inventory.repair.manage')
            return managers
          }

          let notified = 0
          let unheard = 0
          let undelivered = 0
          for (const repair of late) {
            const named = [repair.createdBy, repair.custodianUserId].filter((id): id is string => Boolean(id))
            const userIds = named.length ? named : await fallback()
            // Nobody to tell is not the same as told; see the warranty sweep above.
            if (!userIds.length) {
              unheard++
              continue
            }

            const delivered = await svc.notify.notify({
              workspaceId,
              userIds,
              type: 'inventory.repair.overdue',
              title: `${repair.code} has been away since ${readableDate(repair.sentOn)}`,
              body: repair.vendor ? `${repair.summary} · ${repair.vendor}` : repair.summary,
              object: { module: MODULE_ID, type: 'asset', id: repair.assetId },
              url: assetUrl(repair.assetId),
              groupKey: repair.id,
            })
            // Anybody left untold means nothing is marked: the same rule, and the same reason, as
            // the warranty sweep above spells out in full.
            if (delivered.delivered < delivered.targeted || !delivered.targeted) {
              undelivered++
              continue
            }

            await kernel.database.withWorkspace(workspaceId, (tx) =>
              tx
                .update(repairs)
                .set({ overdueNotifiedAt: new Date() })
                .where(and(eq(repairs.workspaceId, workspaceId), eq(repairs.id, repair.id))),
            )
            notified++
          }
          if (unheard)
            kernel.log.warn(
              { module: MODULE_ID, workspaceId, silent: unheard },
              'inventory: repairs are overdue and nobody in the workspace may chase them',
            )
          if (undelivered)
            kernel.log.warn(
              { module: MODULE_ID, workspaceId, undelivered },
              'inventory: overdue repair notices could not be delivered; they stay unmarked and go again tomorrow',
            )
          if (notified)
            kernel.log.info(
              { module: MODULE_ID, workspaceId, notified },
              'inventory: repairs away longer than the workspace allows',
            )
        })
      },
    },
  ] as JobDef<Record<string, unknown>>[]
}
