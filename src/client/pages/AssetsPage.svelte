<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  Input,
  Select,
  type SelectOption,
  Skeleton,
  Spinner,
  StatTile,
  session,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getInventoryApi } from '../api-instance.js'
import AssetFormDialog from '../components/AssetFormDialog.svelte'
import { t } from '../i18n.js'
import { canInventory, INVENTORY_PERMISSIONS } from '../permissions.js'
import { inventoryKeys } from '../query.js'

/**
 * This module's screen.
 *
 * The shell passes `workspaceId` and `workspaceSlug`, and `params` for any `:name` segment the
 * route declared. **Do not read `$app/state` or `$app/navigation`** — they are SvelteKit aliases,
 * this package is type-checked on its own, and they resolve only because the app happens to be
 * compiling you. Ask `navigation` from `@kernhq/ui` for the current location instead.
 */
interface Props {
  workspaceId: string
  workspaceSlug: string
  params?: Record<string, string>
}
const { workspaceId }: Props = $props()

const api = getInventoryApi()

let search = $state('')
let statusFilter = $state<string>('')
let showArchived = $state(false)
let dialogOpen = $state(false)

// Debounce the search into the cache key, so typing does not refetch per keystroke.
let q = $state('')
$effect(() => {
  const value = search
  const timer = setTimeout(() => (q = value), 250)
  return () => clearTimeout(timer)
})

const filters = $derived.by(() => {
  const f: Record<string, unknown> = {}
  if (q) f.q = q
  if (statusFilter) f.status = statusFilter
  if (!showArchived) f.archived = false
  return Object.keys(f).length ? f : undefined
})

const assetsQuery = createQuery(() => ({
  queryKey: inventoryKeys.assets(workspaceId, filters),
  queryFn: () =>
    api.assets.list({
      workspaceId,
      ...(q ? { q } : {}),
      ...(statusFilter
        ? { status: statusFilter as 'in_stock' | 'assigned' | 'under_repair' | 'retired' }
        : {}),
    }),
  enabled: Boolean(workspaceId),
}))

const assets = $derived(assetsQuery.data?.items ?? [])
const shownAssets = $derived(showArchived ? assets : assets.filter((a) => !a.archivedAt))
const counts = $derived({
  total: assets.length,
  assigned: assets.filter((a) => a.status === 'assigned').length,
  inStock: assets.filter((a) => a.status === 'in_stock').length,
  repair: assets.filter((a) => a.status === 'under_repair').length,
})

const statusOptions: SelectOption[] = [
  { value: '', label: t('filter_all_statuses') },
  { value: 'in_stock', label: t('status_in_stock') },
  { value: 'assigned', label: t('status_assigned') },
  { value: 'under_repair', label: t('status_under_repair') },
  { value: 'retired', label: t('status_retired') },
]

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'assigned':
      return 'info'
    case 'under_repair':
      return 'warning'
    case 'retired':
      return 'grey'
    default:
      return 'success'
  }
}
const statusLabel = (status: string) => t(`status_${status}`)
</script>

<svelte:head><title>{t('title')} · {session.workspaces.find((w) => w.id === workspaceId)?.name ?? ''}</title></svelte:head>

<section>
  <header>
    <h1>{t('nav')}</h1>
    <div class="actions">
      <Input bind:value={search} type="search" size="sm" placeholder={t('search_placeholder')} aria-label={t('search_placeholder')} />
      <Select bind:value={statusFilter} options={statusOptions} size="sm" />
      {#if canInventory('manage')}
        <Button size="sm" onclick={() => (dialogOpen = true)}>{t('new')}</Button>
      {/if}
    </div>
  </header>

  <div class="tiles">
    <StatTile size="md" label={t('count', { n: counts.total })} value={String(counts.total)} />
    <StatTile size="md" label={t('status_in_stock')} value={String(counts.inStock)} />
    <StatTile size="md" label={t('status_assigned')} value={String(counts.assigned)} />
    <StatTile size="md" label={t('status_under_repair')} value={String(counts.repair)} />
  </div>

  {#if assetsQuery.isPending}
    <Spinner />
  {:else if assetsQuery.isError}
    <p class="error">{t('common.error')}</p>
  {:else if shownAssets.length === 0}
    <EmptyState icon="briefcase" title={t('empty')} description={t('empty_desc')}>
      {#snippet actions()}
        {#if canInventory('manage')}
          <Button onclick={() => (dialogOpen = true)}>{t('new')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <p class="count">{t('count', { n: shownAssets.length })}</p>
    <div class="table" role="table" aria-label={t('title')}>
      <div class="thead" role="row">
        <span role="columnheader">{t('code')}</span>
        <span role="columnheader">{t('name')}</span>
        <span role="columnheader">{t('location')}</span>
        <span role="columnheader">{t('warranty_until')}</span>
        <span role="columnheader">{t('category')}</span>
      </div>
      {#each shownAssets as asset (asset.id)}
        <div class="trow" role="row" tabindex="-1">
          <span class="cell code" role="cell"><code>{asset.code}</code></span>
          <span class="cell who" role="cell">
            <span class="stack">
              <span class="name">{asset.name}</span>
              {#if asset.serialNumber}<span class="sub">S/N {asset.serialNumber}</span>{/if}
            </span>
          </span>
          <span class="cell muted" role="cell">{asset.location ?? '—'}</span>
          <span class="cell muted" role="cell">{asset.warrantyUntil ?? '—'}</span>
          <span class="cell" role="cell">
            {#if asset.archivedAt}
              <Badge tone="grey">{t('archived')}</Badge>
            {:else}
              <Badge tone={statusTone(asset.status)}>{statusLabel(asset.status)}</Badge>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</section>

<AssetFormDialog bind:open={dialogOpen} {workspaceId} />

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--kern-ink-900);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    margin-top: 14px;
  }
  .count {
    margin: 14px 0 6px;
    font-size: 12px;
    color: var(--kern-ink-500);
  }
  .error {
    color: var(--kern-danger);
    font-size: 13px;
  }
  .table {
    margin-top: 4px;
    border: 1px solid var(--kern-line);
    border-radius: 10px;
    overflow: hidden;
    background: var(--kern-paper);
  }
  .thead,
  .trow {
    display: grid;
    grid-template-columns: 110px minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 120px;
    gap: 10px;
    align-items: center;
    padding: 8px 12px;
  }
  .thead {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--kern-ink-500);
    background: var(--kern-canvas-subtle, transparent);
    border-bottom: 1px solid var(--kern-line);
  }
  .trow {
    border-bottom: 1px solid var(--kern-line);
    font-size: 13px;
  }
  .trow:last-child {
    border-bottom: none;
  }
  .cell {
    min-width: 0;
  }
  code {
    font-size: 12px;
    color: var(--kern-ink-700);
  }
  .who .stack {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-weight: 500;
    color: var(--kern-ink-900);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 11px;
    color: var(--kern-ink-500);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--kern-ink-500);
  }
</style>
