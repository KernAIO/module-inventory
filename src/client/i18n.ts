import { type Message, scopedT } from '@kernhq/ui'

/**
 * This module's own strings, in every locale the platform ships.
 *
 * A module ships separately from the app, so Paraglide — which compiles only the app's
 * `messages/*.json` — cannot see these. The shell merges them into the framework's message runtime
 * when it registers the module, and `t()` resolves against the merged map. Keys are namespaced by
 * module id, which is what keeps two modules from colliding in that one map.
 *
 * A **counted** message is not a string with `{count}` in it: give it a map of CLDR plural category
 * to string and `t(key, { n })` picks the form. English has two and Arabic has six, and which one
 * applies is `Intl.PluralRules`' answer rather than yours.
 *
 * Words every module needs and none owns — Save, Cancel, Retry — come from the framework's `common`
 * bundle (`t('common.save')`). Do not copy them here; six translations of "Save" drift apart.
 */

export const en: Record<string, Message> = {
  'inventory.nav': 'Inventory',
  'inventory.title': 'Assets',
  'inventory.empty': 'No assets yet',
  'inventory.empty_desc': 'Add the first laptop, phone or desk — anything the company owns.',
  'inventory.new': 'New asset',
  'inventory.edit': 'Edit asset',
  'inventory.code': 'Asset tag',
  'inventory.name': 'Name',
  'inventory.name_placeholder': 'MacBook Pro 14", office chair…',
  'inventory.description': 'Description',
  'inventory.category': 'Category',
  'inventory.serial_number': 'Serial number',
  'inventory.location': 'Location',
  'inventory.purchased_on': 'Purchase date',
  'inventory.purchased_from': 'Purchased from',
  'inventory.price': 'Price',
  'inventory.warranty_until': 'Warranty until',
  'inventory.status_in_stock': 'In stock',
  'inventory.status_assigned': 'Assigned',
  'inventory.status_under_repair': 'Under repair',
  'inventory.status_retired': 'Retired',
  'inventory.count': { one: '{n} asset', other: '{n} assets' },
  'inventory.search_placeholder': 'Search by name, tag or serial…',
  'inventory.filter_all_statuses': 'All statuses',
  'inventory.archived': 'Archived',
  'inventory.archive': 'Archive',
  'inventory.restore': 'Restore',
  'inventory.widget_title': 'Recent assets',
  'inventory.widget_desc': 'The most recently added assets in this workspace.',
}

export type InventoryMessageKey = keyof typeof en

export const fa: Record<string, Message> = {
  'inventory.nav': 'اموال',
  'inventory.title': 'اقلام',
  'inventory.empty': 'هنوز قلمی ثبت نشده است',
  'inventory.empty_desc': 'اولین لپ‌تاپ، گوشی یا میز را اضافه کنید — هر چیزی که شرکت دارد.',
  'inventory.new': 'قلم جدید',
  'inventory.edit': 'ویرایش قلم',
  'inventory.code': 'کد قلم',
  'inventory.name': 'نام',
  'inventory.name_placeholder': 'مک‌بوک پرو ۱۴ اینچ، صندلی اداری…',
  'inventory.description': 'توضیحات',
  'inventory.category': 'دسته',
  'inventory.serial_number': 'شماره سریال',
  'inventory.location': 'محل استقرار',
  'inventory.purchased_on': 'تاریخ خرید',
  'inventory.purchased_from': 'خریداری از',
  'inventory.price': 'قیمت',
  'inventory.warranty_until': 'گارانتی تا',
  'inventory.status_in_stock': 'در انبار',
  'inventory.status_assigned': 'تحویل‌شده',
  'inventory.status_under_repair': 'در تعمیر',
  'inventory.status_retired': 'اسقاط‌شده',
  'inventory.count': { one: '{n} قلم', other: '{n} قلم' },
  'inventory.search_placeholder': 'جستجو بر اساس نام، کد یا سریال…',
  'inventory.filter_all_statuses': 'همه وضعیت‌ها',
  'inventory.archived': 'بایگانی‌شده',
  'inventory.archive': 'بایگانی',
  'inventory.restore': 'بازگردانی',
  'inventory.widget_title': 'اقلام اخیر',
  'inventory.widget_desc': 'آخرین اقلامی که به این فضای کاری اضافه شده‌اند.',
}

export const ar: Record<string, Message> = {
  'inventory.nav': 'الأصول',
  'inventory.title': 'الأصول',
  'inventory.empty': 'لا أصول بعد',
  'inventory.empty_desc': 'أضف أول حاسوب أو هاتف أو مكتب — أي شيء تملكه الشركة.',
  'inventory.new': 'أصل جديد',
  'inventory.edit': 'تعديل الأصل',
  'inventory.code': 'رمز الأصل',
  'inventory.name': 'الاسم',
  'inventory.name_placeholder': 'حاسوب ماك بوك برو ١٤، كرسي مكتبي…',
  'inventory.description': 'الوصف',
  'inventory.category': 'الفئة',
  'inventory.serial_number': 'الرقم التسلسلي',
  'inventory.location': 'الموقع',
  'inventory.purchased_on': 'تاريخ الشراء',
  'inventory.purchased_from': 'تم الشراء من',
  'inventory.price': 'السعر',
  'inventory.warranty_until': 'الضمان حتى',
  'inventory.status_in_stock': 'في المخزن',
  'inventory.status_assigned': 'مُسلَّم',
  'inventory.status_under_repair': 'قيد الإصلاح',
  'inventory.status_retired': 'مستبعد',
  'inventory.count': {
    zero: 'لا أصول',
    one: 'أصل واحد',
    two: 'أصلان',
    few: '{n} أصول',
    many: '{n} أصلاً',
    other: '{n} أصل',
  },
  'inventory.search_placeholder': 'ابحث بالاسم أو الرمز أو الرقم التسلسلي…',
  'inventory.filter_all_statuses': 'جميع الحالات',
  'inventory.archived': 'مؤرشف',
  'inventory.archive': 'أرشفة',
  'inventory.restore': 'استعادة',
  'inventory.widget_title': 'أصول حديثة',
  'inventory.widget_desc': 'الأصول المضافة أخيرًا إلى مساحة العمل هذه.',
}

export const de: Record<string, Message> = {
  'inventory.nav': 'Inventar',
  'inventory.title': 'Gegenstände',
  'inventory.empty': 'Noch keine Gegenstände',
  'inventory.empty_desc':
    'Fügen Sie den ersten Laptop, das erste Telefon oder den ersten Schreibtisch hinzu — alles, was die Firma besitzt.',
  'inventory.new': 'Neuer Gegenstand',
  'inventory.edit': 'Gegenstand bearbeiten',
  'inventory.code': 'Inventarnummer',
  'inventory.name': 'Name',
  'inventory.name_placeholder': 'MacBook Pro 14", Bürostuhl…',
  'inventory.description': 'Beschreibung',
  'inventory.category': 'Kategorie',
  'inventory.serial_number': 'Seriennummer',
  'inventory.location': 'Standort',
  'inventory.purchased_on': 'Kaufdatum',
  'inventory.purchased_from': 'Gekauft bei',
  'inventory.price': 'Preis',
  'inventory.warranty_until': 'Garantie bis',
  'inventory.status_in_stock': 'Auf Lager',
  'inventory.status_assigned': 'Zugewiesen',
  'inventory.status_under_repair': 'In Reparatur',
  'inventory.status_retired': 'Ausgemustert',
  'inventory.count': { one: '{n} Gegenstand', other: '{n} Gegenstände' },
  'inventory.search_placeholder': 'Nach Name, Nummer oder Seriennummer suchen…',
  'inventory.filter_all_statuses': 'Alle Zustände',
  'inventory.archived': 'Archiviert',
  'inventory.archive': 'Archivieren',
  'inventory.restore': 'Wiederherstellen',
  'inventory.widget_title': 'Neue Gegenstände',
  'inventory.widget_desc': 'Die zuletzt hinzugefügten Gegenstände dieses Arbeitsbereichs.',
}

/**
 * Add a locale by adding a bundle here. Bundles are thunks so a locale is fetched only when it is
 * the one in use; English is the fallback and is therefore always loaded.
 */
export const inventoryMessageBundles = {
  ar: async () => ar,
  de: async () => de,
  en: async () => en,
  fa: async () => fa,
}

/** `t('nav')` — the module id is implied. `t('common.save')` still reaches the shared bundle. */
export const t = scopedT('inventory')
