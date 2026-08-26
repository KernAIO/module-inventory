import type { Asset, AssetStatus } from '../contract/index.js'

/**
 * The in-memory implementation of this module's API.
 *
 * It satisfies the same contract types as the real client, so no screen has a second code path for
 * demos and end-to-end tests. The shell reports demo mode through `getHost().isMock` — a module
 * never checks an env var itself.
 *
 * Keep it in step with the contract. A module whose mock is missing a procedure has a working page
 * and a broken demo, in exactly the environment used to show the product — and one whose mock
 * ignores a filter has a demo that contradicts its own controls.
 *
 * **It contradicted the product in five measured ways, and this file is the answer to all five.**
 * It returned seed order while the server defaults to newest first; it issued `INV-0013` for the
 * seventh asset because one counter was doing two jobs; it served page one for ever for any cursor
 * it did not recognise, which is an endless "Load more" where the server answers `BAD_REQUEST`; and
 * it ignored `sort`, `categoryId` and `custodianUserId` entirely. So the ordering, the paging and
 * the cursor format below are deliberately the same as `src/server/services/assets.ts` — read them
 * as one pair, and change them as one pair.
 */
type AssetSort = 'recent' | 'name' | 'code'

interface Seed {
  code: string
  name: string
  status: AssetStatus
  serialNumber?: string | null
  location?: string | null
  warrantyUntil?: string | null
  archived?: boolean
}

const SEEDS: Seed[] = [
  {
    code: 'INV-0001',
    name: 'MacBook Pro 14"',
    status: 'assigned',
    serialNumber: 'C02X1234JGH7',
    location: 'Istanbul · 3rd floor',
    warrantyUntil: '2027-03-14',
  },
  { code: 'INV-0002', name: 'Dell UltraSharp 27"', status: 'in_stock', location: 'Istanbul · store room' },
  {
    code: 'INV-0003',
    name: 'iPhone 15',
    status: 'under_repair',
    serialNumber: 'F17GX9QKLM',
    location: 'With the repairer',
  },
  { code: 'INV-0004', name: 'Herman Miller Aeron', status: 'assigned', location: 'Istanbul · 2nd floor' },
  { code: 'INV-0005', name: 'Canon EOS R6', status: 'reserved', location: 'Istanbul · store room' },
  { code: 'INV-0006', name: 'ThinkPad X1 Carbon', status: 'retired', archived: true },
]

/**
 * An error shaped like one the real client surfaces.
 *
 * oRPC hands a failure to the screen as an `Error` carrying the contract's `code`, and the screens
 * show `error.message`. A mock that throws a bare `Error` teaches a demo that every failure looks
 * the same, and hides the one branch — `BAD_REQUEST` on a stale page marker — this file exists to
 * reproduce.
 */
class MockApiError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'MockApiError'
  }
}

/**
 * The server's page boundary, byte for byte: base64url of `{i: <row id>, s: <sort>}`.
 *
 * `btoa` rather than `Buffer` because this runs in a browser, and it is safe here for the reason
 * the server's version is small: the payload is a uuid and a sort name, so it is pure ASCII.
 */
const base64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromBase64url = (text: string) =>
  atob(
    text
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(text.length / 4) * 4, '='),
  )

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const encodeCursor = (bookmark: { i: string; s: AssetSort }) => base64url(JSON.stringify(bookmark))

/**
 * Refuse a marker this list did not issue, exactly where the server refuses it.
 *
 * The old mock read an unknown cursor as "start at 0", so `nextCursor` was non-null for ever and
 * "Load more" served page one until somebody closed the tab. A cursor bound to the wrong sort is
 * the same class of bug and is refused for the same reason.
 */
function decodeCursor(cursor: string, sort: AssetSort): { i: string; s: AssetSort } {
  const refuse = () => new MockApiError('BAD_REQUEST', 'That page marker is not one this list issued')
  let parsed: { i?: unknown; s?: unknown } | null
  try {
    parsed = JSON.parse(fromBase64url(cursor)) as { i?: unknown; s?: unknown } | null
  } catch {
    throw refuse()
  }
  if (typeof parsed?.i !== 'string' || !UUID.test(parsed.i)) throw refuse()
  if (parsed.s !== sort) throw refuse()
  return { i: parsed.i, s: sort }
}

/** Which field an ordering sorts on. `recent` is the id, because a uuidv7 is already in time order. */
const sortKeyOf = (asset: Asset, sort: AssetSort) =>
  sort === 'name' ? asset.name : sort === 'code' ? asset.code : asset.id

/**
 * `(sortKey, id)` against `(sortKey, id)` — the tuple the server's row comparison uses.
 *
 * The id tiebreak is what makes the boundary total: two assets with the same name would otherwise
 * have no defined order between them, and a page boundary that lands between them would repeat or
 * skip a row. JS compares by code point where Postgres compares by collation, which is close enough
 * for six seeded rows and is the one place this file is an approximation rather than a mirror.
 */
function compare(a: Asset, b: Asset, sort: AssetSort): number {
  const ka = sortKeyOf(a, sort)
  const kb = sortKeyOf(b, sort)
  if (ka !== kb) return ka < kb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function createMockInventoryApi() {
  /**
   * Two counters, because they were one and it showed.
   *
   * `blank()` incremented the id counter and `create` then formatted a code out of it, so six seeds
   * consumed six numbers and the seventh asset somebody added in a demo was filed as `INV-0013`
   * beside `INV-0006`. An id and a human-readable tag are separate sequences on the server too.
   */
  let nextIdNumber = 1
  let nextCodeNumber = SEEDS.length + 1

  const newId = () => `01920000-0000-7000-8000-${String(nextIdNumber++).padStart(12, '0')}`
  const pad = (n: number) => `INV-${String(n).padStart(4, '0')}`

  function blank(code: string, seed: Partial<Seed> & { name?: string } = {}): Asset {
    const now = new Date().toISOString()
    return {
      id: newId(),
      workspaceId: '' as Asset['workspaceId'],
      code: seed.code ?? code,
      name: seed.name ?? '',
      description: '',
      categoryId: null,
      status: seed.status ?? 'in_stock',
      custodianUserId: null,
      custodySince: null,
      serialNumber: seed.serialNumber ?? null,
      location: seed.location ?? null,
      purchasedOn: null,
      purchasedFrom: null,
      priceMinor: null,
      currency: null,
      warrantyUntil: seed.warrantyUntil ?? null,
      photoFileId: null,
      custom: {},
      createdAt: now,
      updatedAt: now,
      archivedAt: seed.archived ? now : null,
    }
  }

  const assets: Asset[] = SEEDS.map((seed, i) => blank(pad(i + 1), seed))

  /**
   * The workspace every seeded row belongs to, learned from the first call that names one.
   *
   * The seeds are built before any workspace exists, and only `list` used to stamp its argument
   * onto what it returned — so the same asset came back with a real `workspaceId` from the list and
   * an empty one from `get`, `update` and `archive`. A demo where one row disagrees with itself
   * about which workspace it is in is the kind of thing nobody notices until a screen keys a cache
   * off it.
   */
  let workspace = '' as Asset['workspaceId']
  const remember = (id?: string) => {
    if (id) workspace = id as Asset['workspaceId']
  }
  const stamp = (asset: Asset): Asset => ({ ...asset, workspaceId: workspace })

  const matches = (a: Asset, q?: string) =>
    !q ||
    [a.name, a.code, a.serialNumber ?? ''].some((field) => field.toLowerCase().includes(q.toLowerCase()))

  const find = (assetId: string) => {
    const asset = assets.find((a) => a.id === assetId)
    if (!asset) throw new MockApiError('NOT_FOUND', 'Asset not found')
    return asset
  }

  return {
    assets: {
      list: async ({
        workspaceId,
        q,
        status,
        categoryId,
        custodianUserId,
        archived = false,
        sort = 'recent',
        limit = 50,
        cursor,
      }: {
        workspaceId: string
        q?: string
        status?: AssetStatus
        categoryId?: string
        custodianUserId?: string
        archived?: boolean
        sort?: AssetSort
        limit?: number
        cursor?: string
      }) => {
        remember(workspaceId)
        // Every control the screen offers filters here, or the demo argues with its own toolbar.
        const all = assets
          .filter((a) => matches(a, q))
          .filter((a) => (status ? a.status === status : true))
          .filter((a) => (categoryId ? a.categoryId === categoryId : true))
          .filter((a) => (custodianUserId ? a.custodianUserId === custodianUserId : true))
          .filter((a) => (archived ? true : !a.archivedAt))
          .map(stamp)

        // `recent` is the only descending order, and it is the contract's default — the list opens
        // on what was added last, which is what the server does and what the old mock did not.
        const descending = sort === 'recent'
        all.sort((a, b) => (descending ? -compare(a, b, sort) : compare(a, b, sort)))

        let rows = all
        if (cursor) {
          const mark = decodeCursor(cursor, sort)
          const bookmarked = assets.find((a) => a.id === mark.i)
          /**
           * A row archived or removed between two pages leaves nothing to compare against and the
           * page simply ends — the server's deliberate choice, because somebody else editing while
           * you read is an ordinary race rather than a malformed request.
           */
          if (!bookmarked) rows = []
          else
            rows = all.filter((a) => {
              const order = compare(a, bookmarked, sort)
              return descending ? order < 0 : order > 0
            })
        }

        // limit + 1 to learn whether there is a next page, exactly as the server does.
        const window = rows.slice(0, limit + 1)
        const items = window.slice(0, limit)
        const last = items.at(-1)
        const nextCursor = window.length > limit && last ? encodeCursor({ i: last.id, s: sort }) : null
        return { items, nextCursor }
      },

      get: async ({ workspaceId, assetId }: { workspaceId?: string; assetId: string }) => {
        remember(workspaceId)
        return stamp(find(assetId))
      },

      create: async ({ workspaceId, ...rest }: { workspaceId: string } & Record<string, unknown>) => {
        remember(workspaceId)
        const asset: Asset = {
          ...blank(pad(nextCodeNumber++)),
          name: String(rest.name ?? ''),
          description: String(rest.description ?? ''),
          serialNumber: (rest.serialNumber as string | undefined) ?? null,
          location: (rest.location as string | undefined) ?? null,
          purchasedFrom: (rest.purchasedFrom as string | undefined) ?? null,
          purchasedOn: (rest.purchasedOn as string | undefined) ?? null,
          warrantyUntil: (rest.warrantyUntil as string | undefined) ?? null,
          priceMinor: (rest.priceMinor as number | undefined) ?? null,
          currency: (rest.currency as string | undefined) ?? null,
        }
        assets.push(asset)
        return stamp(asset)
      },

      update: async ({
        assetId,
        workspaceId,
        ...rest
      }: { assetId: string; workspaceId?: string } & Record<string, unknown>) => {
        remember(workspaceId)
        const asset = find(assetId)
        // `workspaceId` is not among the fields assigned: it is routing, not a field of the asset,
        // and letting a patch carry it means a demo can move a row to a workspace that is not real.
        Object.assign(asset, rest, { updatedAt: new Date().toISOString() })
        return stamp(asset)
      },

      archive: async ({
        workspaceId,
        assetId,
        archived,
      }: {
        workspaceId?: string
        assetId: string
        archived?: boolean
      }) => {
        remember(workspaceId)
        const asset = find(assetId)
        asset.archivedAt = archived === false ? null : new Date().toISOString()
        asset.updatedAt = new Date().toISOString()
        return stamp(asset)
      },
    },
  }
}
