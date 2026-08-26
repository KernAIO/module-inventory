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
 */
export const inventoryKeys = {
  /** Everything under this module, for the blunt invalidation after a write. */
  all: ['inventory'] as const,
  assets: (ws: string, filters?: Record<string, unknown>) =>
    filters ? (['inventory', 'asset', ws, filters] as const) : (['inventory', 'asset', ws] as const),
  asset: (ws: string, id: string) => ['inventory', 'asset', ws, id] as const,
}
