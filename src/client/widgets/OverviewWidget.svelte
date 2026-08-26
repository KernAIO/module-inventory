<script lang="ts">
import { Badge, type BadgeTone, WidgetState } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getInventoryApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { inventoryKeys } from '../query.js'

/**
 * A dashboard card.
 *
 * `WidgetState` draws loading, failed and empty so every card on the board reports those three the
 * same way — and so a module does not have to translate "Retry" to show a widget that failed.
 */
interface Props {
  workspaceId: string
  settings?: Record<string, string | number | boolean | null>
}
const { workspaceId, settings }: Props = $props()

const limit = $derived(Number(settings?.limit ?? 5))
const api = getInventoryApi()

/**
 * The card asks for exactly what it shows.
 *
 * It used to fetch the default page and then drop archived rows and slice — so a workspace whose
 * last twenty assets were all archived rendered an empty card that was not empty. The server knows
 * how to exclude them and how many to send.
 */
const filters = $derived({ archived: false, limit })

const assets = createQuery(() => ({
  queryKey: inventoryKeys.assets(workspaceId, filters),
  queryFn: () => api.assets.list({ workspaceId, ...filters }),
  enabled: Boolean(workspaceId),
}))

const items = $derived(assets.data?.items ?? [])

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'assigned':
    case 'reserved':
      return 'info'
    case 'lost':
      return 'danger'
    case 'under_repair':
      return 'warning'
    case 'retired':
      return 'grey'
    default:
      return 'success'
  }
}
</script>

<WidgetState
  pending={assets.isPending}
  error={assets.error}
  empty={!items.length}
  emptyTitle={t('empty')}
  emptyIcon="briefcase"
  onRetry={() => assets.refetch()}
>
  <ul>
    {#each items as asset (asset.id)}
      <li>
        <span class="code">{asset.code}</span>
        <span class="name">{asset.name}</span>
        <Badge tone={statusTone(asset.status)}>{t(`status_${asset.status}`)}</Badge>
      </li>
    {/each}
  </ul>
</WidgetState>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .code {
    font-size: 11px;
    color: var(--kern-ink-500);
    font-variant-numeric: tabular-nums;
    min-width: 64px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--kern-ink-900);
  }
</style>
