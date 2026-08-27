import type {
  Asset,
  AssetHistoryEntry,
  AssetStatus,
  Attachment,
  Category,
  CustodyPeriod,
  InventoryStats,
  Repair,
} from '../contract/index.js'

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
 *
 * Custody keeps the same invariant the server keeps, for the same reason: a handover closes the open
 * period, opens a new one, moves `custodianUserId`/`custodySince`/`status` and appends a history
 * row, and it refuses the three things the server refuses — assigning something already held,
 * handing on something nobody holds, and touching an archived item. A demo that lets you assign the
 * same laptop twice teaches somebody the product does.
 *
 * Repairs keep the same invariant too, including the one that is easiest to get wrong: **an item at
 * a repairer is still whoever's it was**, so a repair moves `status` and never `custodianUserId`,
 * and completing one returns the item to `assigned` rather than to `in_stock` when somebody still
 * holds it. `statusFor` below is this file's copy of `deriveStatus` on the server; read them as one
 * pair and change them as one pair.
 */
type AssetSort = 'recent' | 'name' | 'code'

/**
 * The people the **shell's** own mock puts in this workspace.
 *
 * Copied ids rather than a fetch, because this file has no client and no way to ask. The coupling is
 * deliberate and narrow: without it every name in the custody tab and the timeline would resolve to
 * "A former member", which is a demo of the fallback rather than a demo of the feature. If the
 * shell's mock people ever change, this is where the demo stops naming them.
 */
const PEOPLE = {
  maya: '01920000-0000-7000-8000-000000000001',
  dan: '01920000-0000-7000-8000-000000000002',
  ines: '01920000-0000-7000-8000-000000000003',
} as const

interface CategorySeed {
  key: string
  name: string
  order: number
  archived?: boolean
}

const CATEGORY_SEEDS: CategorySeed[] = [
  { key: 'laptops', name: 'Laptops', order: 0 },
  { key: 'displays', name: 'Displays', order: 1 },
  { key: 'furniture', name: 'Furniture', order: 2 },
  { key: 'cameras', name: 'Cameras', order: 3 },
  // One archived, so the demo shows what archiving actually does: it leaves the picker and the
  // filter, and the asset filed under it goes on saying what it is.
  { key: 'phones', name: 'Phones', order: 4, archived: true },
]

interface Seed {
  code: string
  name: string
  status: AssetStatus
  categoryKey?: string
  /** Who is holding it. Kept in step with `status` here exactly as the server keeps it. */
  custodian?: string
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
    categoryKey: 'laptops',
    custodian: PEOPLE.dan,
    serialNumber: 'C02X1234JGH7',
    location: 'Istanbul · 3rd floor',
    warrantyUntil: '2027-03-14',
  },
  {
    code: 'INV-0002',
    name: 'Dell UltraSharp 27"',
    status: 'in_stock',
    categoryKey: 'displays',
    location: 'Istanbul · store room',
  },
  {
    code: 'INV-0003',
    name: 'iPhone 15',
    status: 'under_repair',
    // Filed under the archived category on purpose: the row still names "Phones".
    categoryKey: 'phones',
    serialNumber: 'F17GX9QKLM',
    location: 'With the repairer',
  },
  {
    code: 'INV-0004',
    name: 'Herman Miller Aeron',
    status: 'assigned',
    categoryKey: 'furniture',
    custodian: PEOPLE.ines,
    location: 'Istanbul · 2nd floor',
  },
  {
    code: 'INV-0005',
    name: 'Canon EOS R6',
    status: 'reserved',
    categoryKey: 'cameras',
    location: 'Istanbul · store room',
  },
  { code: 'INV-0006', name: 'ThinkPad X1 Carbon', status: 'retired', archived: true },
]

/**
 * An error shaped like one the real client surfaces.
 *
 * oRPC hands a failure to the screen as an `Error` carrying the contract's `code`, and a mock that
 * throws a bare `Error` teaches a demo that every failure looks the same — hiding the two branches
 * this file exists to reproduce, `BAD_REQUEST` on a stale page marker and `CONFLICT` on a handover
 * somebody else got to first.
 *
 * **`data.reason` is part of that shape, and leaving it out made the demo lie in a new way.** The
 * screens no longer render `error.message`: `errors.ts` reads the stable reason token each refusal
 * carries and shows a translated sentence, keeping the server's English only for a failure it does
 * not recognise. A mock that threw the message and no token would send every one of these down the
 * fallback path — so the demo would show English prose where the product shows Persian, which is
 * exactly the defect that was just fixed, reproduced by the thing meant to reproduce the product.
 *
 * The shape matches `kernErrorToORPC`: `{ reason, …details }` under `data`, not beside it.
 */
class MockApiError extends Error {
  readonly data: { reason: string } | undefined
  constructor(
    readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
    reason?: string,
  ) {
    super(message)
    this.name = 'MockApiError'
    this.data = reason ? { reason } : undefined
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

/** Days ago, as an ISO instant — so a seeded timeline reads as history rather than as "just now". */
const daysAgo = (days: number) => new Date(Date.now() - days * 864e5).toISOString()

/** The same instant as a plain date, which is what a `date` column stores. */
const dateDaysAgo = (days: number) => daysAgo(days).slice(0, 10)

/**
 * What core knows about a file, as far as this module is concerned.
 *
 * The **server** asks core for it before recording an attachment. This file has no core to ask —
 * it is data with no client and no imports — so whoever builds the mock passes a resolver in.
 * `api-instance.ts` supplies one backed by the shell's own mock file store, which is where the
 * bytes an upload produced actually went; the default below is for the unit tests, which attach
 * ids that were never uploaded anywhere.
 */
export interface MockFileFacts {
  name: string
  mimeType: string | null
  size: number | null
}

export interface MockInventoryOptions {
  describeFile?: (fileId: string) => Promise<MockFileFacts>
}

export function createMockInventoryApi(options: MockInventoryOptions = {}) {
  const describeFile =
    options.describeFile ?? (async () => ({ name: 'Uploaded file', mimeType: null, size: null }))
  /**
   * Four id sequences, and separate tag numbering, because they were one and it showed.
   *
   * `blank()` incremented the id counter and `create` then formatted a code out of it, so six seeds
   * consumed six numbers and the seventh asset somebody added in a demo was filed as `INV-0013`
   * beside `INV-0006`. An id and a human-readable tag are separate sequences on the server too.
   *
   * The four entity namespaces differ in the *third* group rather than the last, so no asset id can
   * ever equal a category id, a period id — or one of the shell's mock user ids, which live in the
   * same `…-8000-…` space and would otherwise collide with the first asset.
   */
  const counters = { asset: 1, category: 1, period: 1, history: 1, repair: 1, attachment: 1 }
  const newId = (kind: keyof typeof counters, group: string) =>
    `01920000-0000-7000-${group}-${String(counters[kind]++).padStart(12, '0')}`
  const assetId = () => newId('asset', '8001')
  const categoryId = () => newId('category', '8002')
  const periodId = () => newId('period', '8003')
  const historyId = () => newId('history', '8004')
  const repairId = () => newId('repair', '8005')
  const attachmentId = () => newId('attachment', '8006')

  let nextCodeNumber = SEEDS.length + 1
  const pad = (n: number) => `INV-${String(n).padStart(4, '0')}`

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
  const stamp = <T extends { workspaceId: Asset['workspaceId'] }>(row: T): T => ({
    ...row,
    workspaceId: workspace,
  })

  // ---------------------------------------------------------------------------- categories

  const categories: Category[] = CATEGORY_SEEDS.map((seed) => ({
    id: categoryId(),
    workspaceId: '' as Asset['workspaceId'],
    name: seed.name,
    order: seed.order,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
    archivedAt: seed.archived ? daysAgo(10) : null,
  }))
  const categoryByKey = new Map(CATEGORY_SEEDS.map((seed, i) => [seed.key, categories[i]!.id]))

  // -------------------------------------------------------------------------------- assets

  function blank(code: string, seed: Partial<Seed> & { name?: string } = {}): Asset {
    const now = new Date().toISOString()
    return {
      id: assetId(),
      workspaceId: '' as Asset['workspaceId'],
      code: seed.code ?? code,
      name: seed.name ?? '',
      description: '',
      categoryId: seed.categoryKey ? (categoryByKey.get(seed.categoryKey) ?? null) : null,
      status: seed.status ?? 'in_stock',
      custodianUserId: seed.custodian ?? null,
      custodySince: seed.custodian ? daysAgo(21) : null,
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

  // ------------------------------------------------------------------- custody and history

  const periods: CustodyPeriod[] = []
  const history: AssetHistoryEntry[] = []

  const appendHistory = (
    asset: Asset,
    action: string,
    opts: {
      actorId?: string | null
      changes?: AssetHistoryEntry['changes']
      data?: Record<string, unknown>
      occurredAt?: string
    } = {},
  ): AssetHistoryEntry => {
    const entry: AssetHistoryEntry = {
      id: historyId(),
      assetId: asset.id,
      actorId: opts.actorId === undefined ? PEOPLE.maya : opts.actorId,
      action,
      changes: opts.changes ?? [],
      data: opts.data ?? {},
      occurredAt: opts.occurredAt ?? new Date().toISOString(),
    }
    history.push(entry)
    return entry
  }

  /**
   * A seeded past, so the timeline and "previous holders" have something to draw.
   *
   * INV-0001 has been round the houses on purpose — created, handed to Maya, handed on to Dan, and
   * edited — because that is the one asset a demo opens, and an empty Custody tab beside an empty
   * History tab shows neither feature.
   */
  for (const asset of assets) {
    appendHistory(asset, 'created', { occurredAt: daysAgo(45) })
  }
  {
    const first = assets[0]!
    const closed: CustodyPeriod = {
      id: periodId(),
      workspaceId: '' as Asset['workspaceId'],
      assetId: first.id,
      userId: PEOPLE.maya,
      note: 'For the Berlin trip',
      effectiveFrom: daysAgo(40),
      effectiveTo: daysAgo(21),
      createdBy: PEOPLE.maya,
      createdAt: daysAgo(40),
    }
    periods.push(closed)
    appendHistory(first, 'assigned', {
      occurredAt: daysAgo(40),
      data: { userId: PEOPLE.maya, note: closed.note },
    })
    appendHistory(first, 'updated', {
      occurredAt: daysAgo(30),
      changes: [{ field: 'warrantyUntil', from: '2026-03-14', to: '2027-03-14' }],
    })
    appendHistory(first, 'transferred', {
      occurredAt: daysAgo(21),
      data: { userId: PEOPLE.dan, previousUserId: PEOPLE.maya },
    })
  }
  for (const asset of assets) {
    if (!asset.custodianUserId) continue
    periods.push({
      id: periodId(),
      workspaceId: '' as Asset['workspaceId'],
      assetId: asset.id,
      userId: asset.custodianUserId,
      note: null,
      effectiveFrom: asset.custodySince ?? daysAgo(21),
      effectiveTo: null,
      createdBy: PEOPLE.maya,
      createdAt: asset.custodySince ?? daysAgo(21),
    })
    if (asset !== assets[0])
      appendHistory(asset, 'assigned', {
        occurredAt: asset.custodySince ?? daysAgo(21),
        data: { userId: asset.custodianUserId },
      })
  }

  // --------------------------------------------------------------- repairs and attachments

  const repairs: Repair[] = []
  const attachments: Attachment[] = []

  /**
   * This file's copy of the server's `deriveStatus`, and it has to stay a copy of it.
   *
   * Repair wins the status column, custody keeps the custodian column, and neither cancels the
   * other — a laptop at the repairer is still whoever's it was. A mock that wrote `assigned`
   * unconditionally after a handover would show a demo audience an item as back in the office while
   * its repair card said it was in a workshop.
   */
  const statusFor = (asset: Asset): AssetStatus => {
    if (repairs.some((repair) => repair.assetId === asset.id && repair.returnedOn === null))
      return 'under_repair'
    return asset.custodianUserId ? 'assigned' : 'in_stock'
  }

  const restamp = (asset: Asset) => {
    asset.status = statusFor(asset)
    asset.updatedAt = new Date().toISOString()
  }

  {
    /**
     * A seeded repair for the one asset the seeds call `under_repair`, and a finished one for the
     * asset a demo opens.
     *
     * Without the open row, INV-0003 would carry a status nothing in the demo could explain — a
     * status column and a Repairs tab disagreeing about the same item is exactly the thing this
     * file exists to prevent.
     */
    const away = assets[2]!
    repairs.push({
      id: repairId(),
      workspaceId: '' as Asset['workspaceId'],
      assetId: away.id,
      summary: 'Cracked screen',
      detail: null,
      vendor: 'Kadıköy Teknik',
      costMinor: null,
      currency: null,
      sentOn: dateDaysAgo(6),
      returnedOn: null,
      createdBy: PEOPLE.maya,
      createdAt: daysAgo(6),
      updatedAt: daysAgo(6),
    })
    appendHistory(away, 'repair_logged', {
      occurredAt: daysAgo(6),
      data: { repairId: repairs[0]!.id, summary: 'Cracked screen', vendor: 'Kadıköy Teknik' },
    })

    const first = assets[0]!
    const past: Repair = {
      id: repairId(),
      workspaceId: '' as Asset['workspaceId'],
      assetId: first.id,
      summary: 'Battery replacement',
      detail: 'Swelling under the trackpad.',
      vendor: 'Apple Authorised Service',
      costMinor: 18900,
      currency: 'EUR',
      sentOn: dateDaysAgo(34),
      returnedOn: dateDaysAgo(27),
      createdBy: PEOPLE.maya,
      createdAt: daysAgo(34),
      updatedAt: daysAgo(27),
    }
    repairs.push(past)
    appendHistory(first, 'repair_logged', {
      occurredAt: daysAgo(34),
      data: { repairId: past.id, summary: past.summary, vendor: past.vendor },
    })
    appendHistory(first, 'repair_completed', {
      occurredAt: daysAgo(27),
      data: { repairId: past.id, summary: past.summary, costMinor: 18900, currency: 'EUR' },
    })

    // Two files: the asset's own receipt, and the invoice for the repair above. The pair is what
    // shows that a repair keeps its own paperwork rather than dropping it in with everything else.
    attachments.push({
      id: attachmentId(),
      workspaceId: '' as Asset['workspaceId'],
      assetId: first.id,
      repairId: null,
      fileId: '01920000-0000-7000-8007-000000000001',
      name: 'Purchase receipt.pdf',
      mimeType: 'application/pdf',
      size: 184_320,
      uploadedBy: PEOPLE.maya,
      createdAt: daysAgo(45),
    })
    attachments.push({
      id: attachmentId(),
      workspaceId: '' as Asset['workspaceId'],
      assetId: first.id,
      repairId: past.id,
      fileId: '01920000-0000-7000-8007-000000000002',
      name: 'Repair invoice.pdf',
      mimeType: 'application/pdf',
      size: 96_140,
      uploadedBy: PEOPLE.maya,
      createdAt: daysAgo(27),
    })
  }

  // -------------------------------------------------------------------------------- helpers

  const matches = (a: Asset, q?: string) =>
    !q ||
    [a.name, a.code, a.serialNumber ?? ''].some((field) => field.toLowerCase().includes(q.toLowerCase()))

  const find = (id: string) => {
    const asset = assets.find((a) => a.id === id)
    if (!asset) throw new MockApiError('NOT_FOUND', 'Asset not found')
    return asset
  }

  const findCategory = (id: string) => {
    const category = categories.find((c) => c.id === id)
    if (!category) throw new MockApiError('NOT_FOUND', 'Category not found')
    return category
  }

  /**
   * One past the highest position in use, archived rows counted — the server's `appended()`.
   *
   * Archived rows count because one of them can be restored, and a restored category landing on a
   * live one's number is the tie that made a "Position" field a bad idea in the first place.
   */
  const appendedOrder = () => categories.reduce((max, c) => Math.max(max, c.order), -1) + 1

  const openPeriodFor = (id: string) =>
    periods.find((period) => period.assetId === id && period.effectiveTo === null)

  /** At most one, exactly as `inventory_repairs_one_open_uq` guarantees on the server. */
  const openRepairFor = (id: string) =>
    repairs.find((repair) => repair.assetId === id && repair.returnedOn === null)

  const findRepair = (id: string) => {
    const repair = repairs.find((row) => row.id === id)
    if (!repair) throw new MockApiError('NOT_FOUND', 'Repair not found')
    return repair
  }

  /** Today as a plain date, which is what the server fills in when a caller sends none. */
  const today = () => new Date().toISOString().slice(0, 10)

  /** The one refusal a live asset can produce before any of the three verbs runs. */
  const liveAsset = (id: string) => {
    const asset = find(id)
    if (asset.archivedAt)
      throw new MockApiError(
        'CONFLICT',
        'This item is archived. Restore it before handing it over.',
        'inventory.custody.archived',
      )
    return asset
  }

  const listAssets = ({
    q,
    status,
    categoryId: category,
    custodianUserId,
    archived = false,
    sort = 'recent',
    limit = 50,
    cursor,
  }: {
    q?: string
    status?: AssetStatus
    categoryId?: string
    custodianUserId?: string
    archived?: boolean
    sort?: AssetSort
    limit?: number
    cursor?: string
  }) => {
    // Every control the screen offers filters here, or the demo argues with its own toolbar.
    const all = assets
      .filter((a) => matches(a, q))
      .filter((a) => (status ? a.status === status : true))
      .filter((a) => (category ? a.categoryId === category : true))
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
  }

  return {
    assets: {
      list: async ({
        workspaceId,
        ...rest
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
        return listAssets(rest)
      },

      get: async ({ workspaceId, assetId: id }: { workspaceId?: string; assetId: string }) => {
        remember(workspaceId)
        return stamp(find(id))
      },

      /**
       * The timeline, newest first, paged by **id** — the server's ordering, for the server's
       * reason: an id already carries the clock and is unique where a timestamp two rows written in
       * one transaction share is not.
       */
      history: async ({
        workspaceId,
        assetId: id,
        limit = 50,
        cursor,
      }: {
        workspaceId?: string
        assetId: string
        limit?: number
        cursor?: string
      }) => {
        remember(workspaceId)
        find(id)
        const all = history.filter((entry) => entry.assetId === id).sort((a, b) => (a.id < b.id ? 1 : -1))
        const rows = cursor ? all.filter((entry) => entry.id < decodeCursor(cursor, 'recent').i) : all
        const window = rows.slice(0, limit + 1)
        const items = window.slice(0, limit)
        const last = items.at(-1)
        const nextCursor = window.length > limit && last ? encodeCursor({ i: last.id, s: 'recent' }) : null
        return { items, nextCursor }
      },

      create: async ({ workspaceId, ...rest }: { workspaceId: string } & Record<string, unknown>) => {
        remember(workspaceId)
        const asset: Asset = {
          ...blank(pad(nextCodeNumber++)),
          name: String(rest.name ?? ''),
          description: String(rest.description ?? ''),
          categoryId: (rest.categoryId as string | undefined) ?? null,
          serialNumber: (rest.serialNumber as string | undefined) ?? null,
          location: (rest.location as string | undefined) ?? null,
          purchasedFrom: (rest.purchasedFrom as string | undefined) ?? null,
          purchasedOn: (rest.purchasedOn as string | undefined) ?? null,
          warrantyUntil: (rest.warrantyUntil as string | undefined) ?? null,
          priceMinor: (rest.priceMinor as number | undefined) ?? null,
          currency: (rest.currency as string | undefined) ?? null,
        }
        assets.push(asset)
        appendHistory(asset, 'created')
        return stamp(asset)
      },

      update: async ({
        assetId: id,
        workspaceId,
        ...rest
      }: { assetId: string; workspaceId?: string } & Record<string, unknown>) => {
        remember(workspaceId)
        const asset = find(id)
        // The diff before the assignment, so the timeline records what actually moved — the server
        // does the same and for the same reason: an update that changed nothing writes nothing.
        const changes = Object.entries(rest)
          .filter(([field, value]) => (asset as Record<string, unknown>)[field] !== value)
          .map(([field, value]) => ({ field, from: (asset as Record<string, unknown>)[field], to: value }))
        // `workspaceId` is not among the fields assigned: it is routing, not a field of the asset,
        // and letting a patch carry it means a demo can move a row to a workspace that is not real.
        Object.assign(asset, rest, { updatedAt: new Date().toISOString() })
        if (changes.length) appendHistory(asset, 'updated', { changes })
        return stamp(asset)
      },

      archive: async ({
        workspaceId,
        assetId: id,
        archived,
      }: {
        workspaceId?: string
        assetId: string
        archived?: boolean
      }) => {
        remember(workspaceId)
        const asset = find(id)
        const archiving = archived !== false
        // Somebody is still answerable for a held item; taking it out of the register does not
        // change that, it only stops anybody being able to find out. The server refuses this too.
        if (archiving && asset.custodianUserId)
          throw new MockApiError(
            'CONFLICT',
            'Somebody is still holding this item. Take it back before archiving it.',
            'inventory.asset.still_held',
          )
        // And an item at a repairer cannot leave the register either: money is committed and the
        // thing is out of the building. The server refuses this for the same reason.
        if (archiving && openRepairFor(id))
          throw new MockApiError(
            'CONFLICT',
            'This item is away for repair. Log the repair as returned before archiving it.',
            'inventory.asset.under_repair',
          )
        asset.archivedAt = archiving ? new Date().toISOString() : null
        asset.updatedAt = new Date().toISOString()
        appendHistory(asset, archiving ? 'retired' : 'restored')
        return stamp(asset)
      },
    },

    categories: {
      list: async ({ workspaceId, archived = false }: { workspaceId: string; archived?: boolean }) => {
        remember(workspaceId)
        return categories
          .filter((category) => (archived ? true : !category.archivedAt))
          .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
          .map(stamp)
      },

      create: async ({ workspaceId, name }: { workspaceId: string; name: string }) => {
        remember(workspaceId)
        // The server's unique index is what actually decides, and it answers a duplicate with a
        // sentence rather than a 500. The demo answers the same way.
        if (categories.some((category) => category.name === name))
          throw new MockApiError(
            'CONFLICT',
            `This workspace already has a category called “${name}”.`,
            'inventory.category.name_taken',
          )
        const now = new Date().toISOString()
        const category: Category = {
          id: categoryId(),
          workspaceId: '' as Asset['workspaceId'],
          name,
          // Appended, like the server: a new category joins the end of the sequence rather than
          // landing at the front tied with whatever is already there.
          order: appendedOrder(),
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        }
        categories.push(category)
        return stamp(category)
      },

      update: async ({
        workspaceId,
        categoryId: id,
        ...rest
      }: {
        workspaceId?: string
        categoryId: string
        name?: string
      }) => {
        remember(workspaceId)
        const category = findCategory(id)
        if (rest.name && categories.some((c) => c.id !== id && c.name === rest.name))
          throw new MockApiError(
            'CONFLICT',
            `This workspace already has a category called “${rest.name}”.`,
            'inventory.category.name_taken',
          )
        Object.assign(category, rest, { updatedAt: new Date().toISOString() })
        return stamp(category)
      },

      archive: async ({
        workspaceId,
        categoryId: id,
        archived,
      }: {
        workspaceId?: string
        categoryId: string
        archived?: boolean
      }) => {
        remember(workspaceId)
        const category = findCategory(id)
        // Nothing deletes: an asset filed under this category keeps naming it.
        const restoring = archived === false
        category.archivedAt = restoring ? null : new Date().toISOString()
        // A restore appends, like the server: the position it left with belongs to somebody else by
        // now, and the end of the list is the one place a person can find it again.
        if (restoring) category.order = appendedOrder()
        category.updatedAt = new Date().toISOString()
        return stamp(category)
      },

      /**
       * The sequence, rewritten from the ids — and the two refusals the server makes, because a
       * demo that cannot reproduce them is a demo of the happy path.
       *
       * An id this workspace does not have is `NOT_FOUND`; a list that does not name every live
       * category exactly once is the stale conflict, reason and all, so the settings page's rollback
       * can be exercised without a server.
       */
      reorder: async ({ workspaceId, categoryIds }: { workspaceId?: string; categoryIds: string[] }) => {
        remember(workspaceId)
        const named = new Set(categoryIds)
        if (named.size !== categoryIds.length)
          throw new MockApiError('BAD_REQUEST', 'That list of categories names the same one more than once.')
        for (const id of categoryIds) findCategory(id)
        const live = categories.filter((category) => !category.archivedAt)
        if (
          live.some((category) => !named.has(category.id)) ||
          categoryIds.some((id) => findCategory(id).archivedAt)
        )
          throw new MockApiError(
            'CONFLICT',
            'The categories changed while this list was open, so this order was not saved. Reload the list and arrange it again.',
            'inventory.category.order_stale',
          )
        const now = new Date().toISOString()
        for (const [index, id] of categoryIds.entries()) {
          const category = findCategory(id)
          if (category.order === index) continue
          category.order = index
          category.updatedAt = now
        }
        return categoryIds.map((id) => stamp(findCategory(id)))
      },
    },

    /**
     * The same invariant the server keeps, in one place rather than three.
     *
     * Each verb closes what has to close, opens what has to open, brings the three denormalised
     * columns on the asset into step and appends a history row. `transfer` does it in one step
     * rather than as a return followed by an assign, because two steps would leave the asset in
     * stock in between — visible in the list, and permanently visible in the timeline as a return
     * nobody performed.
     */
    custody: {
      history: async ({
        workspaceId,
        assetId: id,
        limit = 100,
      }: {
        workspaceId?: string
        assetId: string
        limit?: number
      }) => {
        remember(workspaceId)
        find(id)
        return (
          periods
            .filter((period) => period.assetId === id)
            /**
             * `effective_from` and then the id, which is the server's ordering and needs both.
             *
             * A hand-on closes one period and opens another *at the same instant* — that is what
             * makes them abut — so the timestamps are equal and there is no order between the two
             * rows without the id. Sorting on the timestamp alone showed the handover before the
             * return it replaced, at random, and the panel's "who had this before me" list opened
             * with the row that is still open.
             */
            .sort((a, b) => {
              if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1
              return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
            })
            .slice(0, limit)
            .map(stamp)
        )
      },

      byUser: async ({
        workspaceId,
        userId,
        limit = 50,
        cursor,
      }: {
        workspaceId: string
        userId: string
        limit?: number
        cursor?: string
      }) => {
        remember(workspaceId)
        return listAssets({ custodianUserId: userId, archived: false, sort: 'recent', limit, cursor })
      },

      assign: async ({
        workspaceId,
        assetId: id,
        userId,
        note,
      }: {
        workspaceId: string
        assetId: string
        userId: string
        note?: string | null
      }) => {
        remember(workspaceId)
        const asset = liveAsset(id)
        const open = openPeriodFor(id)
        if (open)
          throw new MockApiError(
            'CONFLICT',
            open.userId === userId
              ? 'They are already holding this item.'
              : 'Somebody else is holding this item. Hand it on, or take it back first.',
            'inventory.custody.already_held',
          )
        const at = new Date().toISOString()
        const period: CustodyPeriod = {
          id: periodId(),
          workspaceId: '' as Asset['workspaceId'],
          assetId: id,
          userId,
          note: note ?? null,
          effectiveFrom: at,
          effectiveTo: null,
          createdBy: PEOPLE.maya,
          createdAt: at,
        }
        periods.push(period)
        // The status is derived, never assumed: an item at a repairer stays `under_repair` when it
        // changes hands, because a repair does not release whoever is answerable for it.
        Object.assign(asset, { custodianUserId: userId, custodySince: at })
        restamp(asset)
        appendHistory(asset, 'assigned', { data: { userId, ...(note ? { note } : {}) } })
        return { asset: stamp(asset), period: stamp(period) }
      },

      transfer: async ({
        workspaceId,
        assetId: id,
        userId,
        note,
      }: {
        workspaceId: string
        assetId: string
        userId: string
        note?: string | null
      }) => {
        remember(workspaceId)
        const asset = liveAsset(id)
        const open = openPeriodFor(id)
        if (!open)
          throw new MockApiError(
            'CONFLICT',
            'Nobody is holding this item, so there is nothing to hand on. Assign it instead.',
            'inventory.custody.not_held',
          )
        if (open.userId === userId)
          throw new MockApiError(
            'CONFLICT',
            'They are already holding this item.',
            'inventory.custody.already_held',
          )
        // One instant for both halves, so the closing period and the opening one abut exactly and
        // the asset is never held by nobody for a microsecond.
        const at = new Date().toISOString()
        open.effectiveTo = at
        const period: CustodyPeriod = {
          id: periodId(),
          workspaceId: '' as Asset['workspaceId'],
          assetId: id,
          userId,
          note: note ?? null,
          effectiveFrom: at,
          effectiveTo: null,
          createdBy: PEOPLE.maya,
          createdAt: at,
        }
        periods.push(period)
        Object.assign(asset, { custodianUserId: userId, custodySince: at })
        restamp(asset)
        appendHistory(asset, 'transferred', {
          data: { userId, previousUserId: open.userId, ...(note ? { note } : {}) },
        })
        return { asset: stamp(asset), period: stamp(period) }
      },

      return: async ({
        workspaceId,
        assetId: id,
        note,
      }: {
        workspaceId: string
        assetId: string
        note?: string | null
      }) => {
        remember(workspaceId)
        const asset = liveAsset(id)
        const open = openPeriodFor(id)
        if (!open)
          throw new MockApiError(
            'CONFLICT',
            'Nobody is holding this item, so there is nothing to take back.',
            'inventory.custody.not_held',
          )
        const at = new Date().toISOString()
        open.effectiveTo = at
        Object.assign(asset, { custodianUserId: null, custodySince: null })
        restamp(asset)
        appendHistory(asset, 'returned', {
          data: { previousUserId: open.userId, ...(note ? { note } : {}) },
        })
        // Null, like the server: something closed and nothing opened.
        return { asset: stamp(asset), period: null }
      },
    },

    /**
     * Repairs, with the refusals the server makes and the status rule it keeps.
     *
     * A demo that lets you send the same laptop away twice, or that shows an item as back in the
     * office the moment its repair is logged as finished while somebody still has it, teaches an
     * audience that the product does those things.
     */
    repairs: {
      list: async ({
        workspaceId,
        assetId: forAsset,
        open,
        limit = 50,
        cursor,
      }: {
        workspaceId: string
        assetId?: string
        open?: boolean
        limit?: number
        cursor?: string
      }) => {
        remember(workspaceId)
        if (forAsset) find(forAsset)
        const all = repairs
          .filter((repair) => (forAsset ? repair.assetId === forAsset : true))
          .filter((repair) =>
            open === undefined ? true : open ? repair.returnedOn === null : repair.returnedOn !== null,
          )
          // Newest logged first, by id — the server's ordering, for the server's reason: an id is
          // uuidv7 and already carries the clock, where `sent_on` is a date two repairs share.
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        const rows = cursor ? all.filter((repair) => repair.id < decodeCursor(cursor, 'recent').i) : all
        const window = rows.slice(0, limit + 1)
        const items = window.slice(0, limit).map((repair) => {
          const asset = assets.find((row) => row.id === repair.assetId)
          // Joined, never stored: renaming an asset renames it here at once.
          return {
            ...stamp(repair),
            assetCode: asset?.code ?? '',
            assetName: asset?.name ?? '',
          }
        })
        const last = window.slice(0, limit).at(-1)
        const nextCursor = window.length > limit && last ? encodeCursor({ i: last.id, s: 'recent' }) : null
        return { items, nextCursor }
      },

      create: async ({
        workspaceId,
        assetId: id,
        summary,
        detail,
        vendor,
        costMinor,
        currency,
        sentOn,
      }: {
        workspaceId: string
        assetId: string
        summary: string
        detail?: string | null
        vendor?: string | null
        costMinor?: number | null
        currency?: string | null
        sentOn?: string
      }) => {
        remember(workspaceId)
        const asset = find(id)
        if (asset.archivedAt)
          throw new MockApiError(
            'CONFLICT',
            'This item is archived. Restore it before sending it for repair.',
            'inventory.repair.archived',
          )
        if (openRepairFor(id))
          throw new MockApiError(
            'CONFLICT',
            'This item is already away for repair. Log that one as returned first.',
            'inventory.repair.already_open',
          )
        const now = new Date().toISOString()
        const repair: Repair = {
          id: repairId(),
          workspaceId: '' as Asset['workspaceId'],
          assetId: id,
          summary,
          detail: detail ?? null,
          vendor: vendor ?? null,
          costMinor: costMinor ?? null,
          // A cost with no currency inherits the asset's, exactly as the server does — a number
          // with no unit is not a cost.
          currency: currency ?? (costMinor !== null && costMinor !== undefined ? asset.currency : null),
          sentOn: sentOn ?? today(),
          returnedOn: null,
          createdBy: PEOPLE.maya,
          createdAt: now,
          updatedAt: now,
        }
        repairs.push(repair)
        restamp(asset)
        appendHistory(asset, 'repair_logged', {
          data: { repairId: repair.id, summary, ...(repair.vendor ? { vendor: repair.vendor } : {}) },
        })
        return { repair: stamp(repair), asset: stamp(asset) }
      },

      update: async ({
        workspaceId,
        repairId: id,
        ...rest
      }: {
        workspaceId: string
        repairId: string
      } & Record<string, unknown>) => {
        remember(workspaceId)
        const repair = findRepair(id)
        // `returnedOn` is not patchable on the server: one column decides the derived status, so
        // exactly one procedure moves it.
        const { returnedOn: _ignored, ...patch } = rest
        Object.assign(repair, patch, { updatedAt: new Date().toISOString() })
        const asset = find(repair.assetId)
        // Same inheritance rule as `complete` and the server: only when an amount is arriving and
        // the repair has no currency at all.
        if (
          patch.currency === undefined &&
          repair.currency === null &&
          patch.costMinor !== undefined &&
          patch.costMinor !== null
        )
          repair.currency = asset.currency
        return { repair: stamp(repair), asset: stamp(asset) }
      },

      complete: async ({
        workspaceId,
        repairId: id,
        returnedOn,
        costMinor,
        currency,
      }: {
        workspaceId: string
        repairId: string
        returnedOn?: string
        costMinor?: number | null
        currency?: string | null
      }) => {
        remember(workspaceId)
        const repair = findRepair(id)
        if (repair.returnedOn)
          throw new MockApiError(
            'CONFLICT',
            'This repair is already logged as finished.',
            'inventory.repair.already_complete',
          )
        const back = returnedOn ?? today()
        if (back < repair.sentOn)
          throw new MockApiError(
            'CONFLICT',
            'A repair cannot come back before it was sent.',
            'inventory.repair.returned_before_sent',
          )
        const asset = find(repair.assetId)
        repair.returnedOn = back
        if (costMinor !== undefined) repair.costMinor = costMinor
        // The server's one inheritance rule: an amount is *arriving* and the repair has no currency
        // at all. Not "a cost exists", which would give a deliberately cleared currency back.
        if (currency !== undefined) repair.currency = currency ?? null
        else if (repair.currency === null && costMinor !== undefined && costMinor !== null)
          repair.currency = asset.currency
        repair.updatedAt = new Date().toISOString()
        // Back to whoever still holds it, or into stock — never blindly into stock.
        restamp(asset)
        appendHistory(asset, 'repair_completed', {
          data: {
            repairId: repair.id,
            summary: repair.summary,
            ...(repair.costMinor !== null ? { costMinor: repair.costMinor, currency: repair.currency } : {}),
          },
        })
        return { repair: stamp(repair), asset: stamp(asset) }
      },
    },

    /**
     * Files, recorded against an asset or one of its repairs.
     *
     * The bytes went to the shell's own mock file store through `uploadFile`; this only records
     * that the asset has them. The name comes from `describeFile`, because the real server asks
     * core for it and this file has no core to ask.
     */
    attachments: {
      list: async ({ workspaceId, assetId: id }: { workspaceId: string; assetId: string }) => {
        remember(workspaceId)
        find(id)
        return attachments
          .filter((row) => row.assetId === id)
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
          .map(stamp)
      },

      add: async ({
        workspaceId,
        assetId: id,
        fileIds,
        repairId: forRepair,
      }: {
        workspaceId: string
        assetId: string
        fileIds: string[]
        repairId?: string | null
      }) => {
        remember(workspaceId)
        find(id)
        if (forRepair) findRepair(forRepair)
        const added: Attachment[] = []
        for (const fileId of [...new Set(fileIds)]) {
          // The same file twice on one asset adds nothing rather than failing, exactly as the
          // server's `on conflict do nothing` does.
          if (attachments.some((row) => row.assetId === id && row.fileId === fileId)) continue
          const facts = await describeFile(fileId)
          const row: Attachment = {
            id: attachmentId(),
            workspaceId: '' as Asset['workspaceId'],
            assetId: id,
            repairId: forRepair ?? null,
            fileId,
            name: facts.name,
            mimeType: facts.mimeType,
            size: facts.size,
            uploadedBy: PEOPLE.maya,
            createdAt: new Date().toISOString(),
          }
          attachments.push(row)
          added.push(row)
          appendHistory(find(id), 'attachment_added', {
            data: { attachmentId: row.id, name: row.name, ...(forRepair ? { repairId: forRepair } : {}) },
          })
        }
        return added.map(stamp)
      },

      remove: async ({ workspaceId, attachmentId: id }: { workspaceId: string; attachmentId: string }) => {
        remember(workspaceId)
        const index = attachments.findIndex((row) => row.id === id)
        if (index < 0) throw new MockApiError('NOT_FOUND', 'Attachment not found')
        const [row] = attachments.splice(index, 1)
        appendHistory(find(row!.assetId), 'attachment_removed', {
          data: { attachmentId: row!.id, name: row!.name },
        })
        return { id: row!.id }
      },
    },

    /**
     * The register in numbers.
     *
     * `outForRepair` is a number here rather than null because the shell's mock has every
     * capability on; the *shape* is what matters — a screen that reads it has to handle both.
     */
    stats: {
      summary: async ({ workspaceId }: { workspaceId: string }) => {
        remember(workspaceId)
        const live = assets.filter((asset) => !asset.archivedAt)
        const byStatus = {
          in_stock: 0,
          assigned: 0,
          reserved: 0,
          under_repair: 0,
          lost: 0,
          retired: 0,
        } satisfies Record<AssetStatus, number>
        for (const asset of live) byStatus[asset.status] += 1
        const summary: InventoryStats = {
          total: live.length,
          archived: assets.length - live.length,
          byStatus,
          outForRepair: repairs.filter((repair) => repair.returnedOn === null).length,
          unassigned: live.filter((asset) => !asset.custodianUserId).length,
        }
        return summary
      },
    },
  }
}
