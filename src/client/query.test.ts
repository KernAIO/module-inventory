import { describe, expect, it } from 'vitest'
import { inventoryKeys } from './query.js'

/**
 * The realtime contract, held to by a test because nothing else can hold it.
 *
 * `realtime.svelte.ts` calls `invalidateQueries({ queryKey: [module, entity] })` with whatever the
 * server put in the change event, and `src/server/router.ts` emits `entity: 'asset'`. A key whose
 * second segment is anything else is simply never invalidated — no error, no warning, just a list
 * that stops updating. That is what `['inventory', 'assets', …]` did: the detail panel refreshed
 * and the list behind it did not, and the only way to see it was to write to the module from a
 * second browser.
 *
 * Proven against `partialMatchKey` from `@tanstack/query-core`, which is what
 * `invalidateQueries` filters with; asserted here on the segment itself, so the test does not need
 * the query runtime to state the rule it is protecting.
 */
const WS = '01920000-0000-7000-8000-000000000001'

/** Must equal the `entity` string in `src/server/router.ts`'s `notify.change` call. */
const ENTITY = 'asset'

describe('inventoryKeys', () => {
  it('names the entity exactly as the server emits it, on every key', () => {
    for (const [name, key] of [
      ['assets', inventoryKeys.assets(WS)],
      ['assets(filtered)', inventoryKeys.assets(WS, { archived: false })],
      ['asset', inventoryKeys.asset(WS, 'some-id')],
    ] as const)
      expect({ name, module: key[0], entity: key[1] }).toEqual({
        name,
        module: 'inventory',
        entity: ENTITY,
      })
  })

  it('puts the list and the row under one prefix, so one change event reaches both', () => {
    const list = inventoryKeys.assets(WS, { archived: false })
    const row = inventoryKeys.asset(WS, 'some-id')
    expect(list.slice(0, 2)).toEqual(row.slice(0, 2))
  })

  it('makes a filtered list a different question from an unfiltered one', () => {
    expect(inventoryKeys.assets(WS, { archived: true })).not.toEqual(
      inventoryKeys.assets(WS, { archived: false }),
    )
    expect(inventoryKeys.assets(WS, { archived: false })).not.toEqual(inventoryKeys.assets(WS))
  })

  it('does not let two workspaces share a cache entry', () => {
    expect(inventoryKeys.assets('ws-a')).not.toEqual(inventoryKeys.assets('ws-b'))
  })

  it('starts every key with the module, so one invalidation can clear all of Inventory', () => {
    for (const key of [inventoryKeys.all, inventoryKeys.assets(WS), inventoryKeys.asset(WS, 'id')])
      expect(key[0]).toBe('inventory')
  })
})
