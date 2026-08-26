<script lang="ts">
import { Badge, type BadgeTone, WidgetState } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getInventoryApi } from '../api-instance.js'
import { t } from '../i18n.js'

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

const assets = createQuery(() => ({
  queryKey: ['inventory', 'assets', workspaceId],
  queryFn: () => api.assets.list({ workspaceId }),
  enabled: Boolean(workspaceId),
}))

const items = $derived((assets.data?.items ?? []).filter((a) => !a.archivedAt).slice(0, limit))

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
