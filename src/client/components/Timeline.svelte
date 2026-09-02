<script lang="ts">
import {
  Avatar,
  Button,
  EmptyState,
  formatDate,
  formatDateTime,
  messageLocale,
  relativeTime,
  Skeleton,
} from '@kernhq/ui'
import { createInfiniteQuery } from '@tanstack/svelte-query'
import type { AssetHistoryEntry } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolate, isolated } from '../bidi.js'
import { t } from '../i18n.js'
import type { Directory } from '../members.js'
import { nameOf, resolveName } from '../members.js'
import { formatPrice } from '../price.js'
import { inventoryKeys } from '../query.js'
import {
  actionKey,
  changeLineKind,
  customKeyOf,
  fieldKey,
  noteOf,
  personIdOf,
  subjectOf,
} from '../timeline.js'
import TimelineText from './TimelineText.svelte'

/**
 * An asset's own timeline, as sentences.
 *
 * `asset_history` stores `{ action, changes: [{field, from, to}], data: {…ids} }`, which is a shape
 * for a database. Rendered raw it is a JSON diff of somebody's own laptop; rendered here it is
 * "Ada handed it to Bruno" and "Warranty until changed from Mar 14, 2027 to Mar 14, 2028" — "it"
 * rather than the tag, because the panel's own header is already showing `INV-0042`.
 *
 * Which sentence, and about whom, is decided in `timeline.ts` — pure, and therefore tested. This
 * file supplies the words and the layout and nothing else.
 */
interface Props {
  workspaceId: string
  assetId: string
  /** Who the workspace currently has, for turning a stored uuid into a name. */
  dir: Directory
  /** A category id as its name, or null when the id names nothing this workspace still lists. */
  categoryName: (id: string) => string | null
  /**
   * A custom field's key as the field's name, or null when no definition the panel loaded carries
   * that key. A change to a custom value is stored under `custom.<key>`, and "cost_centre set to
   * 4100" is a column name on somebody's screen — the same defect `fieldKey` exists to prevent for
   * the built-in fields, answered from the panel's own query rather than from a second one here.
   */
  fieldName: (key: string) => string | null
  /**
   * The asset's currency now, for reading a stored `priceMinor` back into an amount.
   *
   * How many decimal places minor units carry is a fact about the currency — none for yen, three
   * for the dinar — so a timeline that assumed hundredths printed every yen price 100× too small.
   * An entry that *changed* the currency carries both sides itself and is read from those instead;
   * this is the answer for every other entry, which is almost all of them.
   */
  currency: string | null
}
const { workspaceId, assetId, dir, categoryName, fieldName, currency }: Props = $props()

const api = getInventoryApi()

interface HistoryPage {
  items: AssetHistoryEntry[]
  nextCursor: string | null
}

const historyQuery = createInfiniteQuery(() => ({
  queryKey: inventoryKeys.assetHistory(workspaceId, assetId),
  queryFn: ({ pageParam }): Promise<HistoryPage> =>
    api.assets.history({
      workspaceId,
      assetId,
      ...(pageParam ? { cursor: pageParam as string } : {}),
    }) as Promise<HistoryPage>,
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: HistoryPage) => last.nextCursor ?? undefined,
  enabled: Boolean(workspaceId && assetId),
}))

const entries = $derived(historyQuery.data?.pages.flatMap((page) => page.items) ?? [])

/**
 * The four words `nameOf` needs, read on render so they follow the interface language.
 *
 * Four rather than two, and that is the fix: an id the directory does not have used to read as
 * "a former member" whether the member list was still in flight, had failed, or really did not
 * contain them — so every entry said "A former member handed it to A former member" for the first
 * moments of every panel, and for ever if the request failed. `members.ts` decides which of the
 * four applies; this only supplies the wording.
 */
const words = $derived({
  loading: t('member_loading'),
  unknown: t('member_unknown'),
  former: t('member_former'),
  system: t('member_system'),
})

/**
 * One value, in the units a person reads it in.
 *
 * A stored diff holds what the column holds: minor units for a price, an ISO date for a date, a
 * uuid for a category. "priceMinor changed from 129900 to 149900" is arithmetic homework, and
 * "categoryId changed from 0192… to 0192…" is not a sentence at all.
 */
function readable(field: string, value: unknown, money: string | null): string {
  if (value === null || value === undefined || value === '') return '—'
  if (customKeyOf(field)) return customReadable(value)
  if (field === 'categoryId') return categoryName(String(value)) ?? t('category_none')
  if (field === 'priceMinor') return formatPrice(Number(value), messageLocale(), money)
  if (field === 'purchasedOn' || field === 'warrantyUntil') return formatDate(String(value))
  return String(value)
}

/**
 * A custom value, read from its own shape rather than from a definition.
 *
 * The entry names the key and not the type, and the definition may have been archived out of the
 * list the panel loaded — so the value is read for what it is: a boolean is a word, a list is joined
 * the way the reader's language joins one, a number is in their own digits, and a string of exactly
 * the shape a date field stores (`2027-03-14`) is a date. That last one is a heuristic and is named
 * as one; a text field somebody typed an ISO date into is shown as a date, which is what they meant.
 */
function customReadable(value: unknown): string {
  if (typeof value === 'boolean') return value ? t('yes') : t('no')
  if (Array.isArray(value))
    return new Intl.ListFormat(messageLocale(), { style: 'long', type: 'conjunction' }).format(
      value.map(String),
    )
  if (typeof value === 'number') return new Intl.NumberFormat(messageLocale()).format(value)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value)
  return String(value)
}

/**
 * Which currency one side of one entry is in — the entry's own answer where it has one.
 *
 * Somebody who re-priced a laptop from ¥120000 to €890 changed two columns in one edit, so the
 * entry carries a `currency` change beside the `priceMinor` change and each side of the sentence
 * is in a different currency. Reading both through today's currency would print one of them
 * wrong, and it is the *old* one — the number nobody can check any more.
 */
function currencyFor(entry: AssetHistoryEntry, side: 'from' | 'to'): string | null {
  const changed = entry.changes.find((change) => change.field === 'currency')
  if (!changed) return currency
  const value = changed[side]
  return typeof value === 'string' && value ? value : null
}

/**
 * The label for one field, and the only value here that must *not* be isolated afterwards.
 *
 * A key that resolves is a translated word and belongs to the sentence around it. A field this
 * client has never heard of prints its own name — ugly and true, because the rows outlive the image
 * that wrote them — and that one is a Latin identifier dropped into a Persian sentence, so it is
 * isolated here rather than left to reorder the words on either side of it.
 *
 * A custom field's name is a value somebody typed, so it is isolated too; and when the panel has no
 * definition for the key — a field archived out of the list it loaded, or a row written by a newer
 * image — the key itself is printed, which is ugly and true where a guessed label would be neither.
 */
function fieldLabel(field: string): string {
  const custom = customKeyOf(field)
  if (custom) return isolate(fieldName(custom) ?? custom)
  const key = fieldKey(field)
  return key ? t(key) : isolate(field)
}

/**
 * One line under an entry, for one field that changed.
 *
 * `changeLineKind` in `timeline.ts` decides which of the five sentences applies — including the one
 * this used to get wrong, where a `description` change read its whole eight-kilobyte value out into
 * a row of a 440px panel. `text_changed` says that it changed and `TimelineText` carries the text.
 *
 * Every value goes through `isolated()`: a serial number, a location, a price and a category name
 * are all values somebody typed, and a Latin one inside «{field} از {from} به {to} تغییر کرد»
 * loses its own punctuation to the sentence around it.
 */
function changeLine(entry: AssetHistoryEntry, change: { field: string; from: unknown; to: unknown }): string {
  const field = fieldLabel(change.field)
  const kind = changeLineKind(change.field, change.from, change.to)
  if (kind === 'cleared') return t('history_cleared', isolated({ field }))
  if (kind === 'replaced') return t('history_replaced', isolated({ field }))
  if (kind === 'text_changed') return t('history_text_changed', isolated({ field }))
  if (kind === 'set')
    return t(
      'history_set',
      isolated({ field, to: readable(change.field, change.to, currencyFor(entry, 'to')) }),
    )
  return t(
    'history_changed',
    isolated({
      field,
      from: readable(change.field, change.from, currencyFor(entry, 'from')),
      to: readable(change.field, change.to, currencyFor(entry, 'to')),
    }),
  )
}

/** The text a `text_changed` line discloses. Null for `from` when there was nothing there before. */
const textOf = (value: unknown): string | null =>
  value === null || value === undefined || value === '' ? null : String(value)

function headline(entry: AssetHistoryEntry): string {
  const personId = personIdOf(entry.action, entry.data)
  // `action` is a machine token — `repair_logged` — and lands inside a translated sentence for an
  // action this client has no wording for, so it is isolated with the two names.
  return t(
    actionKey(entry.action),
    isolated({
      actor: nameOf(entry.actorId, dir, words),
      person: nameOf(personId, dir, words),
      action: entry.action,
    }),
  )
}

const SKELETON_ROWS = [0, 1, 2]
</script>

{#if historyQuery.isPending}
  <ul class="skeleton">
    {#each SKELETON_ROWS as row (row)}
      <li class="srow">
        <Skeleton height="22px" width="22px" radius="999px" />
        <div class="slines">
          <Skeleton height="12px" width="62%" />
          <Skeleton height="10px" width="28%" />
        </div>
      </li>
    {/each}
  </ul>
{:else if historyQuery.isError}
  <EmptyState bare compact icon="triangle-alert" title={t('history_error')}>
    {#snippet actions()}
      <Button size="sm" variant="secondary" onclick={() => void historyQuery.refetch()}>
        {t('common.retry')}
      </Button>
    {/snippet}
  </EmptyState>
{:else if entries.length === 0}
  <!-- Unreachable in practice — `create` writes the first entry in the same transaction as the
       asset — and rendered honestly all the same, because "unreachable" is a claim about today. -->
  <EmptyState bare compact icon="clock" title={t('history_empty')} />
{:else}
  <ol class="entries">
    {#each entries as entry (entry.id)}
      <!-- The avatar shows initials only for somebody actually resolved. Its colour is seeded from
           the id either way, so it does not change when the member list arrives — and an unresolved
           actor gets a plain square rather than the initials of "…". -->
      {@const actor = resolveName(entry.actorId, dir)}
      {@const note = noteOf(entry.data)}
      {@const subject = subjectOf(entry.action, entry.data)}
      <li class="entry">
        <Avatar name={actor.name} id={entry.actorId} size={22} />
        <div class="body">
          <p class="line">{headline(entry)}</p>
          <!-- What the entry is about — a repair's summary, a file's name. Rendered bare rather
               than through the catalogue: it is text somebody typed, not an interface string. -->
          {#if subject}<p class="subject">{subject}</p>{/if}
          {#if entry.changes.length}
            <ul class="changes">
              {#each entry.changes as change (change.field)}
                <li>
                  {changeLine(entry, change)}
                  {#if changeLineKind(change.field, change.from, change.to) === 'text_changed'}
                    <TimelineText
                      before={textOf(change.from)}
                      after={textOf(change.to) ?? ''}
                    />
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if note}
            <p class="note">{t('history_note', isolated({ note }))}</p>
          {/if}
          <!-- The exact moment is on the element, so a hover and a screen reader both get it;
               the visible text is relative, which is what somebody reading a timeline wants. -->
          <time class="when" datetime={entry.occurredAt} title={formatDateTime(entry.occurredAt)}>
            {relativeTime(entry.occurredAt)}
          </time>
        </div>
      </li>
    {/each}
  </ol>

  {#if historyQuery.hasNextPage}
    <div class="more">
      <Button
        size="sm"
        variant="secondary"
        loading={historyQuery.isFetchingNextPage}
        onclick={() => historyQuery.fetchNextPage()}
      >
        {t('load_more')}
      </Button>
    </div>
  {/if}
{/if}

<style>
  .entries,
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry,
  .srow {
    display: grid;
    /* Logical, so the avatar sits on the reading-start edge in Persian and Arabic too. */
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }
  .slines {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .line {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--kern-ink-900);
  }
  .changes {
    margin: 2px 0 0;
    /* Logical: a bulleted list indents from the reading-start edge in both directions. */
    padding-inline-start: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12.5px;
    line-height: 1.5;
    /* Muted with a colour rather than with opacity, which fades text against the page. */
    color: var(--kern-ink-600);
  }
  .note {
    margin: 2px 0 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--kern-ink-600);
    border-inline-start: 2px solid var(--kern-border-hairline);
    padding-inline-start: 8px;
  }
  .subject {
    margin: 1px 0 0;
    font-size: 12.5px;
    line-height: 1.5;
    /* Muted with a colour, never with opacity: a faded line at 0.5 is unreadable whatever its
       token says, and this one carries the only specific word in the entry. */
    color: var(--kern-ink-600);
    overflow-wrap: anywhere;
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian panel reads left to right and keeps
       its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .when {
    font-size: 11.5px;
    color: var(--kern-ink-500);
  }
  .more {
    display: flex;
    justify-content: center;
    padding-top: 12px;
  }
</style>
