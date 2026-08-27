<script lang="ts">
import { t } from '../i18n.js'

/**
 * The two versions of a long-text field, behind a disclosure.
 *
 * A description is up to eight thousand characters, and the timeline rendered a change to one as
 * "Description changed from … to …" with both versions inline: sixteen kilobytes of somebody's
 * prose in one row of a 440px panel, with every entry below it pushed off the screen. The line
 * above this now says only *that* it changed, and the text lives here.
 *
 * **A component rather than a bare `<details>` in the timeline, for one reason:** `{#if open}`.
 * `<details>` keeps its content in the document whether or not it is open, so fifty entries would
 * still be four hundred kilobytes of text nodes the browser has to build and lay out. Binding
 * `open` and gating on it means the prose exists only while somebody is reading it, and the
 * disclosure is still a real `<details>` — keyboard-reachable, announced as a disclosure, and
 * open by default in a printed page. Nothing is hidden: it is one keystroke away and shown whole,
 * because truncating what somebody deliberately opened would be the same defect one layer down.
 *
 * `before` is null when there was nothing there — a description filled in for the first time has
 * no previous version, and an empty "Before" block would invent one.
 */
interface Props {
  before: string | null
  after: string
}
const { before, after }: Props = $props()

let open = $state(false)
</script>

<details class="disclosure" bind:open>
  <summary>{t('history_show_text')}</summary>
  {#if open}
    <div class="body">
      {#if before !== null}
        <p class="label">{t('history_text_before')}</p>
        <!-- `pre-wrap`, so the paragraphs somebody typed are the paragraphs they read back. -->
        <blockquote class="text was">{before}</blockquote>
      {/if}
      <p class="label">{t('history_text_after')}</p>
      <blockquote class="text">{after}</blockquote>
    </div>
  {/if}
</details>

<style>
  .disclosure {
    margin-top: 3px;
    font-size: 12px;
  }
  summary {
    /* `list-style` on the summary is what removes the native marker in Firefox; the ::-webkit rule
       below is what removes it in Safari and Chrome. Neither alone does both. */
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    width: fit-content;
    cursor: pointer;
    color: var(--kern-ink-600);
    /* WCAG 2.5.8 wants 24px and a line of 12px text is about 16. The padding grows the hit area
       and the equal negative margin gives the space back, so nothing moves. */
    padding-block: 4px;
    margin-block: -4px;
    border-radius: var(--kern-r-sm);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    color: var(--kern-ink-900);
  }
  /* The disclosure triangle, drawn rather than borrowed, so it turns with the reading direction:
     `▸` in an Arabic panel points the wrong way, and a rotated glyph does not. */
  summary::before {
    content: '';
    width: 0;
    height: 0;
    border-block: 3.5px solid transparent;
    border-inline-start: 5px solid currentColor;
    transition: transform 120ms ease;
  }
  .disclosure[open] summary::before {
    /* Logical would be ideal and there is no logical rotation; the sign is flipped in RTL below. */
    transform: rotate(90deg);
  }
  :global([dir='rtl']) .disclosure[open] summary::before {
    transform: rotate(-90deg);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 6px;
  }
  .label {
    margin: 4px 0 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    /* Muted with a colour, never opacity: a faded label is unreadable whatever its token says. */
    color: var(--kern-ink-500);
  }
  .text {
    margin: 0;
    padding-inline-start: 8px;
    border-inline-start: 2px solid var(--kern-border-hairline);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    /* A description somebody typed decides its own direction: `plaintext` takes it from the
       text's own first strong character, so an English paragraph inside a Persian panel reads
       left to right and keeps its own punctuation. `isolate` would not — on a block it leaves
       the paragraph direction inherited. */
    unicode-bidi: plaintext;
  }
  .was {
    color: var(--kern-ink-500);
  }
</style>
