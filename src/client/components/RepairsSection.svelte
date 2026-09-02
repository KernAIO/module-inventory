<script lang="ts">
import { Button, EmptyState, formatDate, IconButton, messageLocale, Skeleton } from '@kernhq/ui'
import { createInfiniteQuery } from '@tanstack/svelte-query'
import type { Asset, RepairListItem } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import { t } from '../i18n.js'
import { formatPrice } from '../price.js'
import { inventoryKeys } from '../query.js'
import { type RepairAction, repairActions } from '../repairs.js'
import AttachmentsSection from './AttachmentsSection.svelte'

/**
 * What went away to be fixed, for one asset.
 *
 * Two halves, because they answer two questions: **the open one**, which is where the item is right
 * now, and **the past ones**, which are what it has cost to keep. At most one can be open — the
 * database says so with a unique index — so the top of this section is a single card rather than a
 * list, and `Send for repair` is offered only when there is no card there.
 *
 * A repair's own paperwork sits inside its card: the invoice belongs with the repair it is for, not
 * in the asset's general Files tab beside the purchase receipt.
 */
interface Props {
  workspaceId: string
  asset: Asset
  /** `inventory.repair.manage` — whether any of this can be written. */
  canManage: boolean
  /** `inventory.asset.manage`, which is what attaching a file to a repair takes. */
  canAttach: boolean
  /** Whether this workspace has the `attachments` capability; false hides the paperwork entirely. */
  hasFiles: boolean
  /** Opens the shared dialog. The panel owns it, so there is one dialog rather than one per row. */
  onact: (action: RepairAction, repair: RepairListItem | null) => void
}
const { workspaceId, asset, canManage, canAttach, hasFiles, onact }: Props = $props()

const api = getInventoryApi()

interface RepairPage {
  items: RepairListItem[]
  nextCursor: string | null
}

const repairsQuery = createInfiniteQuery(() => ({
  queryKey: inventoryKeys.assetRepairs(workspaceId, asset.id),
  queryFn: ({ pageParam }): Promise<RepairPage> =>
    api.repairs.list({
      workspaceId,
      assetId: asset.id,
      ...(pageParam ? { cursor: pageParam as string } : {}),
    }) as Promise<RepairPage>,
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: RepairPage) => last.nextCursor ?? undefined,
  enabled: Boolean(workspaceId && asset.id),
}))

const repairs = $derived(repairsQuery.data?.pages.flatMap((page) => page.items) ?? [])
/** At most one, by construction: `inventory_repairs_one_open_uq` makes a second one impossible. */
const open = $derived(repairs.find((row) => row.returnedOn === null) ?? null)
const past = $derived(repairs.filter((row) => row.returnedOn !== null))

/**
 * Which of the three this section may offer, decided in `repairs.ts`.
 *
 * Hidden rather than disabled for somebody without the permission — they may never do it — and
 * empty for an archived or a lost or retired item, where the sentence below says why. The server
 * refuses each of these again; this only stops the panel offering a door that will not open.
 */
const available = $derived(
  repairActions({
    open: open !== null,
    archived: Boolean(asset.archivedAt),
    disposed: Boolean(asset.disposition),
    may: canManage,
  }),
)

/** A cost in the reader's own numbers, with the unit it was recorded in. */
function cost(row: RepairListItem): string | null {
  if (row.costMinor === null) return null
  // Its own currency decides how many decimal places the stored minor units carry — yen has none.
  return `${formatPrice(row.costMinor, messageLocale(), row.currency)} ${row.currency ?? ''}`.trim()
}

const SKELETON_ROWS = [0, 1]
</script>

{#if repairsQuery.isPending}
  <div class="skeleton">
    {#each SKELETON_ROWS as row (row)}
      <Skeleton height="52px" radius="10px" />
    {/each}
  </div>
{:else if repairsQuery.isError}
  <EmptyState bare compact icon="triangle-alert" title={t('repairs_error')}>
    {#snippet actions()}
      <Button size="sm" variant="secondary" onclick={() => void repairsQuery.refetch()}>
        {t('common.retry')}
      </Button>
    {/snippet}
  </EmptyState>
{:else}
  <div class="repairs">
    {#if open}
      <section class="current" aria-label={t('repair_current')}>
        <div class="chead">
          <h3 class="section">{t('repair_current')}</h3>
          {#if available.includes('edit')}
            <IconButton
              icon="square-pen"
              size={26}
              label={t('repair_edit')}
              onclick={() => onact('edit', open)}
            />
          {/if}
        </div>
        <p class="summary">{open.summary}</p>
        <p class="meta">
          <span>{t('repair_away_since', isolated({ date: formatDate(open.sentOn) }))}</span>
          {#if open.vendor}<span>· {open.vendor}</span>{/if}
          {#if cost(open)}<span class="ltr">· {cost(open)}</span>{/if}
        </p>
        {#if open.detail}<p class="detail">{open.detail}</p>{/if}
        {#if hasFiles}
          <AttachmentsSection
            {workspaceId}
            assetId={asset.id}
            repairId={open.id}
            canManage={canAttach}
            compact
          />
        {/if}
        {#if available.includes('complete')}
          <div class="acts">
            <Button size="sm" icon="circle-check" onclick={() => onact('complete', open)}>
              {t('repair_complete')}
            </Button>
          </div>
        {/if}
      </section>
    {:else if canManage && asset.archivedAt}
      <!-- A disabled control with no explanation is a bug; one sentence says why instead. -->
      <p class="hint">{t('repair_archived_hint')}</p>
    {:else if canManage && asset.disposition}
      <!-- Nobody can send away a thing nobody can find, or pay to fix one the company has
           written off; the server refuses with `inventory.repair.disposed`. -->
      <p class="hint">{t('repair_disposed_hint')}</p>
    {:else if available.includes('create')}
      <div class="acts">
        <Button size="sm" icon="wrench" onclick={() => onact('create', null)}>{t('repair_new')}</Button>
      </div>
    {/if}

    {#if past.length}
      <h3 class="section">{t('repair_past')}</h3>
      <ul class="past">
        {#each past as row (row.id)}
          <li class="entry">
            <div class="ehead">
              <span class="esummary">{row.summary}</span>
              {#if canManage}
                <IconButton
                  icon="square-pen"
                  size={26}
                  label={t('repair_edit')}
                  onclick={() => onact('edit', row)}
                />
              {/if}
            </div>
            <p class="meta">
              <!-- Through `Intl`, never two dates and a dash: hand-built it reads backwards in
                   RTL, with the earlier date to the right of the later one. -->
              <span>
                {t('repair_sent_on')}
                {formatDate(row.sentOn)}
              </span>
              <span>
                · {t('repair_returned_on')}
                {formatDate(row.returnedOn as string)}
              </span>
              {#if row.vendor}<span>· {row.vendor}</span>{/if}
              {#if cost(row)}<span class="ltr">· {cost(row)}</span>{/if}
            </p>
            {#if hasFiles}
              <AttachmentsSection
                {workspaceId}
                assetId={asset.id}
                repairId={row.id}
                canManage={canAttach}
                compact
              />
            {/if}
          </li>
        {/each}
      </ul>
    {:else if !open}
      <EmptyState
        bare
        compact
        icon="wrench"
        title={t('repairs_empty')}
        description={t('repairs_empty_desc')}
      />
    {/if}

    {#if repairsQuery.hasNextPage}
      <div class="more">
        <Button
          size="sm"
          variant="secondary"
          loading={repairsQuery.isFetchingNextPage}
          onclick={() => repairsQuery.fetchNextPage()}
        >
          {t('load_more')}
        </Button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .skeleton,
  .repairs {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 14px;
  }
  .current {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--kern-border);
    border-radius: var(--kern-r-lg);
    /* Not `--kern-surface-raised`: a `Sheet` is already that colour, so the card would have been a
       bordered box with no ground of its own. `--kern-surface-chip` is a shade off it in both
       themes, and the muted text on it measures 5.66:1 in light and 5.37:1 in dark. */
    background: var(--kern-surface-chip);
  }
  .chead,
  .ehead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .section {
    margin: 0;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--kern-ink-500);
  }
  .summary,
  .esummary {
    margin: 0;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--kern-ink-900);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    font-size: 11.5px;
    /* Muted with a colour rather than opacity, which fades the text against the panel. */
    color: var(--kern-ink-500);
  }
  .detail {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--kern-ink-700);
    white-space: pre-wrap;
  }
  .hint {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--kern-ink-500);
  }
  .acts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .past {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--kern-border-hairline);
  }
  .entry:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  /* An amount is a Latin number read left to right, whatever direction the panel runs. */
  .ltr {
    direction: ltr;
    unicode-bidi: isolate;
  }
  .more {
    display: flex;
    justify-content: center;
    padding-top: 4px;
  }
</style>
