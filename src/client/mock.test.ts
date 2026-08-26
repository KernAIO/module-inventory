import { describe, expect, it } from 'vitest'
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
    // Archiving the bookmarked row still leaves it findable by id, so the page continues; a row the
    // mock genuinely cannot find is the "ends quietly" branch, and an unknown *id* is refused above.
    await api.assets.archive({ assetId: (bookmarked as { id: string }).id })
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
})
