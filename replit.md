# EVE Online PAP Tracker

## Overview

Full-stack web application for managing an EVE Online corporation Participation Activity Points (PAP) system. Members log in via EVE SSO, track fleet participation, and redeem rewards. Admins manage fleets, PAPs, rewards, and users.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite (artifacts/pap-tracker) at path `/`
- **API framework**: Express 5 (artifacts/api-server) at path `/api`
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: EVE Online SSO (OAuth2) with express-session + connect-pg-simple
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Authentication Flow

1. User clicks "AUTHORIZE VIA EVE SSO" → redirected to `/api/auth/eve/login`
2. EVE SSO OAuth2 redirects back to `/api/auth/eve/callback`
3. Server exchanges code for token, fetches character info from ESI, creates/updates user
4. Session stored in PostgreSQL via `connect-pg-simple`
5. First user to register becomes admin automatically

## Key Secrets Required

- `EVE_CLIENT_ID` — EVE developer app client ID
- `EVE_CLIENT_SECRET` — EVE developer app client secret
- `SESSION_SECRET` — Express session secret (already set)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Database Schema

Tables:
- `users` — EVE characters with role (member/admin), totalPap, redeemablePap
- `characters` — linked EVE characters per user (supports multiple alts)
- `fleets` — registered fleet operations with FC, PAP value, active status
- `pap_records` — all PAP awards (fleet/manual/adjustment) with history
- `rewards` — redeemable items (PLEX, Skill Injectors, etc.) with PAP costs
- `redemptions` — user redemption history with status tracking

## Route Map

### Frontend (/)
- `/` — EVE SSO login page
- `/dashboard` — Member PAP summary and recent activity
- `/history` — Full PAP history for current user
- `/rewards` — Rewards catalog with redemption
- `/redemptions` — User's redemption history
- `/admin` — Admin overview with corp stats
- `/admin/users` — Manage users and roles
- `/admin/fleets` — Manage fleet operations
- `/admin/rewards` — Manage reward catalog
- `/admin/redemptions` — All redemption requests
- `/admin/pap` — Global PAP ledger

### API (/api)
- `GET /api/auth/eve/login` — EVE SSO redirect
- `GET /api/auth/eve/callback` — EVE SSO callback
- `GET /api/auth/me` — current user
- `POST /api/auth/logout`
- `GET /api/users` — all users (admin)
- `PATCH /api/users/:id/role` — update role (admin)
- `PATCH /api/users/:id/pap` — manual PAP adjustment (admin)
- `GET /api/characters` — current user's characters
- `GET /api/fleets` — all fleets
- `POST /api/fleets` — create fleet (admin)
- `POST /api/fleets/:id/participants` — add participant + award PAP (admin)
- `GET /api/pap` — current user's PAP records
- `GET /api/pap/all` — all PAP records (admin)
- `POST /api/pap/manual` — manual PAP award (admin)
- `GET /api/rewards` — all rewards
- `POST /api/rewards` — create reward (admin)
- `GET /api/redemptions` — current user's redemptions
- `POST /api/redemptions` — redeem a reward
- `GET /api/redemptions/all` — all redemptions (admin)
- `GET /api/dashboard/summary` — user dashboard stats
- `GET /api/dashboard/admin-summary` — admin corp stats
- `GET /api/dashboard/top-contributors` — leaderboard
- `GET /api/dashboard/recent-fleets` — recent fleet activity

## EVE Developer App Setup

Create an app at https://developers.eveonline.com/ with:
- Callback URL: `https://your-domain.replit.app/api/auth/eve/callback`
- Scope: `publicData`
