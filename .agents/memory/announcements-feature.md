---
name: Announcements feature
description: Fleet announcement system — schema, routes, rally levels, and frontend
---

# Rally Levels
The four rally levels (stored as plain text in DB):
- `"MAX CTA"` — red color in UI (`bg-red-500/20 text-red-400`)
- `"CTA"` — orange (`bg-orange-500/20 text-orange-400`)
- `"战略"` — yellow (`bg-yellow-500/20 text-yellow-400`)
- `"散打"` — green (`bg-green-500/20 text-green-400`)

# Architecture
- DB table: `announcements` (id, fc, scheduled_at, rally_point, rally_level, notes, created_at)
- API: GET/POST `/api/announcements`, DELETE `/api/announcements/:id`
- Admin page: `/admin/announcements` via `AdminAnnouncements` component
- Dashboard: "Fleet Notices" panel shows upcoming announcements (replaces active fleet display)
- Members can see announcements; only admins can create/delete

# Key decisions
- Dashboard "Fleet Notices" panel shows announcements from `useListAnnouncements`, NOT active fleets
- i18n keys for rally levels live at `announcements["MAX CTA"]`, `announcements["CTA"]`, etc.
