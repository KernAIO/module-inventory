import { describe, expect, it } from 'vitest'
import { custodyActions } from './custody.js'

/**
 * What the panel is allowed to offer.
 *
 * A decision rather than rendering, and wrong in a way nothing else would catch: a button that
 * always produces a conflict is a door that will not open. What a stored uuid reads as is the
 * neighbouring question and lives in `members.test.ts`, beside the file that answers it.
 */
describe('custodyActions', () => {
  const live = { archived: false, disposed: false, may: true }

  it('offers handing over when nobody has it, and handing on or back when somebody does', () => {
    expect(custodyActions({ ...live, held: false })).toEqual(['assign'])
    expect(custodyActions({ ...live, held: true })).toEqual(['transfer', 'return'])
  })

  it('offers nothing without the permission — hidden, not disabled', () => {
    expect(custodyActions({ ...live, held: false, may: false })).toEqual([])
    expect(custodyActions({ ...live, held: true, may: false })).toEqual([])
  })

  it('offers nothing on an archived item, which the server refuses anyway', () => {
    expect(custodyActions({ ...live, held: false, archived: true })).toEqual([])
    expect(custodyActions({ ...live, held: true, archived: true })).toEqual([])
  })

  it('never offers assigning something that is already held', () => {
    // The one combination that would 409 every single time it was pressed.
    expect(custodyActions({ ...live, held: true })).not.toContain('assign')
  })

  /**
   * A lost or retired item can be taken back and cannot be given to anybody: the server refuses
   * `assign` and `transfer` with `inventory.custody.disposed` and lets `return` through, because
   * whoever is answerable for a lost laptop has to be able to stop being answerable for it.
   */
  it('offers only taking back a lost or retired item, and only while somebody has it', () => {
    expect(custodyActions({ ...live, held: true, disposed: true })).toEqual(['return'])
    expect(custodyActions({ ...live, held: false, disposed: true })).toEqual([])
  })

  it('still hides everything on a disposed item for somebody without the permission', () => {
    expect(custodyActions({ ...live, held: true, disposed: true, may: false })).toEqual([])
  })
})
