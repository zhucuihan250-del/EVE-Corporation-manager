---
name: EVE SSO token refresh
description: Auto-refresh of expired ESI access tokens before fleet scanning
---

# Implementation
`refreshAccessToken(refreshToken)` added to `artifacts/api-server/src/lib/eve-sso.ts`. Uses `grant_type: refresh_token` against `https://login.eveonline.com/v2/oauth/token`.

# Where it's used
Fleet scan endpoint (`POST /api/fleets/:id/scan`) in `fleets.ts`:
- Checks if `tokenExpiry` is within 60 seconds of now or already past
- If yes, calls `refreshAccessToken` and updates `usersTable` with new tokens
- Uses the fresh `accessToken` for the ESI members call

**Why:** EVE SSO tokens expire in ~20 minutes. Fleet commanders who haven't logged in recently would get 401s from ESI without this refresh logic. The token expiry was the root cause of "participant count not showing" (issue 2).
