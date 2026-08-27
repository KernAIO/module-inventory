---
'@kernhq/module-inventory': minor
---

Order categories by dragging them, and stop asking for a position number

The categories settings page asked an administrator to type a **position** into a number field, with
a hint explaining that lower comes first and that two categories sharing a number fall back to their
names. That is a database column with a form around it: nobody arranges their filing by integer, the
field invited the one state it then had to explain, and moving a category two places meant working
out a number that would land it there.

It is a list you drag now. `categories.reorder` takes the ids in the order they were dragged into
and renumbers the live set in one transaction — the only thing that writes `order`. It insists on
being handed every live category exactly once: a list that leaves one out is not an instruction to
leave it alone, it is an ordering of a workspace that changed while the page was open, so the whole
call is refused with `inventory.category.order_stale` rather than dropping the missing category
wherever its stale number happened to land. An id from another workspace is `NOT_FOUND`, before
anything is written.

**A drag is a gesture, never a requirement, and the move-up and move-down buttons are the keyboard
route to the same thing.** They are the *only* one: the drag library ships a keyboard drag of its
own, and shipping both left both half-working — a tab stop on every row that announced nothing, and
a write on every arrow key of which all but the first were discarded — so it is switched off rather
than kept as a worse duplicate of two real buttons. The result is spoken into a live region —
"Cameras is after Laptops", never a position number. Presses that arrive while a save is in flight
are coalesced into one follow-up write instead of being dropped, so three quick presses move the row
three places and each one is announced where it actually landed.

A refusal is recoverable. `inventory.category.order_stale` used to roll the screen back to the list
the server had just refused, so every retry earned the same refusal under a message telling the
reader to try again; the list now re-seeds from what the server actually has, and the message says
that this order was not saved rather than implying the drag only needed repeating.

`CategoryInput` no longer takes `order`, on create or on update: a second way to set the sequence
would disagree with the first the moment anybody used it. **A new category now joins the end** of
the list instead of landing at position 0 tied with everything else, and a restored one joins the
end too rather than returning to a number that belongs to somebody else by now.

**No two live categories share a place, and `0008_category_order_unique.sql` is what makes that a
fact rather than an intention.** Appending took `max("order") + 1`, and putting that subquery inside
the write removed a round trip without removing the race: under READ COMMITTED two transactions
appending at the same instant both read a list without the other's row in it and both took the same
number. Creates and restores are now serialised per workspace, `reorder` parks the rows it is moving
above the sequence before putting them down so a swap never trips the index on the way, and a
partial unique index over the live rows refuses the pair whatever else reaches the table. The
migration renumbers any duplicates an existing instance is holding *before* it builds the index —
an index that met them would throw during boot, and a module's migrations are the first thing the
host service runs.

The ceiling on `categories.reorder` is stated rather than silent. Its input array is bounded, as any
array a client fills has to be, and the same number — `MAX_LIVE_CATEGORIES`, exported from the
contract — is enforced by `create` and by a restore, with `inventory.category.limit_reached` and a
sentence naming the figure in the reader's own digits. A workspace can no longer grow past the bound
one category at a time and then find that the only procedure able to order them refuses to run.

The module also reports its own name in the reader's language now: `name` on the client manifest is
`get name() { return t('nav') }` rather than an English literal, which is what the dashboard's widget
picker heads this module's group with.
