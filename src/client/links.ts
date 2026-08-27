/**
 * Where this module's screens live, as URLs.
 *
 * Two things need to agree and were three files apart: `module.ts` declares the route, `AssetsPage`
 * reads `?asset=<id>` to decide which panel is open, and a dashboard card has to be able to send
 * somebody to exactly that. A widget that only *shows* rows is a table of contents — `kern-widget`
 * §3 — and both of this module's cards were exactly that, with no way to act on a row at all.
 *
 * A pure module rather than a constant inside a component, for the reason `custody.ts` and
 * `price.ts` are: `module.ts` imports `@kernhq/ui`, so anything that reads its route declaration
 * drags a Svelte compiler behind it, and "does this href open that panel" is a fact with a right
 * answer.
 */

/** The module's own route, as declared in `module.ts`. The workspace slug goes in front of it. */
export const INVENTORY_PATH = '/inventory'

/** The parameter `AssetsPage` reads to decide which asset's panel is open. */
export const ASSET_PARAM = 'asset'

/**
 * The list, scoped to a workspace.
 *
 * The shell mounts every module route under `/<workspaceSlug>`, so a link built without the slug
 * lands on the wrong workspace — or on nothing, which is what a widget on a second workspace's
 * dashboard would have done.
 */
export function inventoryHref(workspaceSlug: string): string {
  return `/${workspaceSlug}${INVENTORY_PATH}`
}

/**
 * One asset, open in its panel over the list.
 *
 * Deliberately the list URL with a parameter rather than a page of its own: that is the URL the
 * page already owns, so following it from a dashboard card leaves somebody in the same place they
 * would have reached by clicking the row — with the list behind the panel, and Back closing it.
 *
 * The id is encoded even though it is always a uuid. A raw value in a query string is how a link
 * builder eventually ships an injection, and `encodeURIComponent` costs nothing on a uuid.
 */
export function assetHref(workspaceSlug: string, assetId: string): string {
  return `${inventoryHref(workspaceSlug)}?${ASSET_PARAM}=${encodeURIComponent(assetId)}`
}
