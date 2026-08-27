import type { BadgeTone } from '@kernhq/ui'

/**
 * What colour a status wears, in the one place both screens read it from.
 *
 * The list and the detail panel show the same badge for the same row, and a `switch` copied into
 * two components is two switches that drift — the day `reserved` gets its own colour, one of them
 * changes. `import type` is erased at build time, so this file still pulls no runtime dependency on
 * `@kernhq/ui` and stays unit-testable.
 *
 * The tones say what a reader needs to act on rather than what is "good": `in_stock` is the
 * ordinary resting state, `lost` is the one somebody has to do something about, and an archived row
 * is drawn grey by the screens without asking here — it is not a status, it is the absence of one.
 */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'assigned':
    case 'reserved':
      return 'info'
    case 'under_repair':
      return 'warning'
    case 'lost':
      return 'danger'
    case 'retired':
      return 'grey'
    default:
      return 'success'
  }
}
