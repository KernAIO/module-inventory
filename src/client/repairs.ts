/**
 * What a repair section can actually offer right now.
 *
 * Three verbs and not one, because the server has three procedures and refuses the wrong one with
 * its own sentence: sending something that is already at a repairer is a mistake worth naming, and
 * completing a repair that is already finished is a different one. A button that always produces a
 * conflict is a door that will not open.
 *
 * A `.ts` file rather than a `const` inside the component, for the reason `custody.ts`, `price.ts`
 * and `timeline.ts` are: this is a fact with a right answer, and a `.svelte` file drags a compiler
 * behind it and cannot be unit-tested. It also has to be a plain module because the type is shared
 * with the dialog — a type exported from a component's instance script is a prop, not a type.
 */
export type RepairAction = 'create' | 'edit' | 'complete'

export interface RepairState {
  /** A repair for this asset with no return date — at most one exists, by unique index. */
  open: boolean
  /** The workspace has taken the item out of the register; the server refuses a new repair. */
  archived: boolean
  /** This person holds `inventory.repair.manage`. */
  may: boolean
}

/**
 * What to offer, in the order the controls appear.
 *
 * Empty for somebody without the permission — hide what a person may never do — and empty for an
 * archived item with nothing open, where the section says *why* in one sentence instead. An
 * archived item whose repair is still open keeps `complete` and `edit`: archiving is refused while
 * a repair is open, so the only way to be in that state is to have archived it first and opened the
 * repair never — but if the data ever says otherwise, the way out has to stay reachable.
 */
export function repairActions(state: RepairState): RepairAction[] {
  if (!state.may) return []
  if (state.open) return ['complete', 'edit']
  return state.archived ? [] : ['create']
}
