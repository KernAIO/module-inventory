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
  it('offers handing over when nobody has it, and handing on or back when somebody does', () => {
    expect(custodyActions({ held: false, archived: false, may: true })).toEqual(['assign'])
    expect(custodyActions({ held: true, archived: false, may: true })).toEqual(['transfer', 'return'])
  })

  it('offers nothing without the permission — hidden, not disabled', () => {
    expect(custodyActions({ held: false, archived: false, may: false })).toEqual([])
    expect(custodyActions({ held: true, archived: false, may: false })).toEqual([])
  })

  it('offers nothing on an archived item, which the server refuses anyway', () => {
    expect(custodyActions({ held: false, archived: true, may: true })).toEqual([])
    expect(custodyActions({ held: true, archived: true, may: true })).toEqual([])
  })

  it('never offers assigning something that is already held', () => {
    // The one combination that would 409 every single time it was pressed.
    expect(custodyActions({ held: true, archived: false, may: true })).not.toContain('assign')
  })
})
