import type { core, EntityChange, ObjectRef } from '@kernhq/contracts'
import { type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { MODULE_ID } from '../../contract/models.js'
import { assetHistory } from '../schema.js'

export interface HistoryInput {
  workspaceId: string
  assetId: string
  actorId: string | null
  action: string
  changes?: Array<{ field: string; from: unknown; to: unknown }>
  data?: Record<string, unknown>
}

export interface NotifyInput {
  workspaceId: string
  userIds: Iterable<string>
  type: string
  title: string
  body?: string | null
  object?: ObjectRef | null
  url?: string | null
  data?: Record<string, unknown>
  groupKey?: string | null
  actorId?: string | null
  /** never notify the person who caused the change */
  exclude?: Iterable<string | null | undefined>
}

/**
 * Side effects that leave the module: activity, notifications, realtime and the search index.
 *
 * All of them are best-effort. An inventory mutation must not fail because the core service is
 * briefly unavailable, so every cross-module call is swallowed and logged — the local
 * `asset_history` row is written inside the caller's transaction and remains the authoritative
 * record of what happened.
 */
export class NotifyService {
  constructor(private readonly kernel: Kernel) {}

  private async best<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn()
    } catch (err) {
      this.kernel.log.warn(
        { err: err instanceof Error ? err.message : err, what },
        'inventory side effect failed',
      )
      return null
    }
  }

  /**
   * `best`, asked the other question: **did the call actually happen**, rather than what it returned.
   *
   * `best` cannot answer that — a procedure that legitimately answers `null` or `undefined` is
   * indistinguishable from one that threw and was swallowed, and a caller writing "I have told
   * them" into a database on the strength of that is writing a lie. So the value is thrown away
   * here and the boolean is the whole answer.
   */
  private async attempted(what: string, fn: () => Promise<unknown>): Promise<boolean> {
    return (
      (await this.best(what, async () => {
        await fn()
        return true as const
      })) === true
    )
  }

  /**
   * Append to the asset's own history, inside the caller's transaction.
   *
   * This row is the authoritative record and belongs in the transaction it describes — if the write
   * rolls back, so does its history. The mirror of it in core's activity feed is `activity()`, and
   * it deliberately does **not** happen here: it used to, fired off with `void` while the
   * transaction was still open, so a rollback left the workspace's feed showing an event for an id
   * that never existed. The caller flushes it after the commit, beside the event and the realtime
   * change, which is what everything else in this module already does.
   */
  async history(tx: Tx, input: HistoryInput): Promise<void> {
    await tx.insert(assetHistory).values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      actorId: input.actorId,
      action: input.action,
      changes: input.changes ?? [],
      data: input.data ?? {},
    })
  }

  /** The workspace-wide activity feed's copy. Best-effort, and only ever after the commit. */
  async activity(input: HistoryInput): Promise<void> {
    await this.best('activity.record', () =>
      this.kernel.call('core.activity.record', {
        workspaceId: input.workspaceId,
        module: MODULE_ID,
        object: { module: MODULE_ID, type: 'asset', id: input.assetId },
        action: input.action,
        actorId: input.actorId,
        changes: input.changes ?? [],
        data: input.data ?? {},
      }),
    )
  }

  /**
   * Tell these people, and answer **who it was meant for and how many of them were actually
   * written** — both numbers, because one of them cannot be checked without the other.
   *
   * Everything this class does is best-effort, so a failed `core.notifications.create` is swallowed
   * and logged; a caller that then records "this one has been notified" has recorded something that
   * never happened. The two nightly sweeps write exactly such a marker, once per row for ever, so a
   * swallowed failure there is not a delayed notice but a notice nobody will ever receive.
   *
   * This used to answer a single count, and the sweeps marked the row whenever it was above zero —
   * so a notice that reached one of three recipients was stamped *told*, and the two who missed it
   * never heard. **A partial delivery is a failure for the people it did not reach**, and the row
   * cannot record two answers, so the honest one is the pessimistic one: the sweeps mark nothing
   * unless `delivered === targeted`, and say it again in the morning. The cost is that whoever did
   * hear it hears it twice; `groupKey` collapses that in the notification centre, and it is a
   * strictly smaller price than one person never being told at all.
   *
   * `targeted` is what is left after the de-duplication and the exclusions, which is why the caller
   * cannot work it out from the list it passed in. `targeted: 0` means there was nobody to tell,
   * which is also not "told".
   */
  async notify(input: NotifyInput): Promise<{ targeted: number; delivered: number }> {
    const excluded = new Set([...(input.exclude ?? [])].filter(Boolean) as string[])
    const targets = [...new Set(input.userIds)].filter((id) => id && !excluded.has(id))
    if (!targets.length) return { targeted: 0, delivered: 0 }
    const written = await Promise.all(
      targets.map((userId) =>
        this.attempted('notifications.create', () =>
          this.kernel.call('core.notifications.create', {
            userId,
            workspaceId: input.workspaceId,
            module: MODULE_ID,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            object: input.object ?? null,
            url: input.url ?? null,
            data: input.data ?? {},
            groupKey: input.groupKey ?? null,
            actorId: input.actorId ?? null,
          } as core.CreateNotification),
        ),
      ),
    )
    return { targeted: targets.length, delivered: written.filter(Boolean).length }
  }

  /** Realtime cache invalidation for connected clients. */
  async change(
    workspaceId: string,
    entity: string,
    id: string,
    op: EntityChange['op'],
    opts: { patch?: Record<string, unknown>; scope?: Record<string, string> } = {},
  ): Promise<void> {
    await this.best('realtime.change', () =>
      this.kernel.realtime.change(workspaceId, {
        module: MODULE_ID,
        entity,
        id,
        op,
        ...(opts.patch ? { patch: opts.patch } : {}),
        ...(opts.scope ? { scope: opts.scope } : {}),
      }),
    )
  }

  /**
   * The workspace-wide search index, written to by `SearchService` and by nothing else.
   *
   * These two spent a release with no caller: `objectTypes` had been taken off the module
   * definition, because a declared type with no indexer and no resolver renders a link to nothing.
   * Both halves exist now — `src/server/services/search.ts` builds the documents, `src/server/
   * index.ts` declares the indexer and the resolver — and every asset mutation reindexes after it
   * has committed.
   */
  async index(documents: core.SearchDocument[]): Promise<void> {
    if (!documents.length) return
    await this.best('search.index', () => this.kernel.call('core.search.index', { documents }))
  }

  async unindex(workspaceId: string, type: string, ids: string[]): Promise<void> {
    if (!ids.length) return
    await this.best('search.remove', () =>
      this.kernel.call('core.search.remove', {
        refs: ids.map((id) => ({ workspaceId, object: { module: MODULE_ID, type, id } })),
      }),
    )
  }
}
