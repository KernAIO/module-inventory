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
  /**
   * Somebody said it is lost or retired — `assets.disposition` is set. The server refuses to
   * *give* such an item to anybody and lets it be taken back, and the split is the whole point:
   * the person answerable for a lost laptop has to be able to stop being answerable for it.
   */
  disposed: boolean
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
 *
 * A disposed item offers `return` and nothing else, and only while somebody holds it. `assign` and
 * `transfer` would each 409 with `inventory.custody.disposed` on every press, so the panel shows
 * the sentence that says to reinstate it first in their place — and keeps the one door the server
 * leaves open, because a lost item still has somebody answerable for it until it is taken back.
 */
export function custodyActions(state: CustodyState): CustodyAction[] {
  if (!state.may || state.archived) return []
  if (state.disposed) return state.held ? ['return'] : []
  return state.held ? ['transfer', 'return'] : ['assign']
}
