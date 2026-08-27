import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ASSET_PARAM, assetHref, INVENTORY_PATH, inventoryHref } from './links.js'

/**
 * The link a dashboard card follows, and the parameter the page reads.
 *
 * Both cards showed rows and did nothing with them — `kern-widget` §3, a table of contents rather
 * than a card. A row now opens the asset's panel, which is a URL, which means three things have to
 * agree: the route `module.ts` declares, the parameter `AssetsPage` reads, and the href built here.
 * They are one constant each now, and this holds them to it: a link that is one character off does
 * not fail, it silently lands on the list with nothing open, which looks like the panel is broken.
 */
const HERE = dirname(fileURLToPath(import.meta.url))

describe('assetHref', () => {
  it('scopes the link to the workspace, because the shell mounts every module under a slug', () => {
    // Without the slug a card on one workspace's dashboard links into another's, or into nothing.
    expect(inventoryHref('acme')).toBe('/acme/inventory')
    expect(assetHref('acme', '0192-abc')).toBe('/acme/inventory?asset=0192-abc')
  })

  it('produces a URL whose parameter is the one the page reads back', () => {
    const url = new URL(assetHref('acme', '0192-abc'), 'https://kern.example.com')
    expect(url.pathname).toBe('/acme/inventory')
    expect(url.searchParams.get(ASSET_PARAM)).toBe('0192-abc')
  })

  it('encodes the id rather than trusting it to be a uuid for ever', () => {
    const href = assetHref('acme', 'a&b=c')
    expect(href).toContain('asset=a%26b%3Dc')
    expect(new URL(href, 'https://x.test').searchParams.get(ASSET_PARAM)).toBe('a&b=c')
  })
})

describe('the route this links to is the route the module declares', () => {
  /**
   * `module.ts` cannot be imported here — it reaches `@kernhq/ui`, whose entry point pulls in Svelte
   * components this package's test setup cannot transform. So the declaration is read as text,
   * which is enough: what would break is a path renamed in one file and not the other.
   */
  it('matches the path in `module.ts`', () => {
    const source = readFileSync(join(HERE, 'module.ts'), 'utf8')
    expect(source).toContain(`path: '${INVENTORY_PATH}'`)
  })

  it('is the parameter `AssetsPage` opens its panel from', () => {
    // The page imports `ASSET_PARAM` rather than repeating the literal, so this checks the import
    // is actually what it reads — a re-introduced `params.get('asset')` would pass by accident and
    // then drift the first time the name changed.
    const page = readFileSync(join(HERE, 'pages', 'AssetsPage.svelte'), 'utf8')
    expect(page).toContain('params.get(ASSET_PARAM)')
    expect(page).toContain("from '../links.js'")
  })

  it('is what both dashboard cards send somebody to', () => {
    // The defect being guarded: a widget row that is inert. Each card builds its href from this
    // module, so neither can go back to being a list nobody can act on without this failing.
    for (const widget of ['OverviewWidget.svelte', 'RepairsWidget.svelte']) {
      const source = readFileSync(join(HERE, 'widgets', widget), 'utf8')
      expect({ widget, links: source.includes('assetHref(workspaceSlug') }).toEqual({
        widget,
        links: true,
      })
      // An anchor, not a click handler: that is what makes the keyboard route the same route.
      expect({ widget, anchor: /<a\s+class="row"\s+href=/.test(source) }).toEqual({
        widget,
        anchor: true,
      })
    }
  })
})
