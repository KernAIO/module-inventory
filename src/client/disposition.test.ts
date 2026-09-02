import { describe, expect, it } from 'vitest'
import { dispositionActions } from './disposition.js'

/**
 * What the row menu and the panel are allowed to offer, and it has to be the same answer twice.
 *
 * A decision rather than rendering: *Reinstate* on an item in service produces a 409 on every
 * press, and *Retire* beside *Reinstate* asks a question the row has already answered.
 */
describe('dispositionActions', () => {
  it('offers marking lost and retiring while the item is in service', () => {
    expect(dispositionActions({ disposition: null, archived: false, may: true })).toEqual(['lost', 'retire'])
  })

  it('offers only reinstating once somebody has said what happened to it', () => {
    expect(dispositionActions({ disposition: 'lost', archived: false, may: true })).toEqual(['reinstate'])
    expect(dispositionActions({ disposition: 'retired', archived: false, may: true })).toEqual(['reinstate'])
  })

  it('offers nothing without the permission — hidden, not disabled', () => {
    expect(dispositionActions({ disposition: null, archived: false, may: false })).toEqual([])
    expect(dispositionActions({ disposition: 'lost', archived: false, may: false })).toEqual([])
  })

  it('offers nothing on an archived item, whose menu already says Restore', () => {
    // The server refuses all three with `inventory.asset.archived`; restoring is the way back.
    expect(dispositionActions({ disposition: null, archived: true, may: true })).toEqual([])
    expect(dispositionActions({ disposition: 'retired', archived: true, may: true })).toEqual([])
  })
})
