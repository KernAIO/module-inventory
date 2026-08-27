/**
 * Which handover an asset can actually take right now.
 *
 * Three verbs and not one, because the server has three procedures and refuses the wrong one with
 * its own sentence: assigning something somebody already holds is a mistake worth naming, and
 * handing on something nobody holds is a different mistake. The interface's job is not to offer
 * either — a button that always produces a conflict is a door that will not open.
 *
 * A `.ts` file rather than a `const` inside the panel for the reason `timeline.ts` and `price.ts`
 * are: this is a fact with a right answer, and a `.svelte` file cannot be unit-tested.
 */
export type CustodyAction = 'assign' | 'transfer' | 'return'

export interface CustodyState {
  /** Somebody is holding it — `assets.custodian_user_id` is set. */
  held: boolean
  /** The workspace has taken it out of the register; the server refuses every handover. */
  archived: boolean
  /** This person holds `inventory.custody.manage`. */
  may: boolean
}

/**
 * What to offer, in the order the buttons appear.
 *
 * Empty for somebody without the permission — hide what a person may never do — and empty for an
 * archived item, where the panel says *why* instead. An archived item deliberately offers nothing
 * rather than a disabled row of buttons: the reason is one sentence, and one sentence beats three
 * controls that cannot be pressed.
 */
export function custodyActions(state: CustodyState): CustodyAction[] {
  if (!state.may || state.archived) return []
  return state.held ? ['transfer', 'return'] : ['assign']
}
