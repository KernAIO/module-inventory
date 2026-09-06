---
'@kernhq/module-inventory': minor
---

Fill a workspace created with example content: forty items across six categories, three workspace
fields, three handovers and two repairs.

The categories are found rather than created — `onWorkspaceEnabled` already puts five there, and
`CategoryService.create` refuses a duplicate name with a conflict that would abort the whole seed on
its first statement. Custody goes through `CustodyService.assign`, so a handed-over item has the
period behind it that its own history screen reads, rather than a column somebody set.
