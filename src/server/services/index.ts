import type { Kernel } from '@kernhq/kernel'
import { AssetService } from './assets.js'
import { NotifyService } from './notify.js'

export interface InventoryServices {
  notify: NotifyService
  assets: AssetService
}

const cache = new WeakMap<Kernel, InventoryServices>()

/** One service graph per kernel instance; the router, jobs and procedures all share it. */
export function inventoryServices(kernel: Kernel): InventoryServices {
  const existing = cache.get(kernel)
  if (existing) return existing

  const notify = new NotifyService(kernel)
  const assets = new AssetService(kernel, notify)

  const services: InventoryServices = { notify, assets }
  cache.set(kernel, services)
  return services
}
