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

  async notify(input: NotifyInput): Promise<void> {
    const excluded = new Set([...(input.exclude ?? [])].filter(Boolean) as string[])
    const targets = [...new Set(input.userIds)].filter((id) => id && !excluded.has(id))
    if (!targets.length) return
    await Promise.all(
      targets.map((userId) =>
        this.best('notifications.create', () =>
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

  // Nothing calls `index`/`unindex` yet: `objectTypes` came off the module definition until there
  // is a resolver and an indexer to stand behind it. They are kept as they are, copied from
  // tracker, and are wired up by the change that declares the object type again.
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
