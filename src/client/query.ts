/**
 * Query keys for Inventory.
 *
 * `[module, entity, …scope]`, so a realtime `change` event invalidates precisely what it touched.
 * Filters are part of the key wherever a screen can ask the same question two ways — a cached list
 * for "all" must not be served when somebody asked for "assigned", and the archived list is a
 * different question from the live one rather than the same answer filtered afterwards.
 *
 * **The entity segment is singular, and that is not a style choice.** `realtime.svelte.ts`
 * invalidates `[module, entity]` with whatever the server put in the change event, and
 * `src/server/router.ts` emits `entity: 'asset'` — so the prefix that arrives is
 * `['inventory', 'asset']`. This file spelled the list key `['inventory', 'assets', …]`, which that
 * prefix never matches: `partialMatchKey` compares segment by segment and `'assets' !== 'asset'`.
 * The detail key was already singular, so a change refreshed the panel nobody was looking at while
 * the list and the dashboard card behind it stayed stale until a reload. Every other module keys
 * the list and the row off one singular entity name (`['tracker', 'issue', …]`); so does this one
 * now.
 *
 * **The timeline and the custody list hang off the asset's own key**, one segment deeper. That is
 * what lets custody announce itself as `entity: 'asset'` and refresh all four things it changed —
 * the row, the list, the detail panel and both of its tabs — from one change event, because
 * `partialMatchKey` matches on the prefix. A separate `['inventory', 'custody', …]` would need the
 * server to emit a second entity for the same write.
 */
export const inventoryKeys = {
  /** Everything under this module, for the blunt invalidation after a write. */
  all: ['inventory'] as const,
  assets: (ws: string, filters?: Record<string, unknown>) =>
    filters ? (['inventory', 'asset', ws, filters] as const) : (['inventory', 'asset', ws] as const),
  asset: (ws: string, id: string) => ['inventory', 'asset', ws, id] as const,
  /** The asset's own timeline. Under the asset, so one `asset` change refreshes it. */
  assetHistory: (ws: string, id: string) => ['inventory', 'asset', ws, id, 'history'] as const,
  /** Every custody period for one asset. Under the asset, for the same reason. */
  assetCustody: (ws: string, id: string) => ['inventory', 'asset', ws, id, 'custody'] as const,
  /** One asset's repairs. Under the asset, so a repair announced as an `asset` change refreshes it. */
  assetRepairs: (ws: string, id: string) => ['inventory', 'asset', ws, id, 'repairs'] as const,
  /** One asset's files, its repairs' included — the panel groups them, so there is one key. */
  assetAttachments: (ws: string, id: string) => ['inventory', 'asset', ws, id, 'attachments'] as const,
  /**
   * The workspace's repairs, which belong to no single asset — the "what is away right now" card.
   *
   * Its own entity, because it cannot hang under one asset's key: `src/server/router.ts` therefore
   * announces a repair twice, once as the asset that changed and once as the repair itself.
   */
  repairs: (ws: string, filters?: Record<string, unknown>) =>
    filters ? (['inventory', 'repair', ws, filters] as const) : (['inventory', 'repair', ws] as const),
  /**
   * The register in numbers.
   *
   * Under the **asset** prefix on purpose, one segment deep: every number it holds is a count of
   * assets, so every write that changes one of those counts already announces `entity: 'asset'` and
   * this is refreshed by the same event. `'stats'` cannot collide with `asset(ws, id)` — that
   * segment is always a uuid.
   */
  stats: (ws: string) => ['inventory', 'asset', ws, 'stats'] as const,
  /**
   * The workspace's categories. Its own entity because it has its own change event: a rename
   * touches every asset row on screen, and `src/server/router.ts` therefore emits both.
   */
  categories: (ws: string, archived = false) => ['inventory', 'category', ws, { archived }] as const,
}
