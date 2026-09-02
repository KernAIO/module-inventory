import type { Kernel } from '@kernhq/kernel'
import { AssetService } from './assets.js'
import { AttachmentService } from './attachments.js'
import { CategoryService } from './categories.js'
import { CustodyService } from './custody.js'
import { FieldService } from './fields.js'
import { NotifyService } from './notify.js'
import { OffboardingService } from './offboarding.js'
import { RepairService } from './repairs.js'
import { SearchService } from './search.js'
import { StatsService } from './stats.js'

export interface InventoryServices {
  notify: NotifyService
  assets: AssetService
  categories: CategoryService
  /** The workspace's own fields, and the check every value written under one goes through. */
  fields: FieldService
  custody: CustodyService
  repairs: RepairService
  attachments: AttachmentService
  stats: StatsService
  /** The workspace-wide index, and the documents behind `inventory:asset:<id>`. */
  search: SearchService
  /** Somebody left holding company property. Raises a checklist; never moves custody. */
  offboarding: OffboardingService
}

const cache = new WeakMap<Kernel, InventoryServices>()

/** One service graph per kernel instance; the router, jobs and procedures all share it. */
export function inventoryServices(kernel: Kernel): InventoryServices {
  const existing = cache.get(kernel)
  if (existing) return existing

  const notify = new NotifyService(kernel)
  const fields = new FieldService()
  const assets = new AssetService(kernel, notify, fields)
  const categories = new CategoryService()
  const custody = new CustodyService(notify)
  const repairs = new RepairService(notify)
  const attachments = new AttachmentService(kernel, notify)
  const stats = new StatsService()
  const search = new SearchService(kernel, notify)
  const offboarding = new OffboardingService(kernel, notify)

  const services: InventoryServices = {
    notify,
    assets,
    categories,
    fields,
    custody,
    repairs,
    attachments,
    stats,
    search,
    offboarding,
  }
  cache.set(kernel, services)
  return services
}
