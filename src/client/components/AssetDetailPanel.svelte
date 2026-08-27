<script lang="ts">
import {
  Avatar,
  Badge,
  Button,
  coreApi,
  EmptyState,
  formatDate,
  formatDateRange,
  formatDateTime,
  IconButton,
  keys,
  messageLocale,
  Sheet,
  Skeleton,
  session,
  type TabItem,
  Tabs,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { Asset, Category, CustodyPeriod, RepairListItem } from '../../contract/index.js'
import { MODULE_ID } from '../../contract/index.js'
import { getInventoryApi } from '../api-instance.js'
import { isolated } from '../bidi.js'
import type { CoreApi, CoreMember } from '../core-api.js'
import { type CustodyAction, custodyActions } from '../custody.js'
import { t } from '../i18n.js'
import { directory, directoryStatus, nameOf, resolveName } from '../members.js'
import { canInventory } from '../permissions.js'
import { formatPrice } from '../price.js'
import { inventoryKeys } from '../query.js'
import type { RepairAction } from '../repairs.js'
import { statusTone } from '../status.js'
import AssetPhoto from './AssetPhoto.svelte'
import AttachmentsSection from './AttachmentsSection.svelte'
import CustodyDialog from './CustodyDialog.svelte'
import RepairDialog from './RepairDialog.svelte'
import RepairsSection from './RepairsSection.svelte'
import Timeline from './Timeline.svelte'

/**
 * Everything one asset is, in a panel over the list.
 *
 * A 440px sheet rather than a page of its own (DESIGN.md §3.13): the list keeps its scroll, its
 * filters and its cursor, and closing the panel puts you back exactly where you were. Which asset
 * is open lives in the URL as `?asset=<id>`, so it can be linked to, reloaded and shared — the page
 * owns that parameter, not this component.
 *
 * Five sections at most, because an asset answers five different questions: **what is it**
 * (Details), **who has it** (Custody), **what has been fixed** (Repairs), **what paperwork it has**
 * (Files) and **what has happened to it** (History).
 *
 * Two of them are capabilities, so a workspace that does not record repairs or keep receipts sees
 * three tabs and not five. The tab is not merely hidden: every procedure behind it answers 404 in
 * that workspace, which is what makes the interface and the API agree instead of the interface
 * hiding a door that is still open.
 */
interface Props {
  workspaceId: string
  /** The asset id from the URL. Null closes the panel. */
  assetId: string | null
  onclose: () => void
  /** Editing is the list's dialog, so the panel asks rather than growing a second copy of it. */
  onedit: (asset: Asset) => void
}
const { workspaceId, assetId, onclose, onedit }: Props = $props()

const api = getInventoryApi()
const core = coreApi<CoreApi>()

const enabled = $derived(Boolean(workspaceId && assetId))

const assetQuery = createQuery(() => ({
  queryKey: inventoryKeys.asset(workspaceId, assetId ?? ''),
  queryFn: () => api.assets.get({ workspaceId, assetId: assetId as string }),
  enabled,
}))
const asset = $derived(assetQuery.data ?? null)

/**
 * Categories **including archived ones**, and that is the whole reason this query is separate from
 * the page's.
 *
 * An asset filed under a category somebody later archived still carries its id, and the point of
 * archiving rather than deleting is that the row goes on being able to say what it is. Asking for
 * live categories only would blank exactly the rows archiving was supposed to protect.
 */
const categoriesQuery = createQuery(() => ({
  queryKey: inventoryKeys.categories(workspaceId, true),
  queryFn: () => api.categories.list({ workspaceId, archived: true }),
  enabled,
}))
const categoryNames = $derived(
  new Map((categoriesQuery.data ?? []).map((row: Category) => [row.id, row.name])),
)
const categoryName = (id: string): string | null => categoryNames.get(id) ?? null

const membersQuery = createQuery(() => ({
  queryKey: keys.members(workspaceId),
  queryFn: () => core.workspaces.members.list({ workspaceId }),
  enabled,
}))
const members = $derived<readonly CoreMember[]>(membersQuery.data?.items ?? [])
/**
 * The directory carries the request's state, not just its rows.
 *
 * An empty map is what "still loading", "failed" and "an empty workspace" all look like, and this
 * panel used to hand all three to `nameOf` as the same thing — so every custody row and every
 * timeline entry read "A former member" until the request came back, and permanently if it did not.
 */
const dir = $derived(directory(members, directoryStatus(membersQuery)))
const words = $derived({
  loading: t('member_loading'),
  unknown: t('member_unknown'),
  former: t('member_former'),
  system: t('member_system'),
})

const custodyQuery = createQuery(() => ({
  queryKey: inventoryKeys.assetCustody(workspaceId, assetId ?? ''),
  queryFn: () => api.custody.history({ workspaceId, assetId: assetId as string }),
  enabled,
}))
const periods = $derived<readonly CustodyPeriod[]>(custodyQuery.data ?? [])
/** Everything that is not the open one: "who had this before me". */
const previous = $derived(periods.filter((period) => period.effectiveTo !== null))

const holderName = $derived(asset?.custodianUserId ? nameOf(asset.custodianUserId, dir, words) : null)
/** The same person, unresolved, so the avatar shows initials only for somebody actually found. */
const holder = $derived(asset?.custodianUserId ? resolveName(asset.custodianUserId, dir) : null)

// ---------------------------------------------------------------------- what may be done here

const canManage = $derived(canInventory('manage'))
const canCustody = $derived(canInventory('custody'))
/**
 * Which handovers this item can actually take, decided in `custody.ts`.
 *
 * Empty for somebody without the permission — hidden, because they may never do it — and empty for
 * an archived item, where the sentence below says why rather than three buttons that cannot be
 * pressed. The server refuses every one of these again; this only stops the panel offering a door
 * that will not open.
 */
const available = $derived(
  custodyActions({
    held: Boolean(asset?.custodianUserId),
    archived: Boolean(asset?.archivedAt),
    may: canCustody,
  }),
)

let action = $state<CustodyAction | null>(null)

/** `inventory.repair.manage`, and `inventory.asset.manage` is what attaching a file takes. */
const canRepair = $derived(canInventory('repairs'))

/**
 * What this workspace has switched on.
 *
 * Read from the session rather than derived here: it is the set the **server** resolved, with
 * defaults applied, `required` forced on and anything whose dependency is off pruned. Working it
 * out again from raw settings would be a second implementation of that closure, and two
 * implementations eventually disagree — the way that shows up is a tab whose API answers 404.
 */
const hasRepairs = $derived(session.hasCapability(MODULE_ID, 'repairs'))
const hasFiles = $derived(session.hasCapability(MODULE_ID, 'attachments'))

let repairAction = $state<RepairAction | null>(null)
let repairRow = $state<RepairListItem | null>(null)

function openRepair(next: RepairAction, row: RepairListItem | null) {
  repairRow = row
  repairAction = next
}

// ---------------------------------------------------------------------------------- the tabs

let tab = $state('details')
const TABS = $derived<TabItem[]>([
  { value: 'details', label: t('details'), icon: 'info' },
  { value: 'custody', label: t('custody'), icon: 'user' },
  ...(hasRepairs ? [{ value: 'repairs', label: t('repairs'), icon: 'wrench' }] : []),
  ...(hasFiles ? [{ value: 'files', label: t('files'), icon: 'paperclip' }] : []),
  { value: 'history', label: t('history'), icon: 'clock' },
])

/**
 * A tab a workspace has just switched off must not leave the panel on it.
 *
 * `Tabs` keeps whatever value it was given, so a panel sitting on Repairs when an administrator
 * turns the capability off in another tab would render nothing at all — the content snippet has no
 * branch for a tab that is not in the list.
 */
$effect(() => {
  if (!TABS.some((item) => item.value === tab)) tab = 'details'
})

/** The rows of the Details section: a label, and a value already turned into words. */
const facts = $derived.by<Array<{ label: string; value: string; ltr?: boolean }>>(() => {
  if (!asset) return []
  const rows: Array<{ label: string; value: string; ltr?: boolean }> = [
    {
      label: t('category'),
      value: (asset.categoryId && categoryName(asset.categoryId)) || t('category_none'),
    },
    { label: t('serial_number'), value: asset.serialNumber ?? '—', ltr: true },
    { label: t('location'), value: asset.location ?? '—' },
    { label: t('purchased_on'), value: asset.purchasedOn ? formatDate(asset.purchasedOn) : '—' },
    { label: t('purchased_from'), value: asset.purchasedFrom ?? '—' },
    {
      label: t('price'),
      value:
        asset.priceMinor === null
          ? '—'
          : // The currency decides the decimal places, not a constant: ¥1000 has none and a
            // dinar has three, so reading the column as hundredths showed both wrong.
            `${formatPrice(asset.priceMinor, messageLocale(), asset.currency)} ${asset.currency ?? ''}`.trim(),
    },
    { label: t('warranty_until'), value: asset.warrantyUntil ? formatDate(asset.warrantyUntil) : '—' },
    { label: t('added_on'), value: formatDateTime(asset.createdAt) },
    { label: t('updated_on'), value: formatDateTime(asset.updatedAt) },
  ]
  return rows
})
</script>

<Sheet
  open={assetId !== null}
  onOpenChange={(next) => {
    if (!next) onclose()
  }}
>
  {#snippet header()}
    <div class="head">
      <code class="tag">{asset?.code ?? ''}</code>
      <h2 class="name">{asset?.name ?? ''}</h2>
    </div>
  {/snippet}

  {#snippet actions()}
    {#if asset && canManage}
      <IconButton
        icon="square-pen"
        size={28}
        variant="sidebar"
        label={t('edit')}
        onclick={() => onedit(asset)}
      />
    {/if}
  {/snippet}

  {#if assetQuery.isPending}
    <div class="loading">
      <Skeleton height="14px" width="55%" />
      <Skeleton height="14px" width="72%" />
      <Skeleton height="14px" width="40%" />
      <Skeleton height="14px" width="64%" />
    </div>
  {:else if assetQuery.isError || !asset}
    <EmptyState bare icon="triangle-alert" title={t('asset_error')}>
      {#snippet actions()}
        <Button size="sm" variant="secondary" onclick={() => void assetQuery.refetch()}>
          {t('common.retry')}
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="status-line">
      {#if asset.archivedAt}
        <Badge tone="grey">{t('archived')}</Badge>
      {:else}
        <Badge tone={statusTone(asset.status)}>{t(`status_${asset.status}`)}</Badge>
      {/if}
    </div>

    <!-- The tab strip scrolls rather than pushing the panel sideways: five pills in German do not
         fit 440px, and a page that scrolls horizontally is a defect the e2e sweep fails on. -->
    <Tabs class="panel-tabs" items={TABS} bind:value={tab} label={t('title')}>
      {#snippet children(pane)}
        {#if pane === 'details'}
          <!-- The photo is a field of the asset, so it sits with the asset's other fields rather
               than in Files — which a workspace can switch off, and the photo is not part of it. -->
          <div class="photo-slot">
            <AssetPhoto {workspaceId} {asset} canManage={canManage} />
          </div>
          <dl class="facts">
            {#each facts as fact (fact.label)}
              <dt>{fact.label}</dt>
              <dd class:ltr={fact.ltr}>{fact.value}</dd>
            {/each}
          </dl>
          {#if asset.description}
            <p class="description">{asset.description}</p>
          {/if}
        {:else if pane === 'custody'}
          <div class="custody">
            <div class="holder">
              {#if asset.custodianUserId}
                <Avatar name={holder?.name ?? null} id={asset.custodianUserId} size={32} />
                <div class="holder-text">
                  <span class="holder-label">{t('custody_holder')}</span>
                  <span class="holder-name">{holderName}</span>
                  {#if asset.custodySince}
                    <span class="holder-since">
                      {t('custody_since', isolated({ date: formatDate(asset.custodySince) }))}
                    </span>
                  {/if}
                </div>
              {:else}
                <div class="holder-text">
                  <span class="holder-label">{t('custody_holder')}</span>
                  <span class="holder-name">{t('custody_nobody')}</span>
                </div>
              {/if}
            </div>

            {#if canCustody && asset.archivedAt}
              <!-- A disabled control with no explanation is a bug; one sentence says why instead. -->
              <p class="hint">{t('custody_archived_hint')}</p>
            {:else if available.length}
              <div class="acts">
                {#each available as verb (verb)}
                  <Button
                    size="sm"
                    variant={verb === 'return' ? 'secondary' : 'primary'}
                    icon={verb === 'assign' ? 'user-plus' : verb === 'transfer' ? 'arrow-right' : 'undo-2'}
                    onclick={() => (action = verb)}
                  >
                    {t(`custody_${verb}`)}
                  </Button>
                {/each}
              </div>
            {/if}

            <h3 class="section">{t('custody_previous')}</h3>
            {#if custodyQuery.isPending}
              <Skeleton height="40px" radius="8px" />
            {:else if custodyQuery.isError}
              <EmptyState bare compact icon="triangle-alert" title={t('custody_error')}>
                {#snippet actions()}
                  <Button size="sm" variant="secondary" onclick={() => void custodyQuery.refetch()}>
                    {t('common.retry')}
                  </Button>
                {/snippet}
              </EmptyState>
            {:else if previous.length === 0}
              <EmptyState
                bare
                compact
                icon="user"
                title={t('custody_empty')}
                description={t('custody_empty_desc')}
              />
            {:else}
              <ul class="periods">
                {#each previous as period (period.id)}
                  {@const holder = resolveName(period.userId, dir)}
                  {@const who = nameOf(period.userId, dir, words)}
                  <li class="period">
                    <!-- Initials only for somebody resolved; the colour is seeded from the id
                         either way, so the square does not change when the list arrives. -->
                    <Avatar name={holder.name} id={period.userId} size={22} />
                    <div class="period-text">
                      <span class="period-who">{who}</span>
                      <!-- A range through `Intl`, never two dates and a dash: hand-built it reads
                           backwards in RTL, earliest date to the right of the latest. -->
                      <span class="period-when">
                        {formatDateRange(period.effectiveFrom, period.effectiveTo as string)}
                      </span>
                      {#if period.note}<span class="period-note">{period.note}</span>{/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else if pane === 'repairs'}
          <RepairsSection
            {workspaceId}
            {asset}
            canManage={canRepair}
            canAttach={canManage}
            {hasFiles}
            onact={openRepair}
          />
        {:else if pane === 'files'}
          <div class="files-pane">
            <AttachmentsSection
              {workspaceId}
              assetId={asset.id}
              repairId={null}
              canManage={canManage}
            />
          </div>
        {:else}
          <Timeline
            {workspaceId}
            assetId={asset.id}
            {dir}
            {categoryName}
            currency={asset.currency}
          />
        {/if}
      {/snippet}
    </Tabs>
  {/if}
</Sheet>

<CustodyDialog
  {workspaceId}
  asset={action ? asset : null}
  {action}
  {members}
  {holderName}
  onclose={() => (action = null)}
/>

<RepairDialog
  {workspaceId}
  asset={repairAction ? asset : null}
  repair={repairRow}
  action={repairAction}
  onclose={() => {
    repairAction = null
    repairRow = null
  }}
/>

<style>
  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .tag {
    font-family: var(--kern-font-mono);
    font-size: 11.5px;
    color: var(--kern-ink-500);
    /* A tag is read character by character off a sticker, so it stays left-to-right inside a
       Persian or Arabic panel and the bidi algorithm does not reorder its digits. */
    direction: ltr;
    unicode-bidi: isolate;
  }
  .name {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--kern-ink-900);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian panel reads left to right and keeps
       its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .loading {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .status-line {
    margin-bottom: 12px;
  }
  /**
   * Five pills do not fit 440px in German, and a document that scrolls sideways is a defect the
   * end-to-end sweep fails on. Wide content scrolls inside its own box instead; the scrollbar is
   * hidden because the pills already say there are more of them.
   */
  :global(.panel-tabs .ktabs-list) {
    overflow-x: auto;
    scrollbar-width: none;
  }
  :global(.panel-tabs .ktabs-list::-webkit-scrollbar) {
    display: none;
  }
  .photo-slot {
    margin-top: 14px;
  }
  .files-pane {
    margin-top: 14px;
  }
  .facts {
    display: grid;
    grid-template-columns: minmax(96px, auto) minmax(0, 1fr);
    gap: 8px 14px;
    margin: 14px 0 0;
    font-size: 13px;
  }
  dt {
    color: var(--kern-ink-500);
  }
  dd {
    margin: 0;
    color: var(--kern-ink-900);
    overflow-wrap: anywhere;
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian panel reads left to right and keeps
       its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .ltr {
    direction: ltr;
    unicode-bidi: isolate;
  }
  .description {
    margin: 16px 0 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--kern-ink-700);
    white-space: pre-wrap;
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian panel reads left to right and keeps
       its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .custody {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 14px;
  }
  .holder {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .holder-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .holder-label {
    font-size: 11.5px;
    color: var(--kern-ink-500);
  }
  .holder-name {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--kern-ink-900);
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian panel reads left to right and keeps
       its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .holder-since {
    font-size: 11.5px;
    color: var(--kern-ink-500);
  }
  .hint {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.5;
    /* Muted with a colour; opacity would fade the sentence against the panel. */
    color: var(--kern-ink-500);
  }
  .acts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .section {
    margin: 4px 0 0;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--kern-ink-500);
  }
  .periods {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .period {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }
  .period-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .period-who {
    font-size: 13px;
    color: var(--kern-ink-900);
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian panel reads left to right and keeps
       its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
  .period-when {
    font-size: 11.5px;
    color: var(--kern-ink-500);
  }
  .period-note {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--kern-ink-600);
    /* A value somebody typed decides its own direction: `plaintext` takes it from the value's
       first strong character, so a Latin name inside a Persian panel reads left to right and keeps
       its own trailing punctuation instead of donating it to the paragraph. */
    unicode-bidi: plaintext;
  }
</style>
