# ChatLDS Mobile — Backend Sync Contract

The native apps (`../chatlds-app`, SwiftUI on iOS and Compose on Android) are
**thin clients over THIS API**. The backend stays unchanged for the happy path. When you change any
of the surfaces below, update the mobile app **in the same change** and add a
`CHANGELOG.md` entry.

Architecture and plan: `docs/MOBILE_APP_PLAN.md` (written for the old Expo app) and
`../chatlds-app/SPEC.md`.

## What the app consumes

- **Auth** — Clerk **bearer** (`Authorization: Bearer <session token>`), verified
  by `src/proxy.ts`. Unauthenticated API requests `307 → /sign-in`; a valid
  bearer passes straight through. Keep bearer auth working.
- **POST `/api/conversations`** — create; app reads `id` + `initialMessageId`.
- **POST `/api/chat`** — **AI SDK UI Message Stream** (SSE, protocol `v1`; the
  server runs ai@7, the app parses it with ai@6 — verified compatible in 0.12.85)
  with `useChat`. Don't change the stream protocol without bumping the mobile client's
  `ai` / `@ai-sdk/react` pins to match. **Request contract:** send only the
  latest UI message (`messages: messages.slice(-1)`) — the server reads only
  `messages.at(-1)` and loads history from the DB, while every message's
  `metadata` carries its full sources/versions. The schema is unchanged
  (`messages` is any array), so older clients that send everything still work.
  Only `trigger: "regenerate-message"` regenerates an answer; a retry that
  resends the history as a submit becomes a new turn, even when it carries a
  `messageId` (0.12.75).
- **GET `/api/conversations`**, **GET `/api/conversations/[id]`** — list / history (M2).
  The list takes optional `?q=` (case-insensitive title search, 0.12.80).
- **GET `/api/chat/[id]/stream`** — resume in-flight answer (M2).
- Used by the app since mobile 1.0.5: **POST `/api/conversations/[id]/follow-ups`**
  returns `{ messageId, followUps: string[] }` (suggested next questions for the
  latest answer), also stored as `details.followUps` on that message in
  GET `/api/conversations/[id]`. Both are additive; ignoring them is fine.
- **GET `/api/sources`** (0.12.102) — public, no auth, cached 5 min:
  `{ "standard": [...ALL_SOURCES], "super": [...SUPER_SOURCES] }` (ids only, display
  order, straight from `types.ts`). Apps read the source lists from here instead of
  hardcoding them; Standard now includes `gospel_teachings`.
- Realtime voice (`/api/realtime/*`, 0.12.86) is web-only for now; the app does not use it.
- **DELETE `/api/account`** (0.12.88) — in-app account deletion required by App
  Store / Play. Bearer auth, no body, `204` on success, `502 { error }` on failure
  (safe to retry). First cancels any paid Clerk Billing subscription items
  immediately (no proration/refund handling), then erases all stored user data
  and the Clerk user; transient caches (Redis usage counters, remember keys,
  resumable streams, logs) expire on their own TTL. On `204` the app must drop
  its token and cancel in-flight requests. Consumed by the native apps in
  `../chatlds-app`, not the old Expo app.
- **POST `/api/billing/handoff`** (0.12.90) — Bearer auth, no body, `401 { error }`
  if not signed in, else `200 { url }`: a `/sign-in?__clerk_ticket=…&redirect_url=/billing`
  link on the server's own origin (dev.chatlds.it -> dev.chatlds.it). The ticket is
  single-use and expires in 60s, so open it in the system browser immediately. If
  that browser is already signed in as the same user (`uid` in the URL), the server
  skips the ticket and sends it straight to `/billing`; if it is signed in as a
  different user, it stays on that account's home (no purchase on the wrong
  account). Consumed by `../chatlds-app`.
- On the M2 radar: `/api/feedback`, `/api/memory`, `/api/settings`, `/api/search`.

## Copied types

The native apps' hand-copied models (`../chatlds-app`) are a subset of `src/lib/types.ts` +
`src/lib/api/validation.ts` (`SourceType`, `UiLanguage`, `DEFAULT_SOURCES`, the
create-conversation response). **If you change those shapes, update the copy.**

## Don'ts

- Don't require CORS for native — native `fetch` has no CORS. But keep the current
  LAN dev IP in `next.config` `allowedDevOrigins` so phone testing works.
- Don't surface the web Stripe/Clerk checkout inside a store build (App/Play IAP
  rules — see `docs/MOBILE_APP_PLAN.md` billing).
