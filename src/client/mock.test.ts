import { describe, expect, it } from 'vitest'
import { inventoryContract } from '../contract/index.js'
import { createMockInventoryApi } from './mock.js'

/**
 * The demo, held to the server's behaviour.
 *
 * A mock is the environment the product is *shown* in, so a mock that disagrees with the server is
 * a demo that argues with its own controls — and every disagreement here was a real one: seed order
 * where the server sorts newest first, `INV-0013` for the seventh asset, `sort`/`categoryId`/
 * `custodianUserId` ignored, and an unrecognised cursor quietly serving page one for ever.
 *
 * The cursor assertions are the load-bearing ones. `src/server/services/assets.ts` answers a marker
 * it did not issue with `BAD_REQUEST`; a mock that answers it with page one turns a bug into an
 * endless "Load more" that nobody meets until production.
 */
const WS = '01920000-0000-7000-8000-0000000000ff'

const codes = (items: { code: string }[]) => items.map((a) => a.code)

/**
 * The mock is cast to the contract's client type, so **nothing type-checks it against the contract**
 * — a procedure the mock does not implement is `undefined` at the call site and a demo that throws
 * "not a function" on a screen that works everywhere else. `stats` was written as a bare function
 * rather than `stats.summary` while this test was being added, and the cast said nothing.
 *
 * The contract is walked as data, the same way `src/module.test.ts` walks it against the router.
 */
const leaves = (node: unknown, path: string[] = []): string[] => {
  if (typeof node === 'object' && node !== null && '~orpc' in node) return [path.join('.')]
  if (typeof node !== 'object' || node === null) return []
  return Object.entries(node).flatMap(([key, value]) => leaves(value, [...path, key]))
}

const at = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], root)

describe('the mock and the contract agree', () => {
  it('implements every procedure the contract promises', () => {
    const api = createMockInventoryApi()
    const missing = leaves(inventoryContract).filter((name) => typeof at(api, name) !== 'function')
    expect(missing, 'procedures the demo would throw on').toEqual([])
  })
})

describe('mock assets.list', () => {
  it('opens on what was added last, like the server’s default sort', async () => {
    const api = createMockInventoryApi()
    const { items } = await api.assets.list({ workspaceId: WS })
    // INV-0006 is archived and therefore absent; the rest are newest first.
    expect(codes(items)).toEqual(['INV-0005', 'INV-0004', 'INV-0003', 'INV-0002', 'INV-0001'])
  })

  it('honours sort=code and sort=name, which it used to ignore', async () => {
    const api = createMockInventoryApi()
    expect(codes((await api.assets.list({ workspaceId: WS, sort: 'code' })).items)).toEqual([
      'INV-0001',
      'INV-0002',
      'INV-0003',
      'INV-0004',
      'INV-0005',
    ])
    const byName = (await api.assets.list({ workspaceId: WS, sort: 'name' })).items
    expect(byName.map((a) => a.name)).toEqual([...byName.map((a) => a.name)].sort())
  })

  it('honours the archived and status filters', async () => {
    const api = createMockInventoryApi()
    expect(codes((await api.assets.list({ workspaceId: WS, archived: true })).items)).toContain('INV-0006')
    const assigned = await api.assets.list({ workspaceId: WS, status: 'assigned' })
    expect(assigned.items.every((a) => a.status === 'assigned')).toBe(true)
    expect(assigned.items).toHaveLength(2)
  })

  it('honours categoryId and custodianUserId, which it used to ignore', async () => {
    const api = createMockInventoryApi()
    const none = await api.assets.list({
      workspaceId: WS,
      categoryId: '01920000-0000-7000-8000-00000000aaaa',
    })
    expect(none.items).toEqual([])
    const nobody = await api.assets.list({
      workspaceId: WS,
      custodianUserId: '01920000-0000-7000-8000-00000000bbbb',
    })
    expect(nobody.items).toEqual([])
  })

  it('pages through every row exactly once and then stops', async () => {
    const api = createMockInventoryApi()
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 20; guard++) {
      const page = await api.assets.list({ workspaceId: WS, limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...codes(page.items))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(['INV-0005', 'INV-0004', 'INV-0003', 'INV-0002', 'INV-0001'])
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('reports no next page when the last page is exactly full', async () => {
    const api = createMockInventoryApi()
    const page = await api.assets.list({ workspaceId: WS, limit: 5 })
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBe(null)
  })

  it('refuses a page marker it did not issue, rather than serving page one for ever', async () => {
    const api = createMockInventoryApi()
    await expect(api.assets.list({ workspaceId: WS, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      api.assets.list({ workspaceId: WS, cursor: btoa(JSON.stringify({ i: 'nope', s: 'recent' })) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses a marker issued under a different sort', async () => {
    const api = createMockInventoryApi()
    const first = await api.assets.list({ workspaceId: WS, limit: 2, sort: 'recent' })
    expect(first.nextCursor).toBeTruthy()
    await expect(
      api.assets.list({ workspaceId: WS, limit: 2, sort: 'code', cursor: first.nextCursor as string }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('ends the list when the bookmarked row is gone, rather than failing', async () => {
    const api = createMockInventoryApi()
    const first = await api.assets.list({ workspaceId: WS, limit: 2 })
    const bookmarked = first.items.at(-1)
    expect(bookmarked).toBeTruthy()
    const id = (bookmarked as { id: string }).id
    // An item somebody is holding cannot be archived — the server refuses it, and so does this — so
    // it goes back into stock first. Two real calls rather than a workaround: the assertion is
    // about the page after a bookmarked row, and both halves of getting there have to be legal.
    if ((bookmarked as { custodianUserId: string | null }).custodianUserId)
      await api.custody.return({ workspaceId: WS, assetId: id })
    // Archiving the bookmarked row still leaves it findable by id, so the page continues; a row the
    // mock genuinely cannot find is the "ends quietly" branch, and an unknown *id* is refused above.
    await api.assets.archive({ assetId: id })
    const next = await api.assets.list({ workspaceId: WS, limit: 2, cursor: first.nextCursor as string })
    expect(next.items.every((a) => !codes(first.items).includes(a.code))).toBe(true)
  })
})

describe('mock assets.create', () => {
  it('continues the tag sequence from the seeds', async () => {
    const api = createMockInventoryApi()
    // It issued INV-0013 here: one counter was numbering both the ids and the tags.
    expect((await api.assets.create({ workspaceId: WS, name: 'Standing desk' })).code).toBe('INV-0007')
    expect((await api.assets.create({ workspaceId: WS, name: 'Label printer' })).code).toBe('INV-0008')
  })

  it('puts what was just created at the top of the default list', async () => {
    const api = createMockInventoryApi()
    await api.assets.create({ workspaceId: WS, name: 'Standing desk' })
    const { items } = await api.assets.list({ workspaceId: WS })
    expect(items[0]?.name).toBe('Standing desk')
  })
})

describe('mock assets.update and archive', () => {
  it('patches only what it was given', async () => {
    const api = createMockInventoryApi()
    const [first] = (await api.assets.list({ workspaceId: WS })).items
    const updated = await api.assets.update({
      workspaceId: WS,
      assetId: (first as { id: string }).id,
      name: 'Renamed',
    })
    expect(updated.name).toBe('Renamed')
    expect(updated.code).toBe(first?.code)
    // Routing, not a field of the asset: a patch must not be able to move a row between workspaces.
    expect(updated.workspaceId).toBe(first?.workspaceId)
  })

  it('archives and restores the same row', async () => {
    const api = createMockInventoryApi()
    const [first] = (await api.assets.list({ workspaceId: WS })).items
    const id = (first as { id: string }).id
    expect((await api.assets.archive({ assetId: id })).archivedAt).toBeTruthy()
    expect(codes((await api.assets.list({ workspaceId: WS })).items)).not.toContain(first?.code)
    expect((await api.assets.archive({ assetId: id, archived: false })).archivedAt).toBe(null)
    expect(codes((await api.assets.list({ workspaceId: WS })).items)).toContain(first?.code)
  })

  it('reports a missing asset as NOT_FOUND', async () => {
    const api = createMockInventoryApi()
    await expect(api.assets.get({ assetId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses to archive something somebody is still holding, exactly as the server does', async () => {
    const api = createMockInventoryApi()
    const held = (await api.assets.list({ workspaceId: WS })).items.find((a) => a.custodianUserId)
    expect(held).toBeTruthy()
    await expect(
      api.assets.archive({ workspaceId: WS, assetId: (held as { id: string }).id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

/**
 * Categories, which the mock had none of at all.
 *
 * `assets.list` has taken a `categoryId` filter since the module existed, so a demo with no
 * categories was a demo of a control with exactly one possible answer.
 */
describe('mock categories', () => {
  it('hides archived categories unless they are asked for, and orders them for a picker', async () => {
    const api = createMockInventoryApi()
    const live = await api.categories.list({ workspaceId: WS })
    expect(live.map((c) => c.name)).toEqual(['Laptops', 'Displays', 'Furniture', 'Cameras'])
    expect((await api.categories.list({ workspaceId: WS, archived: true })).map((c) => c.name)).toContain(
      'Phones',
    )
  })

  it('leaves an asset filed under an archived category still naming it', async () => {
    // The whole reason categories archive rather than delete: INV-0003 is seeded under "Phones".
    const api = createMockInventoryApi()
    const all = await api.categories.list({ workspaceId: WS, archived: true })
    const phones = all.find((c) => c.name === 'Phones')
    const { items } = await api.assets.list({ workspaceId: WS, categoryId: phones?.id })
    expect(items.map((a) => a.code)).toEqual(['INV-0003'])
  })

  it('refuses a duplicate name with the sentence the server uses, not a 500', async () => {
    const api = createMockInventoryApi()
    await expect(api.categories.create({ workspaceId: WS, name: 'Laptops' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('creates, renames and archives without ever deleting', async () => {
    const api = createMockInventoryApi()
    const made = await api.categories.create({ workspaceId: WS, name: 'Tools' })
    expect(made.name).toBe('Tools')
    const renamed = await api.categories.update({ workspaceId: WS, categoryId: made.id, name: 'Hand tools' })
    expect(renamed.name).toBe('Hand tools')
    await api.categories.archive({ workspaceId: WS, categoryId: made.id })
    expect((await api.categories.list({ workspaceId: WS })).map((c) => c.id)).not.toContain(made.id)
    // Still there, which is the point — restoring is the same procedure.
    await api.categories.archive({ workspaceId: WS, categoryId: made.id, archived: false })
    expect((await api.categories.list({ workspaceId: WS })).map((c) => c.id)).toContain(made.id)
  })

  /**
   * A new category joins the **end**, and so does a restored one.
   *
   * The demo has to agree with the server about this or the settings page contradicts itself in
   * exactly the environment the product is shown in: a category added while somebody watches
   * appearing in the middle of a list they just arranged is the defect the *Position* field caused.
   */
  it('appends a new category, and a restored one, rather than dropping it into the middle', async () => {
    const api = createMockInventoryApi()
    const made = await api.categories.create({ workspaceId: WS, name: 'Tools' })
    expect((await api.categories.list({ workspaceId: WS })).map((c) => c.name)).toEqual([
      'Laptops',
      'Displays',
      'Furniture',
      'Cameras',
      'Tools',
    ])

    const all = await api.categories.list({ workspaceId: WS, archived: true })
    const phones = all.find((c) => c.name === 'Phones')
    await api.categories.archive({ workspaceId: WS, categoryId: phones?.id ?? '', archived: false })
    const live = await api.categories.list({ workspaceId: WS })
    expect(live.at(-1)?.name, 'restored at the end, not back on its old number').toBe('Phones')
    expect(new Set(live.map((c) => c.order)).size, 'and no two live categories share a place').toBe(
      live.length,
    )
    expect(made.name).toBe('Tools')
  })

  /**
   * Reordering, including both refusals — a demo that can only show the happy path cannot exercise
   * the settings page's rollback, which is the half of the feature nobody sees until it matters.
   */
  it('reorders the sequence, and refuses a list that no longer describes the workspace', async () => {
    const api = createMockInventoryApi()
    const live = await api.categories.list({ workspaceId: WS })
    const ids = live.map((c) => c.id)

    const moved = await api.categories.reorder({
      workspaceId: WS,
      categoryIds: [ids[3] as string, ...ids.slice(0, 3)],
    })
    expect(moved.map((c) => c.name)).toEqual(['Cameras', 'Laptops', 'Displays', 'Furniture'])
    expect((await api.categories.list({ workspaceId: WS })).map((c) => c.name)).toEqual([
      'Cameras',
      'Laptops',
      'Displays',
      'Furniture',
    ])

    await expect(
      api.categories.reorder({ workspaceId: WS, categoryIds: ids.slice(0, 2) }),
    ).rejects.toMatchObject({ code: 'CONFLICT', data: { reason: 'inventory.category.order_stale' } })

    await expect(
      api.categories.reorder({
        workspaceId: WS,
        categoryIds: [...ids, '01920000-0000-7000-8000-0000000000ff'],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Neither refusal wrote anything.
    expect((await api.categories.list({ workspaceId: WS })).map((c) => c.name)).toEqual([
      'Cameras',
      'Laptops',
      'Displays',
      'Furniture',
    ])
  })
})

/**
 * Custody, held to the same invariant the server keeps.
 *
 * A demo that lets you assign the same laptop twice teaches somebody the product does, and the
 * three refusals below are the ones a person actually meets.
 */
describe('mock custody', () => {
  const freeAsset = async (api: ReturnType<typeof createMockInventoryApi>) => {
    const { items } = await api.assets.list({ workspaceId: WS })
    const free = items.find((a) => !a.custodianUserId)
    expect(free).toBeTruthy()
    return free as (typeof items)[number]
  }

  it('moves the custodian, the date and the status together on assign', async () => {
    const api = createMockInventoryApi()
    const asset = await freeAsset(api)
    const { asset: after, period } = await api.custody.assign({
      workspaceId: WS,
      assetId: asset.id,
      userId: '01920000-0000-7000-8000-000000000002',
      note: 'For the shoot',
    })
    expect(after.custodianUserId).toBe('01920000-0000-7000-8000-000000000002')
    expect(after.status).toBe('assigned')
    expect(after.custodySince).toBeTruthy()
    expect(period?.effectiveTo).toBe(null)
    expect(period?.note).toBe('For the shoot')
  })

  it('clears all three on return, and opens nothing', async () => {
    const api = createMockInventoryApi()
    const asset = await freeAsset(api)
    await api.custody.assign({
      workspaceId: WS,
      assetId: asset.id,
      userId: '01920000-0000-7000-8000-000000000002',
    })
    const { asset: after, period } = await api.custody.return({ workspaceId: WS, assetId: asset.id })
    expect(after.custodianUserId).toBe(null)
    expect(after.custodySince).toBe(null)
    expect(after.status).toBe('in_stock')
    expect(period).toBe(null)
  })

  it('hands on in one step, leaving no stretch during which nobody held it', async () => {
    const api = createMockInventoryApi()
    const asset = await freeAsset(api)
    await api.custody.assign({
      workspaceId: WS,
      assetId: asset.id,
      userId: '01920000-0000-7000-8000-000000000002',
    })
    await api.custody.transfer({
      workspaceId: WS,
      assetId: asset.id,
      userId: '01920000-0000-7000-8000-000000000003',
    })
    const periods = await api.custody.history({ workspaceId: WS, assetId: asset.id })
    expect(periods).toHaveLength(2)
    const [open, closed] = periods
    expect(open?.effectiveTo).toBe(null)
    // A return followed by an assign would leave a gap here, and a return nobody performed in the
    // timeline. One instant for both halves is what makes them abut.
    expect(closed?.effectiveTo).toBe(open?.effectiveFrom)
  })

  it('refuses the three things the server refuses', async () => {
    const api = createMockInventoryApi()
    const asset = await freeAsset(api)
    const dan = '01920000-0000-7000-8000-000000000002'
    await expect(
      api.custody.transfer({ workspaceId: WS, assetId: asset.id, userId: dan }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(api.custody.return({ workspaceId: WS, assetId: asset.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await api.custody.assign({ workspaceId: WS, assetId: asset.id, userId: dan })
    await expect(
      api.custody.assign({ workspaceId: WS, assetId: asset.id, userId: dan }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('answers what one person is holding', async () => {
    const api = createMockInventoryApi()
    const dan = '01920000-0000-7000-8000-000000000002'
    const { items } = await api.custody.byUser({ workspaceId: WS, userId: dan })
    expect(items.map((a) => a.code)).toEqual(['INV-0001'])
  })
})

describe('mock assets.history', () => {
  it('reads newest first and records what each verb did', async () => {
    const api = createMockInventoryApi()
    const first = (await api.assets.list({ workspaceId: WS, sort: 'code' })).items[0]
    const { items } = await api.assets.history({ workspaceId: WS, assetId: (first as { id: string }).id })
    // Newest first, and the two repair entries are part of it: the seeded asset was bought,
    // handed over, edited, handed on, and had its battery replaced.
    expect(items.map((e) => e.action)).toEqual([
      'repair_completed',
      'repair_logged',
      'transferred',
      'updated',
      'assigned',
      'created',
    ])
    // The diff is a field, a before and an after — what `Timeline.svelte` turns into a sentence.
    expect(items.find((e) => e.action === 'updated')?.changes[0]).toMatchObject({
      field: 'warrantyUntil',
      to: '2027-03-14',
    })
  })

  it('pages by id with the cursor the server issues, and then stops', async () => {
    const api = createMockInventoryApi()
    const first = (await api.assets.list({ workspaceId: WS, sort: 'code' })).items[0]
    const id = (first as { id: string }).id
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await api.assets.history({
        workspaceId: WS,
        assetId: id,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.items.map((e) => e.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('refuses a page marker it did not issue', async () => {
    const api = createMockInventoryApi()
    const first = (await api.assets.list({ workspaceId: WS })).items[0]
    await expect(
      api.assets.history({ workspaceId: WS, assetId: (first as { id: string }).id, cursor: 'nope' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

/**
 * Repairs, and the one rule a demo gets wrong by accident: a repair is not custody.
 *
 * Every assertion here has a matching one in `src/server/inventory.int.test.ts`. A demo that shows
 * an item as back in the office the moment its repair is completed — while somebody still holds it
 * — teaches an audience that the product releases people from what they are answerable for.
 */
describe('mock repairs', () => {
  const inStock = async (api: ReturnType<typeof createMockInventoryApi>) =>
    (await api.assets.list({ workspaceId: WS, status: 'in_stock' })).items[0] as { id: string }

  it('seeds an open repair for the item the seeds call under_repair', async () => {
    const api = createMockInventoryApi()
    const away = (await api.assets.list({ workspaceId: WS, status: 'under_repair' })).items
    expect(away.map((a) => a.code)).toEqual(['INV-0003'])
    const { items } = await api.repairs.list({ workspaceId: WS, open: true })
    // A status column and a Repairs tab that disagree about the same item is the failure this
    // seeding exists to prevent.
    expect(items.map((r) => r.assetId)).toEqual([away[0]?.id])
    expect(items[0]?.assetCode).toBe('INV-0003')
  })

  it('sends an item away, and refuses a second one while it is gone', async () => {
    const api = createMockInventoryApi()
    const asset = await inStock(api)
    const { asset: away } = await api.repairs.create({
      workspaceId: WS,
      assetId: asset.id,
      summary: 'Wobbly hinge',
    })
    expect(away.status).toBe('under_repair')
    await expect(
      api.repairs.create({ workspaceId: WS, assetId: asset.id, summary: 'Again' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('puts an item back to whoever still holds it, not into stock', async () => {
    const api = createMockInventoryApi()
    const dan = '01920000-0000-7000-8000-000000000002'
    const asset = await inStock(api)
    await api.custody.assign({ workspaceId: WS, assetId: asset.id, userId: dan })
    const { repair } = await api.repairs.create({
      workspaceId: WS,
      assetId: asset.id,
      summary: 'New battery',
    })
    // Still Dan's while it is away — a repair moves where a thing is, not who answers for it.
    const during = await api.assets.get({ workspaceId: WS, assetId: asset.id })
    expect({ status: during.status, holder: during.custodianUserId }).toEqual({
      status: 'under_repair',
      holder: dan,
    })
    const { asset: back } = await api.repairs.complete({ workspaceId: WS, repairId: repair.id })
    expect({ status: back.status, holder: back.custodianUserId }).toEqual({
      status: 'assigned',
      holder: dan,
    })
  })

  it('refuses completing the same repair twice, and a return before the send', async () => {
    const api = createMockInventoryApi()
    const asset = await inStock(api)
    const { repair } = await api.repairs.create({
      workspaceId: WS,
      assetId: asset.id,
      summary: 'Cracked case',
      sentOn: '2026-06-01',
    })
    await expect(
      api.repairs.complete({ workspaceId: WS, repairId: repair.id, returnedOn: '2026-05-01' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await api.repairs.complete({ workspaceId: WS, repairId: repair.id, returnedOn: '2026-06-10' })
    await expect(api.repairs.complete({ workspaceId: WS, repairId: repair.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('refuses archiving something that is away for repair', async () => {
    const api = createMockInventoryApi()
    const asset = await inStock(api)
    await api.repairs.create({ workspaceId: WS, assetId: asset.id, summary: 'Screen' })
    await expect(
      api.assets.archive({ workspaceId: WS, assetId: asset.id, archived: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('mock attachments', () => {
  it('keeps a repair’s paperwork under the repair and the rest under the asset', async () => {
    const api = createMockInventoryApi()
    const first = (await api.assets.list({ workspaceId: WS, sort: 'code' })).items[0] as { id: string }
    const rows = await api.attachments.list({ workspaceId: WS, assetId: first.id })
    expect(rows.map((r) => r.name)).toEqual(['Purchase receipt.pdf', 'Repair invoice.pdf'])
    // One key, one query, grouped in the browser — which is what the panel does.
    expect(rows.filter((r) => r.repairId === null)).toHaveLength(1)
    expect(rows.filter((r) => r.repairId !== null)).toHaveLength(1)
  })

  it('adds a file once however many times the same id arrives', async () => {
    const api = createMockInventoryApi()
    const first = (await api.assets.list({ workspaceId: WS, sort: 'code' })).items[0] as { id: string }
    const fileId = '01920000-0000-7000-8007-0000000000aa'
    const added = await api.attachments.add({ workspaceId: WS, assetId: first.id, fileIds: [fileId] })
    expect(added).toHaveLength(1)
    // The server's `on conflict do nothing`: pressing the button twice adds nothing the second time
    // rather than failing at somebody.
    expect(await api.attachments.add({ workspaceId: WS, assetId: first.id, fileIds: [fileId] })).toEqual([])
  })

  it('detaches one file and leaves the rest', async () => {
    const api = createMockInventoryApi()
    const first = (await api.assets.list({ workspaceId: WS, sort: 'code' })).items[0] as { id: string }
    const rows = await api.attachments.list({ workspaceId: WS, assetId: first.id })
    const target = rows[0] as { id: string }
    expect(await api.attachments.remove({ workspaceId: WS, attachmentId: target.id })).toEqual({
      id: target.id,
    })
    const left = await api.attachments.list({ workspaceId: WS, assetId: first.id })
    expect(left.map((r) => r.id)).not.toContain(target.id)
    expect(left).toHaveLength(rows.length - 1)
  })
})

describe('mock stats.summary', () => {
  it('counts live rows, keeps archived ones beside them, and zero-fills every status', async () => {
    const api = createMockInventoryApi()
    const stats = await api.stats.summary({ workspaceId: WS })
    // Five live seeds and one archived — the same split the default list shows.
    expect({ total: stats.total, archived: stats.archived }).toEqual({ total: 5, archived: 1 })
    expect(Object.keys(stats.byStatus).sort()).toEqual([
      'assigned',
      'in_stock',
      'lost',
      'reserved',
      'retired',
      'under_repair',
    ])
    expect(stats.byStatus.lost).toBe(0)
  })

  it('agrees with the status column about what is away', async () => {
    const api = createMockInventoryApi()
    const stats = await api.stats.summary({ workspaceId: WS })
    // Two ways of asking one question — the cached status column and the repair rows — and they
    // agree because the status is derived from those rows rather than written beside them.
    expect(stats.outForRepair).toBe(stats.byStatus.under_repair)
  })

  it('counts what nobody is holding', async () => {
    const api = createMockInventoryApi()
    const before = await api.stats.summary({ workspaceId: WS })
    const free = (await api.assets.list({ workspaceId: WS, status: 'in_stock' })).items[0] as {
      id: string
    }
    await api.custody.assign({
      workspaceId: WS,
      assetId: free.id,
      userId: '01920000-0000-7000-8000-000000000002',
    })
    const after = await api.stats.summary({ workspaceId: WS })
    expect(after.unassigned).toBe(before.unassigned - 1)
  })
})
