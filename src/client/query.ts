/**
 * Query keys for Inventory.
 *
 * `[module, entity, …scope]`, so a realtime `change` event invalidates precisely what it touched.
 * Filters are part of the key wherever a screen can ask the same question two ways — a cached list
 * for "all" must not be served when somebody asked for "assigned".
 */
export const inventoryKeys = {
  assets: (ws: string, filters?: Record<string, unknown>) =>
    filters ? (['inventory', 'assets', ws, filters] as const) : (['inventory', 'assets', ws] as const),
  asset: (ws: string, id: string) => ['inventory', 'asset', ws, id] as const,
}
