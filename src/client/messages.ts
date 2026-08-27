import type { Message } from '@kernhq/ui'

/**
 * This module's strings, in every locale the platform ships.
 *
 * **Data only, and deliberately so:** this file imports nothing but a type, which is what lets a
 * test load the bundles and check them. `i18n.ts` next door pulls in `@kernhq/ui` for `scopedT`,
 * and that entry point reaches the Svelte components — so anything importing it drags a compiler
 * into whatever is doing the importing. Keys, plural forms and placeholders are checkable facts;
 * keeping them behind that import made them uncheckable.
 *
 * A module ships separately from the app, so Paraglide — which compiles only the app's
 * `messages/*.json` — cannot see these. The shell merges them into the framework's message runtime
 * when it registers the module. Keys are namespaced by module id, which is what keeps two modules
 * from colliding in that one map.
 *
 * A **counted** message is not a string with `{n}` in it: give it a map of CLDR plural category to
 * string and `t(key, { n })` picks the form. English has two and Arabic has six, and which one
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
  'inventory.status': 'Status',
  'inventory.serial_number': 'Serial number',
  'inventory.location': 'Location',
  'inventory.purchased_on': 'Purchase date',
  'inventory.purchased_from': 'Purchased from',
  'inventory.price': 'Price',
  'inventory.warranty_until': 'Warranty until',
  'inventory.status_in_stock': 'In stock',
  'inventory.status_assigned': 'Assigned',
  'inventory.status_reserved': 'Reserved',
  'inventory.status_under_repair': 'Under repair',
  'inventory.status_lost': 'Lost',
  'inventory.status_retired': 'Retired',
  'inventory.currency': 'Currency',
  'inventory.price_invalid': 'Enter an amount like {example}',
  'inventory.count': { one: '{n} asset', other: '{n} assets' },
  'inventory.count_showing': { one: 'Showing {n} asset', other: 'Showing {n} assets' },
  'inventory.search_placeholder': 'Search by name, tag or serial…',
  'inventory.filter_all_statuses': 'All statuses',
  'inventory.archived': 'Archived',
  'inventory.restore': 'Restore',
  'inventory.show_archived': 'Show archived',
  'inventory.load_more': 'Load more',
  'inventory.row_actions': 'Actions for {name}',
  'inventory.archive_title': 'Archive {name}?',
  'inventory.archive_body':
    'It stops appearing in the list and keeps its tag. Nothing is deleted, and you can restore it at any time.',
  'inventory.archived_toast': '{name} archived',
  'inventory.restored_toast': '{name} restored',
  'inventory.created_toast': '{name} added',
  'inventory.updated_toast': '{name} updated',
  'inventory.load_error': 'The assets could not be loaded',
  'inventory.no_matches': 'Nothing matched',
  'inventory.no_matches_desc': 'No asset matches this search or these filters.',
  'inventory.clear_filters': 'Clear filters',
  'inventory.settings_general': 'General',
  'inventory.settings_general_desc': 'How this workspace numbers the things it owns.',
  'inventory.settings_numbering': 'Asset tags',
  'inventory.settings_numbering_desc':
    'The shape of every tag issued from now on. Tags already on a sticker keep the shape they were issued with.',
  'inventory.settings_prefix': 'Prefix',
  'inventory.settings_prefix_hint': 'Up to 8 characters, or none for numbers alone.',
  'inventory.settings_prefix_too_long': 'Use 8 characters or fewer',
  'inventory.settings_pad': 'Digits',
  'inventory.settings_pad_hint': 'How many digits the number is padded out to.',
  'inventory.settings_pad_invalid': 'Use a whole number from 1 to 10',
  // "Example", not "Next tag": the counter is a row in the module's own table rather than a
  // setting, so this page cannot know what the next tag will be and must not imply that it does.
  'inventory.settings_preview': 'Example tag',
  // Not "Asset tag settings saved" any more: this page saves the notice windows too, and a toast
  // naming half of what it just wrote is a toast that will be wrong again the next time.
  'inventory.settings_saved': 'Settings saved',
  // There is deliberately no `settings_save_error`. The save bar renders `errorMessage(err, t)`,
  // which names the actual refusal — "You are not allowed to do that", "Your session has ended" —
  // and a generic "could not be saved" above it would say strictly less while being one more
  // string to keep true in five languages.
  'inventory.settings_error': 'The settings could not be loaded',
  'inventory.settings_readonly': 'You can read these settings but not change them.',
  'inventory.settings_not_enabled': 'Inventory is not enabled in this workspace',

  // ---- the two nightly sweeps, and the one filter they link to ------------------------------
  'inventory.settings_notices': 'Notices',
  'inventory.settings_notices_desc':
    'When this workspace is told that a warranty is running out, or that an item has been at a repairer too long.',
  'inventory.settings_warranty_days': 'Warn this many days ahead',
  'inventory.settings_warranty_days_hint':
    'How far ahead of a warranty expiring somebody is told. Once per item, to whoever is holding it.',
  'inventory.settings_repair_days': 'Chase a repair after this many days',
  'inventory.settings_repair_days_hint':
    'How long an item may be away before the person who logged the repair is asked to chase it.',
  'inventory.settings_days_invalid': 'Enter a whole number of days between 1 and 365',
  'inventory.held_by': 'Held by {name}',
  'inventory.held_by_clear': 'Show every asset',
  'inventory.widget_title': 'Recent assets',
  'inventory.widget_desc': 'The most recently added assets in this workspace.',

  // ---- categories -------------------------------------------------------------------------
  'inventory.category': 'Category',
  'inventory.category_none': 'Uncategorised',
  'inventory.filter_all_categories': 'All categories',
  'inventory.categories_error': 'The categories could not be loaded',
  'inventory.settings_categories': 'Categories',
  'inventory.settings_categories_desc': 'How this workspace groups the things it owns.',
  'inventory.categories_empty': 'No categories yet',
  'inventory.categories_empty_desc':
    'Group what the company owns — laptops, furniture, cameras — so a long list can be narrowed to one kind of thing.',
  // Not the same sentence as having none: this workspace has categories and is looking at none of
  // them. Saying "No categories yet" beside a New category button, to somebody who archived all
  // five of theirs, both misreports the register and offers the wrong way out.
  'inventory.categories_all_archived': 'Every category is archived',
  'inventory.categories_all_archived_desc':
    'Show the archived ones to bring one back, or add a new category.',
  'inventory.category_new': 'New category',
  'inventory.category_edit': 'Edit category',
  'inventory.category_name_placeholder': 'Laptops, Furniture, Cameras…',
  'inventory.category_order': 'Position',
  'inventory.category_order_hint':
    'Lower comes first. Categories sharing a position fall back to their names.',
  // A hint and an error are not the same sentence. This field passed the hint as both, so typing
  // "x" restated how positions sort — in red, under a field whose problem was that it held no
  // number. An error says what is wrong with what is there.
  'inventory.category_order_invalid': 'Use a whole number from 0 to 9999',
  'inventory.category_created_toast': '{name} added',
  'inventory.category_updated_toast': '{name} saved',
  'inventory.category_archived_toast': '{name} archived',
  'inventory.category_restored_toast': '{name} restored',
  'inventory.category_archive_title': 'Archive {name}?',
  // Says what survives, not "Are you sure?" — the whole reason this archives rather than deletes.
  'inventory.category_archive_body':
    'It leaves the picker and the filter. Assets already filed under it keep it and go on saying what they are, and you can restore it at any time.',

  // ---- custody ----------------------------------------------------------------------------
  'inventory.custody': 'Custody',
  'inventory.custody_holder': 'Held by',
  'inventory.custody_nobody': 'Nobody — it is in stock',
  'inventory.custody_since': 'Held since {date}',
  'inventory.custody_assign': 'Hand over',
  'inventory.custody_transfer': 'Hand on',
  'inventory.custody_return': 'Take back',
  'inventory.custody_assign_title': 'Hand over {name}',
  'inventory.custody_transfer_title': 'Hand on {name}',
  'inventory.custody_return_title': 'Take back {name}?',
  'inventory.custody_return_body': 'It goes back into stock, and {person} stops being answerable for it.',
  'inventory.custody_person': 'Who is taking it',
  'inventory.custody_person_none': 'Choose someone',
  'inventory.custody_note': 'Note',
  'inventory.custody_note_hint': 'Optional — where it is going, or what it is for.',
  'inventory.custody_assigned_toast': '{name} handed to {person}',
  'inventory.custody_transferred_toast': '{name} handed on to {person}',
  'inventory.custody_returned_toast': '{name} taken back',
  'inventory.custody_previous': 'Previous holders',
  'inventory.custody_empty': 'Nobody has held this yet',
  'inventory.custody_empty_desc': 'Hand it to somebody and the handover is recorded here.',
  'inventory.custody_error': 'The custody record could not be loaded',
  'inventory.custody_archived_hint': 'Restore this item before handing it over.',
  // Who a stored id turns out to be, when it is not somebody the workspace still has — and the two
  // states that are not that at all. `member_former` is a claim: it says this person has left. It
  // was shown for both of the others too, so every timeline read "A former member handed it to A
  // former member" until the member list arrived, and for ever if it failed.
  'inventory.member_former': 'A former member',
  'inventory.member_system': 'The system',
  // Not yet known: the list is still in flight. Punctuation rather than a word, because it stands
  // inside a sentence for a second — "… handed it to …" — and any word there would be a claim.
  'inventory.member_loading': '…',
  // Known to be somebody, and which somebody cannot be found out: the members request failed. A
  // fact about the request, never about the person.
  'inventory.member_unknown': 'Someone',

  // ---- history ----------------------------------------------------------------------------
  'inventory.history': 'History',
  'inventory.history_empty': 'Nothing has happened to this yet',
  'inventory.history_error': 'The history could not be loaded',
  // One sentence per action. `actionKey()` in `timeline.ts` builds these key names, so a key here
  // and a name there are one pair — and `history_unknown` is what an action written by a newer
  // image resolves to rather than a wrong sentence.
  'inventory.history_created': '{actor} added it',
  'inventory.history_updated': '{actor} edited it',
  'inventory.history_assigned': '{actor} handed it to {person}',
  'inventory.history_transferred': '{actor} handed it on to {person}',
  'inventory.history_returned': '{actor} took it back from {person}',
  'inventory.history_retired': '{actor} archived it',
  'inventory.history_restored': '{actor} restored it',
  'inventory.history_unknown': '{actor} changed it — {action}',
  'inventory.history_set': '{field} set to {to}',
  'inventory.history_cleared': '{field} cleared',
  'inventory.history_changed': '{field} changed from {from} to {to}',
  // For a field whose value is an opaque id — a photo — where naming the value would print a uuid.
  'inventory.history_replaced': '{field} replaced',
  // A description is up to eight thousand characters, so "changed from … to …" put sixteen
  // kilobytes of somebody's prose in one row of a 440px panel and pushed every entry below it off
  // the screen. It says *that* it changed; the text is one keystroke away, labelled and in full.
  'inventory.history_text_changed': '{field} changed',
  'inventory.history_show_text': 'Show the text',
  'inventory.history_text_before': 'Before',
  'inventory.history_text_after': 'After',
  'inventory.history_note': 'Note: {note}',
  // A repair's summary and a file's name are printed under these as a second line, bare — they are
  // text somebody typed, so there is nothing to translate around them.
  'inventory.history_repair_logged': '{actor} sent it for repair',
  'inventory.history_repair_completed': '{actor} logged it as back from repair',
  'inventory.history_attachment_added': '{actor} attached a file',
  'inventory.history_attachment_removed': '{actor} removed a file',

  // ---- the asset panel --------------------------------------------------------------------
  'inventory.details': 'Details',
  'inventory.open': 'Open',
  'inventory.open_asset': 'Open {name}',
  'inventory.asset_error': 'This asset could not be loaded',
  'inventory.added_on': 'Added',
  'inventory.updated_on': 'Last changed',
  'inventory.photo': 'Photo',

  // ---- repairs ----------------------------------------------------------------------------
  'inventory.repairs': 'Repairs',
  'inventory.repairs_error': 'The repairs could not be loaded',
  'inventory.repairs_empty': 'Nothing has been repaired yet',
  'inventory.repairs_empty_desc':
    'When something goes away to be fixed, record it here so the register can say where it is.',
  'inventory.repair_new': 'Send for repair',
  'inventory.repair_edit': 'Edit repair',
  'inventory.repair_summary': 'What is wrong',
  'inventory.repair_summary_placeholder': 'Cracked screen, new battery…',
  'inventory.repair_detail': 'Details',
  'inventory.repair_vendor': 'Repairer',
  'inventory.repair_vendor_placeholder': 'Who is fixing it',
  'inventory.repair_cost': 'Cost',
  'inventory.repair_sent_on': 'Sent',
  'inventory.repair_returned_on': 'Came back',
  'inventory.repair_current': 'Away for repair',
  'inventory.repair_past': 'Past repairs',
  'inventory.repair_away_since': 'Away since {date}',
  'inventory.repair_complete': 'Log it as returned',
  'inventory.repair_complete_title': 'Log {name} as returned?',
  'inventory.repair_complete_body':
    'It goes back to whoever is holding it, or into stock if nobody is. Add the cost if the invoice has arrived.',
  'inventory.repair_logged_toast': '{name} sent for repair',
  'inventory.repair_saved_toast': 'Repair saved',
  'inventory.repair_completed_toast': '{name} logged as returned',
  'inventory.repair_archived_hint': 'Restore this item before sending it for repair.',
  'inventory.widget_repairs_title': 'Out for repair',
  'inventory.widget_repairs_desc': 'Everything that is away being fixed right now.',
  'inventory.widget_repairs_empty': 'Nothing is away for repair',

  // ---- files ------------------------------------------------------------------------------
  'inventory.files': 'Files',
  'inventory.files_error': 'The files could not be loaded',
  'inventory.files_empty': 'No files yet',
  'inventory.files_empty_desc':
    'Keep the receipt, the warranty card and the manual with the item they belong to.',
  'inventory.file_add': 'Add a file',
  'inventory.file_download': 'Download {name}',
  'inventory.file_remove': 'Remove {name}',
  'inventory.file_remove_title': 'Remove {name}?',
  // Says what survives: this module records that a file belongs to an item, and never owns the file.
  'inventory.file_remove_body':
    'It stops being listed against this item. The file itself is not deleted, and anywhere else it is attached keeps it.',
  'inventory.file_removed_toast': '{name} removed',
  'inventory.file_added_toast': { one: '{n} file added', other: '{n} files added' },
  'inventory.file_upload_failed': '{name} could not be uploaded',
  // What a row is called when the file's own record could not be read. It is a label this module
  // prints, so it is translated — it was a hardcoded English literal in `api-instance.ts`.
  'inventory.file_unnamed': 'Uploaded file',

  // ---- the photo, which is a field of the asset rather than one of its files ---------------
  'inventory.photo_none': 'No photo yet',
  'inventory.photo_set': 'Choose a photo',
  'inventory.photo_replace': 'Replace the photo',
  'inventory.photo_remove': 'Remove the photo',
  'inventory.photo_saved_toast': 'Photo saved',
  'inventory.photo_removed_toast': 'Photo removed',
  'inventory.photo_alt': 'Photo of {name}',

  // ---- the register in numbers ------------------------------------------------------------
  'inventory.stats_total': 'Assets',
  'inventory.stats_unassigned': 'Nobody holding',
  'inventory.stats_out_for_repair': 'Out for repair',

  // ---- what a refusal reads as ------------------------------------------------------------
  // Every screen used to show `error.message`, which is a sentence the *server* wrote, in English,
  // to a reader who chose Persian. `errors.ts` maps the stable `reason` token each refusal carries
  // — `inventory.custody.already_held` and the rest — onto these, and falls back to the class of
  // failure. The wording is what the reader can do next, not an apology.
  'inventory.error_custody_conflict':
    'Somebody changed who is holding this a moment before you did. Reload the page to see where it is now.',
  'inventory.error_custody_archived': 'This item is archived. Restore it before handing it over.',
  'inventory.error_custody_already_held':
    'Somebody is already holding this. Hand it on, or take it back first.',
  'inventory.error_custody_not_held':
    'Nobody is holding this, so there is nothing to hand on. Hand it over instead.',
  'inventory.error_asset_still_held': 'Somebody is still holding this. Take it back before archiving it.',
  'inventory.error_asset_under_repair':
    'This item is away for repair. Log it as returned before archiving it.',
  'inventory.error_repair_already_open':
    'This item is already away for repair. Log that repair as returned first.',
  'inventory.error_repair_archived': 'This item is archived. Restore it before sending it for repair.',
  'inventory.error_repair_already_complete': 'This repair is already logged as finished.',
  'inventory.error_repair_returned_before_sent':
    'A repair cannot come back before it was sent. Check the two dates.',
  'inventory.error_category_name_taken': 'This workspace already has a category with that name.',
  // The classes of failure, for a refusal carrying no reason of its own. A capability switched off
  // answers 404 rather than 403 — that is the module contract — so it lands on `not_found`, which
  // is the right sentence for it: the surface is not there any more, look again.
  'inventory.error_not_found':
    'That is no longer there. Somebody may have removed or archived it — reload the page to see.',
  'inventory.error_forbidden': 'You are not allowed to do that.',
  'inventory.error_module_disabled': 'Inventory is switched off in this workspace.',
  'inventory.error_conflict': 'Somebody changed this a moment before you did. Reload the page and try again.',
  'inventory.error_bad_request': 'Something in the form was not accepted. Check what you entered.',
  // Not the same failure, and it used to borrow that sentence. A service refusing — the person is
  // not a member of this workspace, the file has not finished uploading — arrives as the same
  // `BAD_REQUEST` as a schema rejecting a field, and "check what you entered" sent people to hunt
  // through a form where nothing was wrong. This one says only what is true and lets the server's
  // own explanation follow it.
  'inventory.error_refused': 'That was not accepted.',
  'inventory.error_unauthorized': 'Your session has ended. Sign in again.',
  'inventory.error_rate_limited': 'Too many requests just now. Wait a moment and try again.',
  'inventory.error_unavailable': 'The server is not answering right now. Try again in a moment.',
  // The last resort, and the only one that keeps the server's own words — under it, as detail. A
  // failure this build has never heard of is one where the server's sentence is the only clue left.
  'inventory.error_unknown': 'That did not work.',
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
  'inventory.status': 'وضعیت',
  'inventory.serial_number': 'شماره سریال',
  'inventory.location': 'محل استقرار',
  'inventory.purchased_on': 'تاریخ خرید',
  'inventory.purchased_from': 'خریداری از',
  'inventory.price': 'قیمت',
  'inventory.warranty_until': 'گارانتی تا',
  'inventory.status_in_stock': 'در انبار',
  'inventory.status_assigned': 'تحویل‌شده',
  'inventory.status_reserved': 'رزروشده',
  'inventory.status_under_repair': 'در تعمیر',
  'inventory.status_lost': 'مفقود',
  'inventory.status_retired': 'اسقاط‌شده',
  'inventory.currency': 'واحد پول',
  'inventory.price_invalid': 'مبلغی مانند {example} وارد کنید',
  'inventory.count': { one: '{n} قلم', other: '{n} قلم' },
  'inventory.count_showing': { one: 'نمایش {n} قلم', other: 'نمایش {n} قلم' },
  // «جست‌وجو» with the ZWNJ, never «جستجو» — `repos/shell/messages/GLOSSARY.md` settles the
  // spelling and the shell's own catalogue writes it that way in all fourteen places it has one.
  'inventory.search_placeholder': 'جست‌وجو بر اساس نام، کد یا سریال…',
  'inventory.filter_all_statuses': 'همه وضعیت‌ها',
  'inventory.archived': 'بایگانی‌شده',
  'inventory.restore': 'بازگردانی',
  'inventory.show_archived': 'نمایش بایگانی‌شده‌ها',
  // The shell's own catalogue says «بارگذاری بیشتر» for this English string (`audit_load_more`);
  // «موارد بیشتر» was a noun phrase where the English is an action, and reached for a noun the rest
  // of this bundle does not use.
  'inventory.load_more': 'بارگذاری بیشتر',
  'inventory.row_actions': 'اقدام‌های {name}',
  'inventory.archive_title': '{name} بایگانی شود؟',
  'inventory.archive_body':
    'از فهرست کنار می‌رود و کد خود را نگه می‌دارد. چیزی حذف نمی‌شود و هر زمان می‌توانید آن را بازگردانید.',
  'inventory.archived_toast': '{name} بایگانی شد',
  'inventory.restored_toast': '{name} بازگردانده شد',
  'inventory.created_toast': '{name} افزوده شد',
  'inventory.updated_toast': '{name} به‌روزرسانی شد',
  'inventory.load_error': 'اقلام بارگذاری نشد',
  'inventory.no_matches': 'چیزی پیدا نشد',
  'inventory.no_matches_desc': 'هیچ قلمی با این جستجو یا این فیلترها همخوانی ندارد.',
  'inventory.clear_filters': 'پاک کردن فیلترها',
  'inventory.settings_general': 'عمومی',
  'inventory.settings_general_desc': 'شیوهٔ شماره‌گذاری اموال در این فضای کاری.',
  'inventory.settings_numbering': 'کد اموال',
  'inventory.settings_numbering_desc':
    'شکل کدهایی که از این پس صادر می‌شود. کدهایی که روی برچسب‌ها هستند تغییر نمی‌کنند.',
  'inventory.settings_prefix': 'پیشوند',
  'inventory.settings_prefix_hint': 'حداکثر ۸ نویسه، یا خالی برای فقط عدد.',
  'inventory.settings_prefix_too_long': 'حداکثر ۸ نویسه',
  'inventory.settings_pad': 'تعداد رقم',
  'inventory.settings_pad_hint': 'عدد تا چند رقم با صفر پر شود.',
  'inventory.settings_pad_invalid': 'عددی درست از ۱ تا ۱۰ وارد کنید',
  'inventory.settings_preview': 'نمونهٔ کد',
  'inventory.settings_saved': 'تنظیمات ذخیره شد',
  'inventory.settings_error': 'تنظیمات بارگذاری نشد',
  'inventory.settings_readonly': 'این تنظیمات را می‌بینید اما نمی‌توانید تغییر دهید.',
  'inventory.settings_not_enabled': 'ماژول اموال در این فضای کاری فعال نیست',

  'inventory.settings_notices': 'اطلاع‌رسانی',
  // The «که» is not optional: without it the clause has no head and the sentence reads as two
  // halves stapled together, which is what a sentence translated word by word from English does.
  'inventory.settings_notices_desc':
    'اینکه چه زمانی به این فضای کاری خبر داده شود که گارانتی قلمی رو به پایان است، یا قلمی بیش از اندازه نزد تعمیرکار مانده است.',
  'inventory.settings_warranty_days': 'چند روز پیش از پایان گارانتی هشدار داده شود',
  'inventory.settings_warranty_days_hint':
    'چقدر پیش از پایان گارانتی به کسی خبر داده شود. برای هر قلم یک بار، به کسی که آن را در اختیار دارد.',
  'inventory.settings_repair_days': 'پس از چند روز پیگیری تعمیر خواسته شود',
  'inventory.settings_repair_days_hint':
    'یک قلم چند روز می‌تواند نزد تعمیرکار بماند تا از کسی که تعمیر را ثبت کرده پیگیری خواسته شود.',
  'inventory.settings_days_invalid': 'عددی درست میان ۱ تا ۳۶۵ روز وارد کنید',
  'inventory.held_by': 'در اختیار {name}',
  'inventory.held_by_clear': 'نمایش همهٔ اقلام',
  'inventory.widget_title': 'اقلام اخیر',
  'inventory.widget_desc': 'آخرین اقلامی که به این فضای کاری اضافه شده‌اند.',

  'inventory.category': 'دسته‌بندی',
  'inventory.category_none': 'بدون دسته‌بندی',
  'inventory.filter_all_categories': 'همهٔ دسته‌بندی‌ها',
  'inventory.categories_error': 'دسته‌بندی‌ها بارگذاری نشد',
  'inventory.settings_categories': 'دسته‌بندی‌ها',
  'inventory.settings_categories_desc': 'شیوهٔ گروه‌بندی اموال در این فضای کاری.',
  'inventory.categories_empty': 'هنوز دسته‌بندی‌ای ساخته نشده است',
  'inventory.categories_empty_desc':
    'آنچه شرکت دارد را گروه‌بندی کنید — لپ‌تاپ، مبلمان، دوربین — تا فهرست بلند به یک نوع محدود شود.',
  'inventory.categories_all_archived': 'همهٔ دسته‌بندی‌ها بایگانی شده‌اند',
  'inventory.categories_all_archived_desc':
    'بایگانی‌شده‌ها را نشان بدهید تا یکی را بازگردانید، یا دستهٔ تازه‌ای بسازید.',
  'inventory.category_new': 'دستهٔ جدید',
  'inventory.category_edit': 'ویرایش دسته‌بندی',
  'inventory.category_name_placeholder': 'لپ‌تاپ، مبلمان، دوربین…',
  'inventory.category_order': 'ترتیب',
  'inventory.category_order_hint': 'عدد کمتر جلوتر می‌آید. دسته‌هایی با ترتیب یکسان بر اساس نام مرتب می‌شوند.',
  'inventory.category_order_invalid': 'عددی درست از ۰ تا ۹۹۹۹ وارد کنید',
  'inventory.category_created_toast': '{name} افزوده شد',
  'inventory.category_updated_toast': '{name} ذخیره شد',
  'inventory.category_archived_toast': '{name} بایگانی شد',
  'inventory.category_restored_toast': '{name} بازگردانده شد',
  'inventory.category_archive_title': '{name} بایگانی شود؟',
  'inventory.category_archive_body':
    'از فهرست انتخاب و از فیلترها کنار می‌رود. اقلامی که پیش‌تر در این دسته ثبت شده‌اند همچنان همین دسته را نشان می‌دهند و هر زمان می‌توانید آن را بازگردانید.',

  'inventory.custody': 'تحویل',
  'inventory.custody_holder': 'در اختیارِ',
  'inventory.custody_nobody': 'کسی آن را در اختیار ندارد — در انبار است',
  'inventory.custody_since': 'از {date} در اختیار اوست',
  'inventory.custody_assign': 'تحویل دادن',
  'inventory.custody_transfer': 'تحویل به فرد دیگر',
  'inventory.custody_return': 'پس گرفتن',
  'inventory.custody_assign_title': 'تحویل {name}',
  'inventory.custody_transfer_title': 'تحویل {name} به فرد دیگر',
  'inventory.custody_return_title': '{name} پس گرفته شود؟',
  'inventory.custody_return_body': 'به انبار برمی‌گردد و {person} دیگر پاسخ‌گوی آن نیست.',
  'inventory.custody_person': 'تحویل‌گیرنده',
  'inventory.custody_person_none': 'یک نفر را انتخاب کنید',
  'inventory.custody_note': 'یادداشت',
  'inventory.custody_note_hint': 'اختیاری — کجا می‌رود یا برای چه کاری است.',
  'inventory.custody_assigned_toast': '{name} به {person} تحویل داده شد',
  'inventory.custody_transferred_toast': '{name} به {person} واگذار شد',
  'inventory.custody_returned_toast': '{name} پس گرفته شد',
  'inventory.custody_previous': 'تحویل‌گیرندگان پیشین',
  'inventory.custody_empty': 'هنوز کسی این قلم را تحویل نگرفته است',
  'inventory.custody_empty_desc': 'به کسی تحویل بدهید تا اینجا ثبت شود.',
  'inventory.custody_error': 'سابقهٔ تحویل بارگذاری نشد',
  'inventory.custody_archived_hint': 'پیش از تحویل، این قلم را از بایگانی بازگردانید.',
  'inventory.member_former': 'عضو سابق',
  'inventory.member_system': 'سامانه',
  'inventory.member_loading': '…',
  'inventory.member_unknown': 'کسی',

  'inventory.history': 'تاریخچه',
  'inventory.history_empty': 'هنوز اتفاقی برای این قلم نیفتاده است',
  'inventory.history_error': 'تاریخچه بارگذاری نشد',
  'inventory.history_created': '{actor} آن را افزود',
  'inventory.history_updated': '{actor} آن را ویرایش کرد',
  'inventory.history_assigned': '{actor} آن را به {person} تحویل داد',
  'inventory.history_transferred': '{actor} آن را به {person} واگذار کرد',
  'inventory.history_returned': '{actor} آن را از {person} پس گرفت',
  'inventory.history_retired': '{actor} آن را بایگانی کرد',
  'inventory.history_restored': '{actor} آن را بازگرداند',
  'inventory.history_unknown': '{actor} آن را تغییر داد — {action}',
  'inventory.history_set': '{field} روی {to} تنظیم شد',
  'inventory.history_cleared': '{field} پاک شد',
  'inventory.history_changed': '{field} از {from} به {to} تغییر کرد',
  'inventory.history_replaced': '{field} جایگزین شد',
  'inventory.history_text_changed': '{field} تغییر کرد',
  'inventory.history_show_text': 'نمایش متن',
  'inventory.history_text_before': 'پیش از این',
  'inventory.history_text_after': 'پس از این',
  'inventory.history_note': 'یادداشت: {note}',
  'inventory.history_repair_logged': '{actor} آن را برای تعمیر فرستاد',
  'inventory.history_repair_completed': '{actor} بازگشت آن از تعمیر را ثبت کرد',
  'inventory.history_attachment_added': '{actor} فایلی پیوست کرد',
  'inventory.history_attachment_removed': '{actor} فایلی را حذف کرد',

  'inventory.details': 'مشخصات',
  'inventory.open': 'باز کردن',
  'inventory.open_asset': 'باز کردن {name}',
  'inventory.asset_error': 'این قلم بارگذاری نشد',
  'inventory.added_on': 'افزوده‌شده',
  'inventory.updated_on': 'آخرین تغییر',
  'inventory.photo': 'عکس',

  'inventory.repairs': 'تعمیرها',
  'inventory.repairs_error': 'تعمیرها بارگذاری نشد',
  'inventory.repairs_empty': 'هنوز تعمیری ثبت نشده است',
  'inventory.repairs_empty_desc': 'وقتی چیزی برای تعمیر بیرون می‌رود، همین‌جا ثبتش کنید تا معلوم باشد کجاست.',
  'inventory.repair_new': 'ارسال برای تعمیر',
  'inventory.repair_edit': 'ویرایش تعمیر',
  'inventory.repair_summary': 'ایراد چیست',
  'inventory.repair_summary_placeholder': 'شکستگی صفحه، تعویض باتری…',
  'inventory.repair_detail': 'توضیحات',
  'inventory.repair_vendor': 'تعمیرکار',
  'inventory.repair_vendor_placeholder': 'چه کسی آن را تعمیر می‌کند',
  'inventory.repair_cost': 'هزینه',
  'inventory.repair_sent_on': 'تاریخ ارسال',
  'inventory.repair_returned_on': 'تاریخ بازگشت',
  'inventory.repair_current': 'در تعمیر است',
  'inventory.repair_past': 'تعمیرهای پیشین',
  'inventory.repair_away_since': 'از {date} بیرون است',
  'inventory.repair_complete': 'ثبت بازگشت',
  'inventory.repair_complete_title': 'بازگشت {name} ثبت شود؟',
  'inventory.repair_complete_body':
    'به همان کسی برمی‌گردد که آن را در اختیار دارد و اگر کسی آن را ندارد، به انبار می‌رود. اگر فاکتور رسیده است، هزینه را هم وارد کنید.',
  'inventory.repair_logged_toast': '{name} برای تعمیر فرستاده شد',
  'inventory.repair_saved_toast': 'تعمیر ذخیره شد',
  'inventory.repair_completed_toast': 'بازگشت {name} ثبت شد',
  'inventory.repair_archived_hint': 'پیش از فرستادن برای تعمیر، این قلم را از بایگانی بازگردانید.',
  'inventory.widget_repairs_title': 'در تعمیر',
  'inventory.widget_repairs_desc': 'هر چیزی که همین حالا برای تعمیر بیرون است.',
  'inventory.widget_repairs_empty': 'چیزی در تعمیر نیست',

  'inventory.files': 'فایل‌ها',
  'inventory.files_error': 'فایل‌ها بارگذاری نشد',
  'inventory.files_empty': 'هنوز فایلی نیست',
  'inventory.files_empty_desc':
    'فاکتور، برگهٔ گارانتی و دفترچهٔ راهنما را کنار همان چیزی نگه دارید که به آن مربوط‌اند.',
  'inventory.file_add': 'افزودن فایل',
  'inventory.file_download': 'دانلود {name}',
  'inventory.file_remove': 'حذف {name}',
  'inventory.file_remove_title': '{name} حذف شود؟',
  'inventory.file_remove_body':
    'دیگر ذیل این قلم فهرست نمی‌شود. خود فایل حذف نمی‌شود و هر جای دیگری که پیوست شده باشد، آن را نگه می‌دارد.',
  'inventory.file_removed_toast': '{name} حذف شد',
  'inventory.file_added_toast': { one: '{n} فایل افزوده شد', other: '{n} فایل افزوده شد' },
  'inventory.file_upload_failed': '{name} بارگذاری نشد',
  'inventory.file_unnamed': 'فایل بارگذاری‌شده',

  'inventory.photo_none': 'هنوز عکسی نیست',
  'inventory.photo_set': 'انتخاب عکس',
  'inventory.photo_replace': 'تعویض عکس',
  'inventory.photo_remove': 'حذف عکس',
  'inventory.photo_saved_toast': 'عکس ذخیره شد',
  'inventory.photo_removed_toast': 'عکس حذف شد',
  'inventory.photo_alt': 'عکس {name}',

  'inventory.stats_total': 'اقلام',
  'inventory.stats_unassigned': 'بدون تحویل‌گیرنده',
  'inventory.stats_out_for_repair': 'در تعمیر',

  // «بارگذاری مجدد» is what the shell calls Reload (`pwa_update_reload`), so these use its verb.
  'inventory.error_custody_conflict':
    'کسی درست پیش از شما تغییر داد که این قلم در اختیار چه کسی است. صفحه را دوباره بارگذاری کنید تا ببینید اکنون کجاست.',
  'inventory.error_custody_archived': 'این قلم بایگانی شده است. پیش از تحویل، آن را بازگردانید.',
  'inventory.error_custody_already_held':
    'این قلم هم‌اکنون در اختیار کسی است. آن را واگذار کنید، یا نخست پس بگیرید.',
  'inventory.error_custody_not_held':
    'این قلم در اختیار کسی نیست، پس چیزی برای واگذاری وجود ندارد. به‌جای آن، تحویلش بدهید.',
  'inventory.error_asset_still_held': 'این قلم هنوز در اختیار کسی است. پیش از بایگانی، آن را پس بگیرید.',
  'inventory.error_asset_under_repair':
    'این قلم برای تعمیر بیرون است. پیش از بایگانی، بازگشت آن را ثبت کنید.',
  'inventory.error_repair_already_open':
    'این قلم هم‌اکنون برای تعمیر بیرون است. نخست بازگشت همان تعمیر را ثبت کنید.',
  'inventory.error_repair_archived': 'این قلم بایگانی شده است. پیش از فرستادن برای تعمیر، آن را بازگردانید.',
  'inventory.error_repair_already_complete': 'بازگشت این تعمیر پیش‌تر ثبت شده است.',
  'inventory.error_repair_returned_before_sent':
    'تعمیر نمی‌تواند پیش از فرستاده‌شدن بازگردد. دو تاریخ را بررسی کنید.',
  'inventory.error_category_name_taken': 'این فضای کاری از پیش دسته‌بندی‌ای با این نام دارد.',
  'inventory.error_not_found':
    'آن دیگر آنجا نیست. شاید کسی حذف یا بایگانی‌اش کرده باشد — صفحه را دوباره بارگذاری کنید.',
  'inventory.error_forbidden': 'اجازهٔ این کار را ندارید.',
  'inventory.error_module_disabled': 'ماژول اموال در این فضای کاری خاموش است.',
  'inventory.error_conflict':
    'کسی درست پیش از شما این را تغییر داد. صفحه را دوباره بارگذاری کنید و باز تلاش کنید.',
  'inventory.error_bad_request': 'چیزی در این فرم پذیرفته نشد. آنچه وارد کرده‌اید را بررسی کنید.',
  'inventory.error_refused': 'این درخواست پذیرفته نشد.',
  'inventory.error_unauthorized': 'نشست شما پایان یافته است. دوباره وارد شوید.',
  'inventory.error_rate_limited': 'درخواست‌ها بیش از اندازه است. کمی صبر کنید و باز تلاش کنید.',
  'inventory.error_unavailable': 'سرور همین حالا پاسخ نمی‌دهد. کمی بعد باز تلاش کنید.',
  'inventory.error_unknown': 'این کار انجام نشد.',
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
  // A brand and model stay in Latin script: it is what is printed on the lid, and «ماك بوك برو ١٤»
  // is not a string anybody would type into this field or read off a sticker.
  'inventory.name_placeholder': 'MacBook Pro 14"، كرسي مكتبي…',
  'inventory.description': 'الوصف',
  'inventory.status': 'الحالة',
  'inventory.serial_number': 'الرقم التسلسلي',
  'inventory.location': 'الموقع',
  'inventory.purchased_on': 'تاريخ الشراء',
  'inventory.purchased_from': 'تم الشراء من',
  'inventory.price': 'السعر',
  'inventory.warranty_until': 'الضمان حتى',
  'inventory.status_in_stock': 'في المخزن',
  'inventory.status_assigned': 'مُسلَّم',
  'inventory.status_reserved': 'محجوز',
  'inventory.status_under_repair': 'قيد الإصلاح',
  'inventory.status_lost': 'مفقود',
  'inventory.status_retired': 'مستبعد',
  'inventory.currency': 'العملة',
  'inventory.price_invalid': 'أدخل مبلغًا مثل {example}',
  'inventory.count': {
    zero: 'لا أصول',
    one: 'أصل واحد',
    two: 'أصلان',
    few: '{n} أصول',
    many: '{n} أصلاً',
    other: '{n} أصل',
  },
  'inventory.count_showing': {
    zero: 'لا أصول معروضة',
    one: 'يُعرض أصل واحد',
    two: 'يُعرض أصلان',
    few: 'تُعرض {n} أصول',
    many: 'يُعرض {n} أصلاً',
    other: 'يُعرض {n} أصل',
  },
  'inventory.search_placeholder': 'ابحث بالاسم أو الرمز أو الرقم التسلسلي…',
  'inventory.filter_all_statuses': 'جميع الحالات',
  'inventory.archived': 'مؤرشف',
  'inventory.restore': 'استعادة',
  'inventory.show_archived': 'إظهار المؤرشفة',
  'inventory.load_more': 'تحميل المزيد',
  'inventory.row_actions': 'إجراءات {name}',
  'inventory.archive_title': 'أرشفة {name}؟',
  'inventory.archive_body': 'يختفي من القائمة ويحتفظ برمزه. لا يُحذف شيء، ويمكنك استعادته في أي وقت.',
  'inventory.archived_toast': 'تمت أرشفة {name}',
  'inventory.restored_toast': 'تمت استعادة {name}',
  'inventory.created_toast': 'تمت إضافة {name}',
  'inventory.updated_toast': 'تم تحديث {name}',
  'inventory.load_error': 'تعذّر تحميل الأصول',
  'inventory.no_matches': 'لا نتائج',
  'inventory.no_matches_desc': 'لا يطابق أي أصل هذا البحث أو هذه المرشِّحات.',
  'inventory.clear_filters': 'مسح المرشِّحات',
  'inventory.settings_general': 'عام',
  'inventory.settings_general_desc': 'كيف ترقّم مساحة العمل هذه ما تملكه.',
  'inventory.settings_numbering': 'رموز الأصول',
  'inventory.settings_numbering_desc': 'شكل كل رمز يصدر من الآن. الرموز الموجودة على الملصقات تبقى كما هي.',
  'inventory.settings_prefix': 'البادئة',
  'inventory.settings_prefix_hint': 'ثمانية أحرف على الأكثر، أو اتركها فارغة للأرقام وحدها.',
  'inventory.settings_prefix_too_long': 'استخدم ثمانية أحرف أو أقل',
  'inventory.settings_pad': 'عدد الخانات',
  'inventory.settings_pad_hint': 'إلى كم خانة يُستكمل الرقم بالأصفار.',
  'inventory.settings_pad_invalid': 'أدخل عددًا صحيحًا من ١ إلى ١٠',
  'inventory.settings_preview': 'مثال على الرمز',
  'inventory.settings_saved': 'حُفظت الإعدادات',
  'inventory.settings_error': 'تعذّر تحميل الإعدادات',
  'inventory.settings_readonly': 'يمكنك قراءة هذه الإعدادات دون تغييرها.',
  'inventory.settings_not_enabled': 'وحدة الأصول غير مفعّلة في مساحة العمل هذه',

  'inventory.settings_notices': 'التنبيهات',
  'inventory.settings_notices_desc':
    'متى تُبلَّغ مساحة العمل بأن ضمان أحد الأصول يوشك على الانتهاء، أو بأن أصلًا بقي لدى ورشة التصليح أطول من اللازم.',
  'inventory.settings_warranty_days': 'التنبيه قبل انتهاء الضمان بهذا العدد من الأيام',
  'inventory.settings_warranty_days_hint':
    'كم يومًا قبل انتهاء الضمان يُبلَّغ أحد. مرة واحدة لكل أصل، إلى من يحمله.',
  'inventory.settings_repair_days': 'متابعة التصليح بعد هذا العدد من الأيام',
  'inventory.settings_repair_days_hint': 'كم يومًا يبقى الأصل لدى الورشة قبل أن يُطلب ممّن سجّل التصليح متابعته.',
  'inventory.settings_days_invalid': 'أدخل عدد أيام صحيحًا بين ١ و٣٦٥',
  'inventory.held_by': 'بحوزة {name}',
  'inventory.held_by_clear': 'عرض كل الأصول',
  'inventory.widget_title': 'أصول حديثة',
  'inventory.widget_desc': 'الأصول المضافة أخيرًا إلى مساحة العمل هذه.',

  'inventory.category': 'الفئة',
  'inventory.category_none': 'بلا فئة',
  'inventory.filter_all_categories': 'جميع الفئات',
  'inventory.categories_error': 'تعذّر تحميل الفئات',
  'inventory.settings_categories': 'الفئات',
  'inventory.settings_categories_desc': 'كيف تجمّع مساحة العمل هذه ما تملكه.',
  'inventory.categories_empty': 'لا فئات بعد',
  'inventory.categories_empty_desc':
    'اجمع ما تملكه الشركة — حواسيب، أثاث، كاميرات — لتضييق قائمة طويلة إلى نوع واحد.',
  'inventory.categories_all_archived': 'كل الفئات مؤرشفة',
  'inventory.categories_all_archived_desc': 'أظهر المؤرشفة لتستعيد إحداها، أو أضف فئة جديدة.',
  'inventory.category_new': 'فئة جديدة',
  'inventory.category_edit': 'تعديل الفئة',
  'inventory.category_name_placeholder': 'حواسيب، أثاث، كاميرات…',
  'inventory.category_order': 'الترتيب',
  'inventory.category_order_hint': 'الأصغر يأتي أولًا. الفئات المتساوية تُرتَّب بأسمائها.',
  'inventory.category_order_invalid': 'أدخل عددًا صحيحًا من ٠ إلى ٩٩٩٩',
  'inventory.category_created_toast': 'تمت إضافة {name}',
  'inventory.category_updated_toast': 'تم حفظ {name}',
  'inventory.category_archived_toast': 'تمت أرشفة {name}',
  'inventory.category_restored_toast': 'تمت استعادة {name}',
  'inventory.category_archive_title': 'أرشفة {name}؟',
  'inventory.category_archive_body':
    'تختفي من قائمة الاختيار ومن المرشِّحات. الأصول المصنَّفة فيها تحتفظ بها وتظل تقول ما هي، ويمكنك استعادتها في أي وقت.',

  'inventory.custody': 'العهدة',
  'inventory.custody_holder': 'في عهدة',
  'inventory.custody_nobody': 'لا أحد — الأصل في المخزن',
  'inventory.custody_since': 'في العهدة منذ {date}',
  'inventory.custody_assign': 'تسليم',
  'inventory.custody_transfer': 'تسليم إلى شخص آخر',
  'inventory.custody_return': 'استرجاع',
  'inventory.custody_assign_title': 'تسليم {name}',
  'inventory.custody_transfer_title': 'تسليم {name} إلى شخص آخر',
  'inventory.custody_return_title': 'استرجاع {name}؟',
  'inventory.custody_return_body': 'يعود إلى المخزن، ولا يعود {person} مسؤولًا عنه.',
  'inventory.custody_person': 'المستلِم',
  'inventory.custody_person_none': 'اختر شخصًا',
  'inventory.custody_note': 'ملاحظة',
  'inventory.custody_note_hint': 'اختياري — إلى أين يذهب أو لأي غرض.',
  'inventory.custody_assigned_toast': 'سُلِّم {name} إلى {person}',
  'inventory.custody_transferred_toast': 'انتقل {name} إلى {person}',
  'inventory.custody_returned_toast': 'تم استرجاع {name}',
  'inventory.custody_previous': 'من كان في عهدته',
  'inventory.custody_empty': 'لم يستلمه أحد بعد',
  'inventory.custody_empty_desc': 'سلِّمه إلى شخص وسيُسجَّل التسليم هنا.',
  'inventory.custody_error': 'تعذّر تحميل سجل العهدة',
  'inventory.custody_archived_hint': 'استعد هذا الأصل من الأرشيف قبل تسليمه.',
  'inventory.member_former': 'عضو سابق',
  'inventory.member_system': 'النظام',
  'inventory.member_loading': '…',
  'inventory.member_unknown': 'شخص ما',

  'inventory.history': 'السجل',
  'inventory.history_empty': 'لم يحدث شيء لهذا الأصل بعد',
  'inventory.history_error': 'تعذّر تحميل السجل',
  'inventory.history_created': 'أضافه {actor}',
  'inventory.history_updated': 'عدّله {actor}',
  'inventory.history_assigned': 'سلّمه {actor} إلى {person}',
  'inventory.history_transferred': 'نقله {actor} إلى {person}',
  'inventory.history_returned': 'استرجعه {actor} من {person}',
  'inventory.history_retired': 'أرشفه {actor}',
  'inventory.history_restored': 'استعاده {actor}',
  'inventory.history_unknown': 'غيّره {actor} — {action}',
  'inventory.history_set': 'ضُبط {field} على {to}',
  'inventory.history_cleared': 'مُسح {field}',
  'inventory.history_changed': 'تغيّر {field} من {from} إلى {to}',
  'inventory.history_replaced': 'استُبدل {field}',
  'inventory.history_text_changed': 'تغيّر {field}',
  'inventory.history_show_text': 'عرض النص',
  'inventory.history_text_before': 'قبل',
  'inventory.history_text_after': 'بعد',
  'inventory.history_note': 'ملاحظة: {note}',
  'inventory.history_repair_logged': 'أرسله {actor} للإصلاح',
  'inventory.history_repair_completed': 'سجّل {actor} عودته من الإصلاح',
  'inventory.history_attachment_added': 'أرفق {actor} ملفًا',
  'inventory.history_attachment_removed': 'أزال {actor} ملفًا',

  'inventory.details': 'التفاصيل',
  'inventory.open': 'فتح',
  'inventory.open_asset': 'فتح {name}',
  'inventory.asset_error': 'تعذّر تحميل هذا الأصل',
  'inventory.added_on': 'أُضيف',
  'inventory.updated_on': 'آخر تغيير',
  'inventory.photo': 'الصورة',

  'inventory.repairs': 'الإصلاحات',
  'inventory.repairs_error': 'تعذّر تحميل الإصلاحات',
  'inventory.repairs_empty': 'لم يُسجَّل أي إصلاح بعد',
  'inventory.repairs_empty_desc': 'حين يخرج شيء للإصلاح، سجّله هنا ليعرف السجل أين هو.',
  'inventory.repair_new': 'إرسال للإصلاح',
  'inventory.repair_edit': 'تعديل الإصلاح',
  'inventory.repair_summary': 'ما العطل',
  'inventory.repair_summary_placeholder': 'شاشة مكسورة، بطارية جديدة…',
  'inventory.repair_detail': 'التفاصيل',
  'inventory.repair_vendor': 'ورشة الإصلاح',
  'inventory.repair_vendor_placeholder': 'من يقوم بالإصلاح',
  'inventory.repair_cost': 'التكلفة',
  'inventory.repair_sent_on': 'تاريخ الإرسال',
  'inventory.repair_returned_on': 'تاريخ العودة',
  'inventory.repair_current': 'خارج للإصلاح',
  'inventory.repair_past': 'إصلاحات سابقة',
  'inventory.repair_away_since': 'خارج منذ {date}',
  'inventory.repair_complete': 'تسجيل عودته',
  'inventory.repair_complete_title': 'تسجيل عودة {name}؟',
  'inventory.repair_complete_body':
    'يعود إلى من هو في عهدته، أو إلى المخزن إن لم يكن في عهدة أحد. أضف التكلفة إن وصلت الفاتورة.',
  'inventory.repair_logged_toast': 'أُرسل {name} للإصلاح',
  'inventory.repair_saved_toast': 'حُفظ الإصلاح',
  'inventory.repair_completed_toast': 'سُجّلت عودة {name}',
  'inventory.repair_archived_hint': 'استعد هذا الأصل من الأرشيف قبل إرساله للإصلاح.',
  'inventory.widget_repairs_title': 'خارج للإصلاح',
  'inventory.widget_repairs_desc': 'كل ما هو خارج للإصلاح الآن.',
  'inventory.widget_repairs_empty': 'لا شيء خارج للإصلاح',

  'inventory.files': 'الملفات',
  'inventory.files_error': 'تعذّر تحميل الملفات',
  'inventory.files_empty': 'لا ملفات بعد',
  'inventory.files_empty_desc': 'احتفظ بالفاتورة وبطاقة الضمان والدليل مع الشيء الذي تخصّه.',
  'inventory.file_add': 'إضافة ملف',
  'inventory.file_download': 'تنزيل {name}',
  'inventory.file_remove': 'إزالة {name}',
  'inventory.file_remove_title': 'إزالة {name}؟',
  'inventory.file_remove_body':
    'لن يعود مدرجًا مع هذا الأصل. الملف نفسه لا يُحذف، ويبقى مرفقًا في أي مكان آخر أُرفق به.',
  'inventory.file_removed_toast': 'أُزيل {name}',
  'inventory.file_added_toast': {
    zero: 'لم يُضف أي ملف',
    one: 'أُضيف ملف واحد',
    two: 'أُضيف ملفان',
    few: 'أُضيفت {n} ملفات',
    many: 'أُضيف {n} ملفًا',
    other: 'أُضيف {n} ملف',
  },
  'inventory.file_upload_failed': 'تعذّر رفع {name}',
  'inventory.file_unnamed': 'ملف مرفوع',

  'inventory.photo_none': 'لا صورة بعد',
  'inventory.photo_set': 'اختيار صورة',
  'inventory.photo_replace': 'استبدال الصورة',
  'inventory.photo_remove': 'إزالة الصورة',
  'inventory.photo_saved_toast': 'حُفظت الصورة',
  'inventory.photo_removed_toast': 'أُزيلت الصورة',
  'inventory.photo_alt': 'صورة {name}',

  'inventory.stats_total': 'الأصول',
  'inventory.stats_unassigned': 'ليست في عهدة أحد',
  'inventory.stats_out_for_repair': 'خارج للإصلاح',

  // «إعادة التحميل» is what the shell calls Reload (`pwa_update_reload`), so these use its verb.
  'inventory.error_custody_conflict':
    'غيّر أحدهم من يحمل هذا الأصل قبلك بلحظة. أعد تحميل الصفحة لترى أين هو الآن.',
  'inventory.error_custody_archived': 'هذا الأصل مؤرشف. استعده قبل تسليمه.',
  'inventory.error_custody_already_held': 'الأصل في عهدة شخص بالفعل. انقله إلى غيره، أو استرجعه أولًا.',
  'inventory.error_custody_not_held': 'لا أحد يحمل هذا الأصل، فلا شيء لنقله. سلّمه بدلًا من ذلك.',
  'inventory.error_asset_still_held': 'لا يزال الأصل في عهدة أحدهم. استرجعه قبل أرشفته.',
  'inventory.error_asset_under_repair': 'الأصل خارج للإصلاح. سجّل عودته قبل أرشفته.',
  'inventory.error_repair_already_open': 'الأصل خارج للإصلاح بالفعل. سجّل عودة ذلك الإصلاح أولًا.',
  'inventory.error_repair_archived': 'هذا الأصل مؤرشف. استعده قبل إرساله للإصلاح.',
  'inventory.error_repair_already_complete': 'سُجّل هذا الإصلاح منتهيًا بالفعل.',
  'inventory.error_repair_returned_before_sent': 'لا يمكن أن يعود الإصلاح قبل إرساله. راجع التاريخين.',
  'inventory.error_category_name_taken': 'في مساحة العمل هذه فئة بهذا الاسم بالفعل.',
  'inventory.error_not_found': 'لم يعد ذلك موجودًا. ربما أزاله أحدهم أو أرشفه — أعد تحميل الصفحة لترى.',
  'inventory.error_forbidden': 'لا تملك صلاحية القيام بذلك.',
  'inventory.error_module_disabled': 'وحدة الأصول مُطفأة في مساحة العمل هذه.',
  'inventory.error_conflict': 'غيّر أحدهم هذا قبلك بلحظة. أعد تحميل الصفحة وحاول مرة أخرى.',
  'inventory.error_bad_request': 'لم يُقبل شيء مما في النموذج. راجع ما أدخلته.',
  'inventory.error_refused': 'لم يُقبل هذا الطلب.',
  'inventory.error_unauthorized': 'انتهت جلستك. سجّل الدخول من جديد.',
  'inventory.error_rate_limited': 'طلبات كثيرة في وقت قصير. انتظر قليلًا ثم أعد المحاولة.',
  'inventory.error_unavailable': 'الخادم لا يستجيب الآن. أعد المحاولة بعد قليل.',
  'inventory.error_unknown': 'لم ينجح ذلك.',
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
  'inventory.status': 'Status',
  'inventory.serial_number': 'Seriennummer',
  'inventory.location': 'Standort',
  'inventory.purchased_on': 'Kaufdatum',
  'inventory.purchased_from': 'Gekauft bei',
  'inventory.price': 'Preis',
  'inventory.warranty_until': 'Garantie bis',
  'inventory.status_in_stock': 'Auf Lager',
  'inventory.status_assigned': 'Zugewiesen',
  'inventory.status_reserved': 'Reserviert',
  'inventory.status_under_repair': 'In Reparatur',
  'inventory.status_lost': 'Verloren',
  'inventory.status_retired': 'Ausgemustert',
  'inventory.currency': 'Währung',
  'inventory.price_invalid': 'Betrag wie {example} eingeben',
  'inventory.count': { one: '{n} Gegenstand', other: '{n} Gegenstände' },
  'inventory.count_showing': { one: '{n} Gegenstand angezeigt', other: '{n} Gegenstände angezeigt' },
  'inventory.search_placeholder': 'Nach Name, Nummer oder Seriennummer suchen…',
  // "Status", not "Zustände": the shell renders this noun as *Status* in all eight places it has
  // one, and reserves *Zustand* for a module's health (`admin_modules_col_health`).
  'inventory.filter_all_statuses': 'Alle Status',
  'inventory.archived': 'Archiviert',
  'inventory.restore': 'Wiederherstellen',
  'inventory.show_archived': 'Archivierte anzeigen',
  'inventory.load_more': 'Mehr laden',
  'inventory.row_actions': 'Aktionen für {name}',
  'inventory.archive_title': '{name} archivieren?',
  'inventory.archive_body':
    'Der Gegenstand verschwindet aus der Liste und behält seine Nummer. Es wird nichts gelöscht, und Sie können ihn jederzeit wiederherstellen.',
  'inventory.archived_toast': '{name} archiviert',
  'inventory.restored_toast': '{name} wiederhergestellt',
  'inventory.created_toast': '{name} hinzugefügt',
  'inventory.updated_toast': '{name} aktualisiert',
  'inventory.load_error': 'Die Gegenstände konnten nicht geladen werden',
  'inventory.no_matches': 'Keine Treffer',
  'inventory.no_matches_desc': 'Kein Gegenstand passt zu dieser Suche oder diesen Filtern.',
  'inventory.clear_filters': 'Filter zurücksetzen',
  'inventory.settings_general': 'Allgemein',
  // "Workspace", not "Arbeitsbereich", in all five places this bundle names one: German keeps the
  // English word, which is a settled row in `repos/shell/messages/GLOSSARY.md` and what the shell's
  // own catalogue does 62 times against 23. One noun, one word, across the screens people read
  // side by side.
  'inventory.settings_general_desc': 'Wie dieser Workspace seinen Besitz nummeriert.',
  'inventory.settings_numbering': 'Inventarnummern',
  'inventory.settings_numbering_desc':
    'Die Form jeder ab jetzt vergebenen Nummer. Bereits aufgeklebte Nummern bleiben, wie sie sind.',
  'inventory.settings_prefix': 'Präfix',
  'inventory.settings_prefix_hint': 'Höchstens 8 Zeichen, oder leer für reine Ziffern.',
  'inventory.settings_prefix_too_long': 'Höchstens 8 Zeichen verwenden',
  'inventory.settings_pad': 'Stellen',
  'inventory.settings_pad_hint': 'Auf wie viele Stellen die Zahl mit Nullen aufgefüllt wird.',
  'inventory.settings_pad_invalid': 'Ganze Zahl von 1 bis 10 eingeben',
  'inventory.settings_preview': 'Beispielnummer',
  'inventory.settings_saved': 'Einstellungen gespeichert',
  'inventory.settings_error': 'Die Einstellungen konnten nicht geladen werden',
  'inventory.settings_readonly': 'Sie können diese Einstellungen lesen, aber nicht ändern.',
  'inventory.settings_not_enabled': 'Inventar ist in diesem Workspace nicht aktiviert',

  'inventory.settings_notices': 'Benachrichtigungen',
  'inventory.settings_notices_desc':
    'Wann dieser Workspace erfährt, dass eine Garantie ausläuft oder ein Gegenstand zu lange in der Werkstatt ist.',
  'inventory.settings_warranty_days': 'So viele Tage vorher warnen',
  'inventory.settings_warranty_days_hint':
    'Wie lange vor Ablauf der Garantie jemand informiert wird. Einmal pro Gegenstand, an die Person, die ihn hat.',
  'inventory.settings_repair_days': 'Nach so vielen Tagen nachfassen',
  'inventory.settings_repair_days_hint':
    'Wie lange ein Gegenstand in der Werkstatt sein darf, bevor die Person, die die Reparatur erfasst hat, nachfassen soll.',
  'inventory.settings_days_invalid': 'Geben Sie eine ganze Zahl zwischen 1 und 365 Tagen ein',
  'inventory.held_by': 'Bei {name}',
  'inventory.held_by_clear': 'Alle Gegenstände anzeigen',
  'inventory.widget_title': 'Neue Gegenstände',
  'inventory.widget_desc': 'Die zuletzt hinzugefügten Gegenstände dieses Workspace.',

  'inventory.category': 'Kategorie',
  'inventory.category_none': 'Ohne Kategorie',
  'inventory.filter_all_categories': 'Alle Kategorien',
  'inventory.categories_error': 'Die Kategorien konnten nicht geladen werden',
  'inventory.settings_categories': 'Kategorien',
  'inventory.settings_categories_desc': 'Wie dieser Workspace seinen Besitz gruppiert.',
  'inventory.categories_empty': 'Noch keine Kategorien',
  'inventory.categories_empty_desc':
    'Gruppieren Sie, was die Firma besitzt — Laptops, Möbel, Kameras — damit eine lange Liste auf eine Art eingegrenzt werden kann.',
  'inventory.categories_all_archived': 'Alle Kategorien sind archiviert',
  'inventory.categories_all_archived_desc':
    'Zeigen Sie die archivierten an, um eine wiederherzustellen, oder legen Sie eine neue an.',
  'inventory.category_new': 'Neue Kategorie',
  'inventory.category_edit': 'Kategorie bearbeiten',
  'inventory.category_name_placeholder': 'Laptops, Möbel, Kameras…',
  'inventory.category_order': 'Position',
  'inventory.category_order_hint': 'Kleinere Zahlen stehen vorn. Bei gleicher Position entscheidet der Name.',
  'inventory.category_order_invalid': 'Ganze Zahl von 0 bis 9999 eingeben',
  'inventory.category_created_toast': '{name} hinzugefügt',
  'inventory.category_updated_toast': '{name} gespeichert',
  'inventory.category_archived_toast': '{name} archiviert',
  'inventory.category_restored_toast': '{name} wiederhergestellt',
  'inventory.category_archive_title': '{name} archivieren?',
  'inventory.category_archive_body':
    'Sie verschwindet aus der Auswahl und aus dem Filter. Bereits zugeordnete Gegenstände behalten sie und sagen weiterhin, was sie sind; Sie können sie jederzeit wiederherstellen.',

  // "Ausgabe/Rückgabe" is what a German asset register calls this, and the verbs below follow it.
  'inventory.custody': 'Ausgabe',
  'inventory.custody_holder': 'Ausgegeben an',
  'inventory.custody_nobody': 'Niemand — auf Lager',
  'inventory.custody_since': 'Ausgegeben seit {date}',
  'inventory.custody_assign': 'Ausgeben',
  'inventory.custody_transfer': 'Weitergeben',
  'inventory.custody_return': 'Zurücknehmen',
  'inventory.custody_assign_title': '{name} ausgeben',
  'inventory.custody_transfer_title': '{name} weitergeben',
  'inventory.custody_return_title': '{name} zurücknehmen?',
  'inventory.custody_return_body':
    'Der Gegenstand geht zurück auf Lager, und {person} ist nicht mehr dafür verantwortlich.',
  'inventory.custody_person': 'Wer ihn bekommt',
  'inventory.custody_person_none': 'Jemanden auswählen',
  'inventory.custody_note': 'Notiz',
  'inventory.custody_note_hint': 'Optional — wohin er geht oder wofür er ist.',
  'inventory.custody_assigned_toast': '{name} an {person} ausgegeben',
  'inventory.custody_transferred_toast': '{name} an {person} weitergegeben',
  'inventory.custody_returned_toast': '{name} zurückgenommen',
  // Not "Frühere Ausgaben" and "Die Ausgaben konnten nicht geladen werden". *Ausgabe* is the right
  // verb for handing an item out and the wrong noun to leave standing on its own beside a Preis
  // field, where it reads as *expenditure* — "Frühere Ausgaben" over a list of people, on a panel
  // showing what the thing cost, is the one place this bundle's own terminology misleads.
  'inventory.custody_previous': 'Frühere Inhaber',
  'inventory.custody_empty': 'Noch niemand hatte diesen Gegenstand',
  'inventory.custody_empty_desc': 'Geben Sie ihn aus, und die Ausgabe wird hier festgehalten.',
  'inventory.custody_error': 'Der Ausgabeverlauf konnte nicht geladen werden',
  'inventory.custody_archived_hint': 'Stellen Sie den Gegenstand wieder her, bevor Sie ihn ausgeben.',
  'inventory.member_former': 'Ein ehemaliges Mitglied',
  'inventory.member_system': 'Das System',
  'inventory.member_loading': '…',
  'inventory.member_unknown': 'Jemand',

  'inventory.history': 'Verlauf',
  'inventory.history_empty': 'Mit diesem Gegenstand ist noch nichts geschehen',
  'inventory.history_error': 'Der Verlauf konnte nicht geladen werden',
  'inventory.history_created': '{actor} hat ihn angelegt',
  'inventory.history_updated': '{actor} hat ihn bearbeitet',
  'inventory.history_assigned': '{actor} hat ihn an {person} ausgegeben',
  'inventory.history_transferred': '{actor} hat ihn an {person} weitergegeben',
  'inventory.history_returned': '{actor} hat ihn von {person} zurückgenommen',
  'inventory.history_retired': '{actor} hat ihn archiviert',
  'inventory.history_restored': '{actor} hat ihn wiederhergestellt',
  'inventory.history_unknown': '{actor} hat ihn geändert — {action}',
  'inventory.history_set': '{field} auf {to} gesetzt',
  'inventory.history_cleared': '{field} geleert',
  'inventory.history_changed': '{field} von {from} auf {to} geändert',
  'inventory.history_replaced': '{field} ersetzt',
  'inventory.history_text_changed': '{field} geändert',
  'inventory.history_show_text': 'Text anzeigen',
  'inventory.history_text_before': 'Vorher',
  'inventory.history_text_after': 'Nachher',
  'inventory.history_note': 'Notiz: {note}',
  'inventory.history_repair_logged': '{actor} hat ihn zur Reparatur gegeben',
  // "als zurück erfasst" is English word order wearing German words — *zurück* is an adverb and
  // cannot be what something is erfasst *as*. The noun is what German uses: die Rückkehr erfassen.
  'inventory.history_repair_completed': '{actor} hat seine Rückkehr erfasst',
  'inventory.history_attachment_added': '{actor} hat eine Datei angehängt',
  'inventory.history_attachment_removed': '{actor} hat eine Datei entfernt',

  'inventory.details': 'Details',
  'inventory.open': 'Öffnen',
  'inventory.open_asset': '{name} öffnen',
  'inventory.asset_error': 'Dieser Gegenstand konnte nicht geladen werden',
  'inventory.added_on': 'Angelegt',
  'inventory.updated_on': 'Zuletzt geändert',
  'inventory.photo': 'Foto',

  'inventory.repairs': 'Reparaturen',
  'inventory.repairs_error': 'Die Reparaturen konnten nicht geladen werden',
  'inventory.repairs_empty': 'Noch keine Reparatur erfasst',
  'inventory.repairs_empty_desc':
    'Geht etwas zur Reparatur, halten Sie es hier fest — dann weiß das Inventar, wo es ist.',
  'inventory.repair_new': 'Zur Reparatur geben',
  'inventory.repair_edit': 'Reparatur bearbeiten',
  'inventory.repair_summary': 'Was ist defekt',
  'inventory.repair_summary_placeholder': 'Displaybruch, neuer Akku…',
  'inventory.repair_detail': 'Details',
  'inventory.repair_vendor': 'Werkstatt',
  'inventory.repair_vendor_placeholder': 'Wer repariert ihn',
  'inventory.repair_cost': 'Kosten',
  'inventory.repair_sent_on': 'Abgegeben',
  'inventory.repair_returned_on': 'Zurück',
  'inventory.repair_current': 'In Reparatur',
  'inventory.repair_past': 'Frühere Reparaturen',
  'inventory.repair_away_since': 'Seit {date} in Reparatur',
  'inventory.repair_complete': 'Rückkehr erfassen',
  'inventory.repair_complete_title': 'Rückkehr von {name} erfassen?',
  'inventory.repair_complete_body':
    'Der Gegenstand geht an die Person zurück, die ihn hat — oder ins Lager, wenn ihn niemand hat. Tragen Sie die Kosten ein, sobald die Rechnung da ist.',
  'inventory.repair_logged_toast': '{name} zur Reparatur gegeben',
  'inventory.repair_saved_toast': 'Reparatur gespeichert',
  'inventory.repair_completed_toast': 'Rückkehr von {name} erfasst',
  'inventory.repair_archived_hint':
    'Stellen Sie diesen Gegenstand wieder her, bevor Sie ihn zur Reparatur geben.',
  'inventory.widget_repairs_title': 'In Reparatur',
  'inventory.widget_repairs_desc': 'Alles, was gerade zur Reparatur unterwegs ist.',
  'inventory.widget_repairs_empty': 'Nichts ist in Reparatur',

  'inventory.files': 'Dateien',
  'inventory.files_error': 'Die Dateien konnten nicht geladen werden',
  'inventory.files_empty': 'Noch keine Dateien',
  'inventory.files_empty_desc':
    'Rechnung, Garantiekarte und Handbuch gehören zu dem Gegenstand, für den sie gelten.',
  'inventory.file_add': 'Datei hinzufügen',
  'inventory.file_download': '{name} herunterladen',
  'inventory.file_remove': '{name} entfernen',
  'inventory.file_remove_title': '{name} entfernen?',
  'inventory.file_remove_body':
    'Sie ist dann nicht mehr bei diesem Gegenstand aufgeführt. Die Datei selbst wird nicht gelöscht und bleibt überall dort erhalten, wo sie sonst noch angehängt ist.',
  'inventory.file_removed_toast': '{name} entfernt',
  'inventory.file_added_toast': { one: '{n} Datei hinzugefügt', other: '{n} Dateien hinzugefügt' },
  'inventory.file_upload_failed': '{name} konnte nicht hochgeladen werden',
  'inventory.file_unnamed': 'Hochgeladene Datei',

  'inventory.photo_none': 'Noch kein Foto',
  'inventory.photo_set': 'Foto auswählen',
  'inventory.photo_replace': 'Foto ersetzen',
  'inventory.photo_remove': 'Foto entfernen',
  'inventory.photo_saved_toast': 'Foto gespeichert',
  'inventory.photo_removed_toast': 'Foto entfernt',
  'inventory.photo_alt': 'Foto von {name}',

  'inventory.stats_total': 'Gegenstände',
  'inventory.stats_unassigned': 'Niemandem zugeordnet',
  'inventory.stats_out_for_repair': 'In Reparatur',

  // "Neu laden" is what the shell calls Reload (`pwa_update_reload`), so these use its verb.
  'inventory.error_custody_conflict':
    'Kurz vor Ihnen hat jemand geändert, wer den Gegenstand hat. Laden Sie die Seite neu, um zu sehen, wo er jetzt ist.',
  'inventory.error_custody_archived':
    'Dieser Gegenstand ist archiviert. Stellen Sie ihn wieder her, bevor Sie ihn ausgeben.',
  'inventory.error_custody_already_held':
    'Der Gegenstand ist bereits ausgegeben. Geben Sie ihn weiter, oder nehmen Sie ihn erst zurück.',
  'inventory.error_custody_not_held':
    'Den Gegenstand hat niemand, es gibt also nichts weiterzugeben. Geben Sie ihn stattdessen aus.',
  'inventory.error_asset_still_held':
    'Der Gegenstand ist noch ausgegeben. Nehmen Sie ihn zurück, bevor Sie ihn archivieren.',
  'inventory.error_asset_under_repair':
    'Der Gegenstand ist in Reparatur. Erfassen Sie seine Rückkehr, bevor Sie ihn archivieren.',
  'inventory.error_repair_already_open':
    'Der Gegenstand ist bereits in Reparatur. Erfassen Sie zuerst deren Rückkehr.',
  'inventory.error_repair_archived':
    'Dieser Gegenstand ist archiviert. Stellen Sie ihn wieder her, bevor Sie ihn zur Reparatur geben.',
  'inventory.error_repair_already_complete': 'Diese Reparatur ist bereits als abgeschlossen erfasst.',
  'inventory.error_repair_returned_before_sent':
    'Eine Reparatur kann nicht vor der Abgabe zurückkommen. Prüfen Sie die beiden Daten.',
  'inventory.error_category_name_taken':
    'In diesem Workspace gibt es bereits eine Kategorie mit diesem Namen.',
  'inventory.error_not_found':
    'Das ist nicht mehr da. Vielleicht hat es jemand entfernt oder archiviert — laden Sie die Seite neu.',
  'inventory.error_forbidden': 'Dazu sind Sie nicht berechtigt.',
  'inventory.error_module_disabled': 'Inventar ist in diesem Workspace abgeschaltet.',
  'inventory.error_conflict':
    'Kurz vor Ihnen hat jemand das geändert. Laden Sie die Seite neu und versuchen Sie es erneut.',
  'inventory.error_bad_request': 'Etwas im Formular wurde nicht akzeptiert. Prüfen Sie Ihre Eingaben.',
  'inventory.error_refused': 'Das wurde nicht akzeptiert.',
  'inventory.error_unauthorized': 'Ihre Sitzung ist abgelaufen. Melden Sie sich erneut an.',
  'inventory.error_rate_limited':
    'Gerade zu viele Anfragen. Warten Sie einen Moment und versuchen Sie es erneut.',
  'inventory.error_unavailable': 'Der Server antwortet gerade nicht. Versuchen Sie es gleich noch einmal.',
  'inventory.error_unknown': 'Das hat nicht funktioniert.',
}

export const tr: Record<string, Message> = {
  'inventory.nav': 'Envanter',
  'inventory.title': 'Demirbaşlar',
  'inventory.empty': 'Henüz demirbaş yok',
  // "— şirkete ait her şeyi" left an accusative object hanging off a sentence that already had
  // one. "ne varsa" is how Turkish finishes the thought.
  'inventory.empty_desc': 'İlk dizüstünü, telefonu ya da masayı ekleyin — şirkete ait ne varsa.',
  'inventory.new': 'Yeni demirbaş',
  'inventory.edit': 'Demirbaşı düzenle',
  'inventory.code': 'Demirbaş no',
  'inventory.name': 'Ad',
  'inventory.name_placeholder': 'MacBook Pro 14", ofis koltuğu…',
  'inventory.description': 'Açıklama',
  'inventory.status': 'Durum',
  'inventory.serial_number': 'Seri numarası',
  'inventory.location': 'Konum',
  'inventory.purchased_on': 'Alım tarihi',
  'inventory.purchased_from': 'Alındığı yer',
  'inventory.price': 'Fiyat',
  'inventory.warranty_until': 'Garanti bitişi',
  'inventory.status_in_stock': 'Depoda',
  'inventory.status_assigned': 'Zimmetli',
  'inventory.status_reserved': 'Ayrılmış',
  'inventory.status_under_repair': 'Onarımda',
  'inventory.status_lost': 'Kayıp',
  // Adjectival, like every other badge in this set (Depoda, Zimmetli, Onarımda, Kayıp). "Hurdaya
  // ayrıldı" is a finished sentence, and a table cell reporting a state does not narrate an event.
  'inventory.status_retired': 'Hurdaya ayrılmış',
  'inventory.currency': 'Para birimi',
  'inventory.price_invalid': '{example} gibi bir tutar girin',
  'inventory.count': { one: '{n} demirbaş', other: '{n} demirbaş' },
  'inventory.count_showing': { one: '{n} demirbaş gösteriliyor', other: '{n} demirbaş gösteriliyor' },
  'inventory.search_placeholder': 'Ada, numaraya veya seri numarasına göre ara…',
  'inventory.filter_all_statuses': 'Tüm durumlar',
  'inventory.archived': 'Arşivlenmiş',
  // Not "Geri al": tr.json already spends that on *undo* and *revoke* (`undo`, `dash_undo`,
  // `invite_revoke`), so the same two words in a row menu would read as "undo" beside "Arşivle".
  // "Geri getir" rather than "Geri yükle", for two reasons that point the same way. Kern already
  // has a Turkish word for un-archiving something — `ws_archive_hint` and
  // `ws_archive_confirm_body` both say "geri getir" about an archived workspace — and a module
  // that invents a second one leaves the product saying two things for one action. And "yükle" is
  // already carrying *reload* ("sayfayı yeniden yükleyin") and *load more* ("Daha fazla yükle")
  // in this very bundle; a third sense of the same verb, three lines apart, is a bundle nobody
  // can read quickly.
  'inventory.restore': 'Geri getir',
  'inventory.show_archived': 'Arşivlenmişleri göster',
  // The shell's own catalogue says "Daha fazla yükle" for this English string (`audit_load_more`).
  'inventory.load_more': 'Daha fazla yükle',
  'inventory.row_actions': '{name} için işlemler',
  'inventory.archive_title': '{name} arşivlensin mi?',
  'inventory.archive_body':
    'Listeden çıkar ve numarasını korur. Hiçbir şey silinmez, istediğiniz zaman geri getirebilirsiniz.',
  'inventory.archived_toast': '{name} arşivlendi',
  'inventory.restored_toast': '{name} geri getirildi',
  'inventory.created_toast': '{name} eklendi',
  'inventory.updated_toast': '{name} güncellendi',
  'inventory.load_error': 'Demirbaşlar yüklenemedi',
  'inventory.no_matches': 'Eşleşen bir şey yok',
  'inventory.no_matches_desc': 'Bu aramaya veya bu filtrelere uyan bir demirbaş yok.',
  'inventory.clear_filters': 'Filtreleri temizle',
  'inventory.settings_general': 'Genel',
  'inventory.settings_general_desc': 'Bu çalışma alanının sahip olduklarını nasıl numaralandırdığı.',
  'inventory.settings_numbering': 'Demirbaş numaraları',
  'inventory.settings_numbering_desc':
    'Bundan sonra verilecek her numaranın biçimi. Etikete basılmış numaralar olduğu gibi kalır.',
  'inventory.settings_prefix': 'Ön ek',
  'inventory.settings_prefix_hint': 'En çok 8 karakter, ya da yalnızca rakam için boş bırakın.',
  'inventory.settings_prefix_too_long': 'En çok 8 karakter kullanın',
  'inventory.settings_pad': 'Basamak',
  'inventory.settings_pad_hint': 'Sayının kaç basamağa kadar sıfırla tamamlanacağı.',
  'inventory.settings_pad_invalid': '1 ile 10 arasında bir tam sayı girin',
  'inventory.settings_preview': 'Örnek numara',
  'inventory.settings_saved': 'Ayarlar kaydedildi',
  'inventory.settings_error': 'Ayarlar yüklenemedi',
  'inventory.settings_readonly': 'Bu ayarları görebilir ama değiştiremezsiniz.',
  'inventory.settings_not_enabled': 'Envanter bu çalışma alanında etkin değil',

  'inventory.settings_notices': 'Bildirimler',
  'inventory.settings_notices_desc':
    'Bu çalışma alanına bir garantinin bitmek üzere olduğunun ya da bir demirbaşın serviste fazla kaldığının ne zaman söyleneceği.',
  'inventory.settings_warranty_days': 'Kaç gün önceden uyarılsın',
  'inventory.settings_warranty_days_hint':
    'Garanti bitmeden ne kadar önce haber verileceği. Her demirbaş için bir kez, onu elinde tutan kişiye.',
  'inventory.settings_repair_days': 'Kaç gün sonra onarım sorulsun',
  'inventory.settings_repair_days_hint':
    'Bir demirbaşın serviste ne kadar kalabileceği; sonrasında onarımı kaydeden kişiden takip etmesi istenir.',
  'inventory.settings_days_invalid': '1 ile 365 arasında tam bir gün sayısı girin',
  'inventory.held_by': '{name} kişisinde',
  'inventory.held_by_clear': 'Tüm demirbaşları göster',
  'inventory.widget_title': 'Son eklenenler',
  'inventory.widget_desc': 'Bu çalışma alanına en son eklenen demirbaşlar.',

  'inventory.category': 'Kategori',
  'inventory.category_none': 'Kategorisiz',
  'inventory.filter_all_categories': 'Tüm kategoriler',
  'inventory.categories_error': 'Kategoriler yüklenemedi',
  'inventory.settings_categories': 'Kategoriler',
  'inventory.settings_categories_desc': 'Bu çalışma alanının sahip olduklarını nasıl grupladığı.',
  'inventory.categories_empty': 'Henüz kategori yok',
  'inventory.categories_empty_desc':
    'Şirkete ait olanları gruplayın — dizüstüler, mobilya, kameralar — böylece uzun bir liste tek bir türe daraltılabilir.',
  'inventory.categories_all_archived': 'Bütün kategoriler arşivlenmiş',
  'inventory.categories_all_archived_desc':
    'Birini geri getirmek için arşivlenmişleri gösterin ya da yeni bir kategori ekleyin.',
  'inventory.category_new': 'Yeni kategori',
  'inventory.category_edit': 'Kategoriyi düzenle',
  'inventory.category_name_placeholder': 'Dizüstüler, Mobilya, Kameralar…',
  'inventory.category_order': 'Sıra',
  'inventory.category_order_hint': 'Küçük sayı önce gelir. Sırası aynı olan kategoriler ada göre sıralanır.',
  'inventory.category_order_invalid': '0 ile 9999 arasında bir tam sayı girin',
  'inventory.category_created_toast': '{name} eklendi',
  'inventory.category_updated_toast': '{name} kaydedildi',
  'inventory.category_archived_toast': '{name} arşivlendi',
  'inventory.category_restored_toast': '{name} geri getirildi',
  'inventory.category_archive_title': '{name} arşivlensin mi?',
  'inventory.category_archive_body':
    'Seçim listesinden ve filtreden çıkar. Bu kategoriye girilmiş demirbaşlar kategorilerini korur ve ne olduklarını söylemeye devam eder; istediğiniz zaman geri getirebilirsiniz.',

  'inventory.custody': 'Zimmet',
  'inventory.custody_holder': 'Kimde',
  'inventory.custody_nobody': 'Kimsede değil — depoda',
  'inventory.custody_since': '{date} tarihinden beri zimmetli',
  'inventory.custody_assign': 'Zimmetle',
  'inventory.custody_transfer': 'Devret',
  // Not "Geri al": tr already spends that on *undo* and *revoke*, and this button sits two rows
  // away from "Arşivle" in the same menu.
  'inventory.custody_return': 'Teslim al',
  'inventory.custody_assign_title': '{name} zimmetle',
  'inventory.custody_transfer_title': '{name} devret',
  'inventory.custody_return_title': '{name} teslim alınsın mı?',
  'inventory.custody_return_body': 'Depoya döner ve {person} artık ondan sorumlu olmaz.',
  'inventory.custody_person': 'Kime veriliyor',
  'inventory.custody_person_none': 'Birini seçin',
  'inventory.custody_note': 'Not',
  'inventory.custody_note_hint': 'İsteğe bağlı — nereye gittiği ya da ne için olduğu.',
  'inventory.custody_assigned_toast': '{name}, {person} kişisine zimmetlendi',
  'inventory.custody_transferred_toast': '{name}, {person} kişisine devredildi',
  'inventory.custody_returned_toast': '{name} teslim alındı',
  'inventory.custody_previous': 'Önceki zimmetler',
  'inventory.custody_empty': 'Bu demirbaş henüz kimseye zimmetlenmedi',
  'inventory.custody_empty_desc': 'Birine zimmetleyin, devir burada kaydedilsin.',
  'inventory.custody_error': 'Zimmet kaydı yüklenemedi',
  'inventory.custody_archived_hint': 'Zimmetlemeden önce bu demirbaşı arşivden geri getirin.',
  'inventory.member_former': 'Ayrılmış bir üye',
  'inventory.member_system': 'Sistem',
  'inventory.member_loading': '…',
  'inventory.member_unknown': 'Biri',

  'inventory.history': 'Geçmiş',
  'inventory.history_empty': 'Bu demirbaşla ilgili henüz bir şey olmadı',
  'inventory.history_error': 'Geçmiş yüklenemedi',
  'inventory.history_created': '{actor} ekledi',
  'inventory.history_updated': '{actor} düzenledi',
  'inventory.history_assigned': '{actor}, {person} kişisine zimmetledi',
  'inventory.history_transferred': '{actor}, {person} kişisine devretti',
  'inventory.history_returned': '{actor}, {person} kişisinden teslim aldı',
  'inventory.history_retired': '{actor} arşivledi',
  'inventory.history_restored': '{actor} geri getirdi',
  'inventory.history_unknown': '{actor} değiştirdi — {action}',
  'inventory.history_set': '{field} {to} olarak ayarlandı',
  'inventory.history_cleared': '{field} temizlendi',
  'inventory.history_changed': '{field} {from} değerinden {to} değerine değişti',
  'inventory.history_replaced': '{field} değiştirildi',
  'inventory.history_text_changed': '{field} değişti',
  'inventory.history_show_text': 'Metni göster',
  'inventory.history_text_before': 'Öncesi',
  'inventory.history_text_after': 'Sonrası',
  'inventory.history_note': 'Not: {note}',
  'inventory.history_repair_logged': '{actor} onarıma gönderdi',
  'inventory.history_repair_completed': '{actor} onarımdan döndü olarak kaydetti',
  'inventory.history_attachment_added': '{actor} bir dosya ekledi',
  'inventory.history_attachment_removed': '{actor} bir dosyayı kaldırdı',

  'inventory.details': 'Ayrıntılar',
  'inventory.open': 'Aç',
  'inventory.open_asset': '{name} öğesini aç',
  'inventory.asset_error': 'Bu demirbaş yüklenemedi',
  'inventory.added_on': 'Eklendi',
  'inventory.updated_on': 'Son değişiklik',
  'inventory.photo': 'Fotoğraf',

  'inventory.repairs': 'Onarımlar',
  'inventory.repairs_error': 'Onarımlar yüklenemedi',
  'inventory.repairs_empty': 'Henüz onarım kaydı yok',
  'inventory.repairs_empty_desc':
    'Bir şey onarıma gittiğinde buraya kaydedin ki envanter nerede olduğunu söyleyebilsin.',
  'inventory.repair_new': 'Onarıma gönder',
  'inventory.repair_edit': 'Onarımı düzenle',
  'inventory.repair_summary': 'Sorun ne',
  'inventory.repair_summary_placeholder': 'Kırık ekran, yeni pil…',
  'inventory.repair_detail': 'Ayrıntılar',
  // "Servis", not "Onaran". This bundle's own settings hints already call the place *servis*
  // ("serviste fazla kaldığının", "serviste ne kadar kalabileceği"), and *servis* is the everyday
  // Turkish word for a repair shop where "Onaran" is a participle nobody puts on a form.
  'inventory.repair_vendor': 'Servis',
  'inventory.repair_vendor_placeholder': 'Onarımı kim yapıyor',
  'inventory.repair_cost': 'Maliyet',
  'inventory.repair_sent_on': 'Gönderildi',
  'inventory.repair_returned_on': 'Döndü',
  'inventory.repair_current': 'Onarımda',
  'inventory.repair_past': 'Geçmiş onarımlar',
  'inventory.repair_away_since': '{date} tarihinden beri onarımda',
  'inventory.repair_complete': 'Döndü olarak kaydet',
  'inventory.repair_complete_title': '{name} döndü olarak kaydedilsin mi?',
  'inventory.repair_complete_body':
    'Elinde tutan kişiye geri döner, kimse tutmuyorsa depoya girer. Fatura geldiyse maliyeti de yazın.',
  'inventory.repair_logged_toast': '{name} onarıma gönderildi',
  'inventory.repair_saved_toast': 'Onarım kaydedildi',
  'inventory.repair_completed_toast': '{name} döndü olarak kaydedildi',
  'inventory.repair_archived_hint': 'Onarıma göndermeden önce bu demirbaşı arşivden geri getirin.',
  'inventory.widget_repairs_title': 'Onarımda',
  'inventory.widget_repairs_desc': 'Şu anda onarımda olan her şey.',
  'inventory.widget_repairs_empty': 'Onarımda bir şey yok',

  'inventory.files': 'Dosyalar',
  'inventory.files_error': 'Dosyalar yüklenemedi',
  'inventory.files_empty': 'Henüz dosya yok',
  'inventory.files_empty_desc':
    'Faturayı, garanti belgesini ve kullanım kılavuzunu ait oldukları demirbaşla birlikte tutun.',
  'inventory.file_add': 'Dosya ekle',
  'inventory.file_download': '{name} dosyasını indir',
  'inventory.file_remove': '{name} dosyasını kaldır',
  'inventory.file_remove_title': '{name} kaldırılsın mı?',
  'inventory.file_remove_body':
    'Bu demirbaşın altında listelenmez. Dosyanın kendisi silinmez; başka bir yere eklenmişse orada kalır.',
  'inventory.file_removed_toast': '{name} kaldırıldı',
  'inventory.file_added_toast': { one: '{n} dosya eklendi', other: '{n} dosya eklendi' },
  'inventory.file_upload_failed': '{name} yüklenemedi',
  'inventory.file_unnamed': 'Yüklenen dosya',

  'inventory.photo_none': 'Henüz fotoğraf yok',
  'inventory.photo_set': 'Fotoğraf seç',
  'inventory.photo_replace': 'Fotoğrafı değiştir',
  'inventory.photo_remove': 'Fotoğrafı kaldır',
  'inventory.photo_saved_toast': 'Fotoğraf kaydedildi',
  'inventory.photo_removed_toast': 'Fotoğraf kaldırıldı',
  'inventory.photo_alt': '{name} fotoğrafı',

  'inventory.stats_total': 'Demirbaşlar',
  'inventory.stats_unassigned': 'Kimsede değil',
  'inventory.stats_out_for_repair': 'Onarımda',

  // "Yeniden yükle" is what the shell calls Reload (`pwa_update_reload`), so these use its verb.
  'inventory.error_custody_conflict':
    'Bu demirbaşın kimde olduğunu sizden hemen önce başkası değiştirdi. Şimdi nerede olduğunu görmek için sayfayı yeniden yükleyin.',
  'inventory.error_custody_archived': 'Bu demirbaş arşivlenmiş. Zimmetlemeden önce arşivden geri getirin.',
  'inventory.error_custody_already_held': 'Bu demirbaş şu anda birinde. Devredin, ya da önce teslim alın.',
  'inventory.error_custody_not_held':
    'Bu demirbaş kimsede değil, devredilecek bir şey yok. Bunun yerine zimmetleyin.',
  'inventory.error_asset_still_held': 'Bu demirbaş hâlâ birinde. Arşivlemeden önce teslim alın.',
  'inventory.error_asset_under_repair': 'Bu demirbaş onarımda. Arşivlemeden önce döndü olarak kaydedin.',
  'inventory.error_repair_already_open': 'Bu demirbaş zaten onarımda. Önce o onarımı döndü olarak kaydedin.',
  'inventory.error_repair_archived':
    'Bu demirbaş arşivlenmiş. Onarıma göndermeden önce arşivden geri getirin.',
  'inventory.error_repair_already_complete': 'Bu onarım zaten tamamlandı olarak kaydedilmiş.',
  'inventory.error_repair_returned_before_sent':
    'Bir onarım gönderilmeden önce dönemez. İki tarihi kontrol edin.',
  'inventory.error_category_name_taken': 'Bu çalışma alanında bu adda bir kategori zaten var.',
  'inventory.error_not_found':
    'O artık orada değil. Biri kaldırmış ya da arşivlemiş olabilir — sayfayı yeniden yükleyin.',
  'inventory.error_forbidden': 'Bunu yapma yetkiniz yok.',
  'inventory.error_module_disabled': 'Envanter bu çalışma alanında kapalı.',
  'inventory.error_conflict':
    'Bunu sizden hemen önce başkası değiştirdi. Sayfayı yeniden yükleyip tekrar deneyin.',
  'inventory.error_bad_request': 'Formdaki bir şey kabul edilmedi. Girdiklerinizi kontrol edin.',
  'inventory.error_refused': 'Bu istek kabul edilmedi.',
  'inventory.error_unauthorized': 'Oturumunuz sona erdi. Yeniden giriş yapın.',
  'inventory.error_rate_limited': 'Şu an çok fazla istek var. Biraz bekleyip tekrar deneyin.',
  'inventory.error_unavailable': 'Sunucu şu anda yanıt vermiyor. Birazdan tekrar deneyin.',
  'inventory.error_unknown': 'Bu işlem gerçekleşmedi.',
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
  tr: async () => tr,
}
