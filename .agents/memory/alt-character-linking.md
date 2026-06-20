---
name: Alt character linking flow
description: How alt character linking works via EVE SSO re-auth
---

# Flow
1. User visits `/api/auth/eve/link-alt` (requires auth via `requireAuth` middleware)
2. Server sets `req.session.linkingUserId = req.session.userId` and saves session
3. Server redirects to EVE SSO with the same callback URL as normal login
4. User authenticates with their alt character in EVE SSO
5. Callback detects `req.session.linkingUserId` is set
6. Checks if that `eveCharacterId` already exists in `characters` table
   - If yes → redirects to `/characters?error=already_linked`
   - If no → inserts new `characters` row with `userId=mainUserId, isMain=false`
7. Clears `linkingUserId` from session, saves, redirects to `/characters?linked=true`

# Frontend handling
`Characters` page (`/characters`) reads `?linked=true` and `?error=already_linked` URL params to show toasts.

# Session type
`linkingUserId?: number` is declared in `SessionData` in `artifacts/api-server/src/middlewares/auth.ts`.

**Why:** EVE SSO only supports one callback URL, so we reuse the same callback and distinguish flows via session state.
