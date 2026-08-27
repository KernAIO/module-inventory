import { describe, expect, it } from 'vitest'
import { moveBy, placementOf, sameOrder } from './reorder.js'

/**
 * The arithmetic behind dragging a category, and behind the two buttons that do the same thing
 * without a pointer.
 *
 * The settings page is a `.svelte` file and cannot be unit-tested here, which is exactly why this
 * arithmetic does not live in it. Every case below is one somebody will actually reach: the first
 * row cannot go up, the last cannot go down, a drag that ends where it started must cost nothing,
 * and a row that was archived in another tab is not in the list any more.
 */
const list = (...ids: string[]) => ids.map((id) => ({ id, name: id.toUpperCase() }))
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id)

describe('moving a row', () => {
  it('moves one up', () => {
    expect(ids(moveBy(list('a', 'b', 'c'), 'c', -1))).toEqual(['a', 'c', 'b'])
  })

  it('moves one down', () => {
    expect(ids(moveBy(list('a', 'b', 'c'), 'a', 1))).toEqual(['b', 'a', 'c'])
  })

  it('moves one to the top and to the bottom', () => {
    expect(ids(moveBy(list('a', 'b', 'c', 'd'), 'd', -3))).toEqual(['d', 'a', 'b', 'c'])
    expect(ids(moveBy(list('a', 'b', 'c', 'd'), 'a', 3))).toEqual(['b', 'c', 'd', 'a'])
  })

  /**
   * Clamped rather than refused. *Move up* on the row that is already first is a button somebody
   * will press, and it is not a mistake — the answer is that it is already first.
   */
  it('clamps a move that would fall off either end', () => {
    expect(ids(moveBy(list('a', 'b', 'c'), 'c', -99))).toEqual(['c', 'a', 'b'])
    expect(ids(moveBy(list('a', 'b', 'c'), 'a', 99))).toEqual(['b', 'c', 'a'])
  })

  /**
   * The same array back, by reference — the caller reads that as "nothing to send". An equal copy
   * would pass every assertion above and post a reorder every time somebody pressed the button on
   * the row that cannot move.
   */
  it('gives back the very same list when nothing moves', () => {
    const items = list('a', 'b', 'c')
    expect(moveBy(items, 'a', -1)).toBe(items)
    expect(moveBy(items, 'c', 1)).toBe(items)
    expect(moveBy(items, 'b', 0)).toBe(items)
    expect(moveBy(items, 'nobody', -1)).toBe(items)
    expect(moveBy([], 'a', 1)).toEqual([])
  })

  it('leaves the list it was given alone', () => {
    const items = list('a', 'b', 'c')
    moveBy(items, 'a', 2)
    expect(ids(items)).toEqual(['a', 'b', 'c'])
  })

  it('moves the only row nowhere', () => {
    const items = list('a')
    expect(moveBy(items, 'a', -1)).toBe(items)
    expect(moveBy(items, 'a', 1)).toBe(items)
  })
})

describe('saying where a row landed', () => {
  it('names the row it now follows, rather than a position', () => {
    expect(placementOf(list('a', 'b', 'c'), 'b')).toEqual({ at: 'after', previous: { id: 'a', name: 'A' } })
  })

  it('calls the ends the ends', () => {
    expect(placementOf(list('a', 'b', 'c'), 'a')).toEqual({ at: 'first' })
    expect(placementOf(list('a', 'b', 'c'), 'c')).toEqual({ at: 'last' })
  })

  it('calls the only row first, which is true and reads better than last', () => {
    expect(placementOf(list('a'), 'a')).toEqual({ at: 'first' })
  })

  it('says a row that is no longer in the list is gone, rather than guessing', () => {
    // Somebody archived it in another tab while this page was open.
    expect(placementOf(list('a', 'b'), 'c')).toEqual({ at: 'gone' })
  })
})

describe('whether anything actually changed', () => {
  it('sees a drag that ended where it started', () => {
    expect(sameOrder(list('a', 'b', 'c'), list('a', 'b', 'c'))).toBe(true)
  })

  it('sees a real move, a longer list and a different membership', () => {
    expect(sameOrder(list('a', 'b', 'c'), list('a', 'c', 'b'))).toBe(false)
    expect(sameOrder(list('a', 'b'), list('a', 'b', 'c'))).toBe(false)
    expect(sameOrder(list('a', 'b'), list('a', 'z'))).toBe(false)
  })

  it('calls two empty lists the same', () => {
    expect(sameOrder([], [])).toBe(true)
  })
})
