/**
 * Demo content for the asset register.
 *
 * Forty-odd items across the categories a company actually buys, most of them held by somebody, a
 * few in storage, two away for repair and one written off — so the status column, the custody
 * history and the repairs screen all have something true to show.
 *
 * Custody is the part worth writing properly. An asset row with a `heldBy` column set by hand would
 * look right on the list and have no custody period behind it, which is what the item's own history
 * screen reads — so handovers go through `CustodyService.assign`, exactly as pressing the button
 * does.
 */
import type { DemoSeedContext, DemoSeedSummary } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import type { FieldType } from '../contract/models.js'
import { assets, categories } from './schema.js'
import { inventoryServices } from './services/index.js'

const DAY = 86_400_000
const at = (now: Date, days: number): string =>
  new Date(now.getTime() + days * DAY).toISOString().slice(0, 10)

interface ItemSeed {
  name: string
  category: string
  serial: string
  location: string
  /** minor units, in the workspace currency */
  price: number
  /** days before today */
  bought: number
  /** months of warranty from purchase */
  warranty?: number
  /** hand it to the person who asked for the demo */
  held?: boolean
  repair?: string
}

const CATEGORIES = ['Laptops', 'Monitors', 'Phones', 'Peripherals', 'Furniture', 'Networking']

const ITEMS: ItemSeed[] = [
  // Laptops — the fleet, most of it out with people
  {
    name: 'MacBook Pro 14"',
    category: 'Laptops',
    serial: 'C02XR1TQ',
    location: 'Head office',
    price: 219900,
    bought: -420,
    warranty: 36,
    held: true,
  },
  {
    name: 'MacBook Pro 14"',
    category: 'Laptops',
    serial: 'C02XR2WM',
    location: 'Head office',
    price: 219900,
    bought: -400,
    warranty: 36,
  },
  {
    name: 'MacBook Air 13"',
    category: 'Laptops',
    serial: 'C02YT8KL',
    location: 'Head office',
    price: 129900,
    bought: -310,
    warranty: 36,
  },
  {
    name: 'MacBook Air 13"',
    category: 'Laptops',
    serial: 'C02YT9PN',
    location: 'Head office',
    price: 129900,
    bought: -305,
    warranty: 36,
  },
  {
    name: 'ThinkPad X1 Carbon',
    category: 'Laptops',
    serial: 'PF3K8LQ2',
    location: 'Head office',
    price: 174900,
    bought: -260,
    warranty: 36,
  },
  {
    name: 'ThinkPad X1 Carbon',
    category: 'Laptops',
    serial: 'PF3K9MR4',
    location: 'Head office',
    price: 174900,
    bought: -255,
    warranty: 36,
  },
  {
    name: 'ThinkPad T14',
    category: 'Laptops',
    serial: 'PF2H6DD1',
    location: 'Storage cupboard',
    price: 139900,
    bought: -600,
    warranty: 24,
  },
  {
    name: 'Dell XPS 15',
    category: 'Laptops',
    serial: 'DXP5-8827',
    location: 'Head office',
    price: 189900,
    bought: -180,
    warranty: 36,
    repair: 'Battery swells under the trackpad; no longer sits flat.',
  },

  // Monitors
  {
    name: 'Dell UltraSharp 27"',
    category: 'Monitors',
    serial: 'CN0J8T27',
    location: 'Head office',
    price: 54900,
    bought: -430,
    warranty: 36,
  },
  {
    name: 'Dell UltraSharp 27"',
    category: 'Monitors',
    serial: 'CN0J8T28',
    location: 'Head office',
    price: 54900,
    bought: -430,
    warranty: 36,
  },
  {
    name: 'Dell UltraSharp 27"',
    category: 'Monitors',
    serial: 'CN0J8T29',
    location: 'Head office',
    price: 54900,
    bought: -430,
    warranty: 36,
  },
  {
    name: 'LG UltraFine 32"',
    category: 'Monitors',
    serial: 'LGU-31182',
    location: 'Head office',
    price: 109900,
    bought: -210,
    warranty: 24,
    held: true,
  },
  {
    name: 'LG UltraFine 32"',
    category: 'Monitors',
    serial: 'LGU-31183',
    location: 'Storage cupboard',
    price: 109900,
    bought: -210,
    warranty: 24,
  },
  {
    name: 'BenQ PD2705U',
    category: 'Monitors',
    serial: 'BQ-99120',
    location: 'Head office',
    price: 62900,
    bought: -95,
    warranty: 36,
  },

  // Phones
  {
    name: 'iPhone 15',
    category: 'Phones',
    serial: 'F17XQ8P1',
    location: 'Head office',
    price: 89900,
    bought: -150,
    warranty: 12,
  },
  {
    name: 'iPhone 15',
    category: 'Phones',
    serial: 'F17XQ9R3',
    location: 'Head office',
    price: 89900,
    bought: -150,
    warranty: 12,
  },
  {
    name: 'Pixel 8',
    category: 'Phones',
    serial: 'GP8-40021',
    location: 'Head office',
    price: 74900,
    bought: -120,
    warranty: 24,
  },
  {
    name: 'Pixel 8',
    category: 'Phones',
    serial: 'GP8-40022',
    location: 'Test bench',
    price: 74900,
    bought: -120,
    warranty: 24,
  },
  {
    name: 'iPad Air',
    category: 'Phones',
    serial: 'DMPQ7L2K',
    location: 'Test bench',
    price: 69900,
    bought: -340,
    warranty: 12,
  },

  // Peripherals
  {
    name: 'Logitech MX Master 3S',
    category: 'Peripherals',
    serial: 'LG-MX-7781',
    location: 'Head office',
    price: 10900,
    bought: -200,
  },
  {
    name: 'Logitech MX Master 3S',
    category: 'Peripherals',
    serial: 'LG-MX-7782',
    location: 'Head office',
    price: 10900,
    bought: -200,
  },
  {
    name: 'Logitech MX Master 3S',
    category: 'Peripherals',
    serial: 'LG-MX-7783',
    location: 'Storage cupboard',
    price: 10900,
    bought: -200,
  },
  {
    name: 'Apple Magic Keyboard',
    category: 'Peripherals',
    serial: 'AMK-22910',
    location: 'Head office',
    price: 14900,
    bought: -260,
  },
  {
    name: 'Apple Magic Keyboard',
    category: 'Peripherals',
    serial: 'AMK-22911',
    location: 'Head office',
    price: 14900,
    bought: -260,
  },
  {
    name: 'Sony WH-1000XM5',
    category: 'Peripherals',
    serial: 'SNY-5X1188',
    location: 'Head office',
    price: 37900,
    bought: -110,
    warranty: 24,
    held: true,
  },
  {
    name: 'Sony WH-1000XM5',
    category: 'Peripherals',
    serial: 'SNY-5X1189',
    location: 'Head office',
    price: 37900,
    bought: -110,
    warranty: 24,
  },
  {
    name: 'Elgato Key Light',
    category: 'Peripherals',
    serial: 'EKL-3320',
    location: 'Meeting room 1',
    price: 19900,
    bought: -290,
  },
  {
    name: 'Anker 12-port hub',
    category: 'Peripherals',
    serial: 'ANK-H1290',
    location: 'Storage cupboard',
    price: 8900,
    bought: -380,
    repair: 'Two ports dead; the rest work.',
  },

  // Furniture
  {
    name: 'Herman Miller Aeron',
    category: 'Furniture',
    serial: 'HM-AER-0041',
    location: 'Head office',
    price: 129900,
    bought: -740,
    warranty: 144,
  },
  {
    name: 'Herman Miller Aeron',
    category: 'Furniture',
    serial: 'HM-AER-0042',
    location: 'Head office',
    price: 129900,
    bought: -740,
    warranty: 144,
  },
  {
    name: 'Herman Miller Aeron',
    category: 'Furniture',
    serial: 'HM-AER-0043',
    location: 'Head office',
    price: 129900,
    bought: -740,
    warranty: 144,
  },
  {
    name: 'Standing desk 160×80',
    category: 'Furniture',
    serial: 'SD-160-118',
    location: 'Head office',
    price: 64900,
    bought: -700,
    warranty: 60,
  },
  {
    name: 'Standing desk 160×80',
    category: 'Furniture',
    serial: 'SD-160-119',
    location: 'Head office',
    price: 64900,
    bought: -700,
    warranty: 60,
  },
  {
    name: 'Meeting table 240cm',
    category: 'Furniture',
    serial: 'MT-240-004',
    location: 'Meeting room 1',
    price: 149900,
    bought: -730,
    warranty: 60,
  },
  {
    name: 'Whiteboard 180×120',
    category: 'Furniture',
    serial: 'WB-180-011',
    location: 'Meeting room 2',
    price: 24900,
    bought: -690,
  },

  // Networking
  {
    name: 'UniFi Dream Machine Pro',
    category: 'Networking',
    serial: 'UDM-P-77120',
    location: 'Server cupboard',
    price: 42900,
    bought: -520,
    warranty: 24,
  },
  {
    name: 'UniFi Switch 24 PoE',
    category: 'Networking',
    serial: 'USW-24-3391',
    location: 'Server cupboard',
    price: 59900,
    bought: -520,
    warranty: 24,
  },
  {
    name: 'UniFi Access Point U6',
    category: 'Networking',
    serial: 'U6-LR-8821',
    location: 'Head office',
    price: 17900,
    bought: -515,
    warranty: 24,
  },
  {
    name: 'UniFi Access Point U6',
    category: 'Networking',
    serial: 'U6-LR-8822',
    location: 'Meeting room 1',
    price: 17900,
    bought: -515,
    warranty: 24,
  },
  {
    name: 'APC Smart-UPS 1500',
    category: 'Networking',
    serial: 'APC-SU-2214',
    location: 'Server cupboard',
    price: 74900,
    bought: -640,
    warranty: 36,
  },
]

/** Workspace fields somebody would actually add, so the field editor is not an empty screen. */
const FIELDS: Array<{ key: string; name: string; type: FieldType; options?: string[] }> = [
  { key: 'condition', name: 'Condition', type: 'select', options: ['New', 'Good', 'Worn', 'Damaged'] },
  { key: 'asset_tag', name: 'Asset tag', type: 'text' },
  { key: 'insured', name: 'Insured', type: 'checkbox' },
]

export async function seedInventoryDemo(ctx: DemoSeedContext): Promise<DemoSeedSummary> {
  const { kernel, workspaceId, actorId, now } = ctx
  const svc = inventoryServices(kernel)
  const format = await svc.assets.codeFormat(workspaceId)

  return kernel.database.withWorkspace(
    workspaceId,
    async (tx) => {
      /*
       * See the tracker's seeder for why the guard reads the table rather than a marker row — and
       * why `workspace_id` is in the predicate instead of being left to row-level security. An
       * unscoped guard sees another workspace's assets on any database whose owner can bypass a
       * policy, and reports an empty workspace as used.
       */
      const [existing] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.workspaceId, workspaceId))
        .limit(1)
      if (existing) return { skipped: true }

      /*
       * The categories are *found or made*, because `onWorkspaceEnabled` has already put five of
       * them there — Laptops, Phones, Monitors, Furniture, Vehicles — and `CategoryService.create`
       * refuses a duplicate name with a conflict, which would abort the whole seed on its first
       * statement. Measured: the first run of this seeder died on "This workspace already has a
       * category called Laptops".
       */
      const present = await tx
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.workspaceId, workspaceId))
      const categoryIds = new Map(present.map((c) => [c.name, c.id]))
      let categoriesMade = 0
      for (const name of CATEGORIES) {
        if (categoryIds.has(name)) continue
        const row = await svc.categories.create(tx, workspaceId, name)
        categoryIds.set(name, row.id)
        categoriesMade += 1
      }

      for (const f of FIELDS)
        await svc.fields.create(tx, workspaceId, {
          key: f.key,
          name: f.name,
          type: f.type,
          ...(f.options ? { options: f.options } : {}),
        })

      let created = 0
      let handed = 0
      let repairs = 0
      const conditions = ['New', 'Good', 'Good', 'Good', 'Worn']

      for (const [index, item] of ITEMS.entries()) {
        const written = await svc.assets.create(
          tx,
          workspaceId,
          actorId,
          {
            name: item.name,
            description: '',
            categoryId: categoryIds.get(item.category) ?? null,
            serialNumber: item.serial,
            location: item.location,
            purchasedOn: at(now, item.bought),
            priceMinor: item.price,
            currency: 'EUR',
            ...(item.warranty ? { warrantyUntil: at(now, item.bought + item.warranty * 30) } : {}),
            custom: {
              condition: conditions[index % conditions.length],
              asset_tag: `AT-${String(1000 + index)}`,
              insured: item.price >= 100000,
            },
          },
          format,
        )
        created += 1

        /*
         * Only the items marked `held` are handed over, and they go to whoever asked for the demo —
         * the one account this workspace has. Handing items to invented user ids would give the
         * custody column names that resolve to nothing, which reads as broken rather than as a demo.
         */
        if (item.held && actorId) {
          await svc.custody
            .assign(tx, workspaceId, actorId, written.row.id, actorId, 'Issued on the first day', true)
            .catch(() => undefined)
          handed += 1
        }

        if (item.repair) {
          await svc.repairs.create(tx, workspaceId, actorId, written.row.id, {
            summary: item.repair,
            vendor: 'Northline IT Services',
            sentOn: at(now, -9),
          })
          repairs += 1
        }
      }

      return { created: { categories: categoriesMade, assets: created, custody: handed, repairs } }
    },
    { userId: actorId },
  )
}
