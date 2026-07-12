# ALL THE MAIL — Full Product & Engineering Audit

_Date: 2026-07-12 · Scope: backend (Express/Supabase/Google/Stripe), frontend (React CRA), infra config, schema._

This is a review-only audit. Nothing in the application code was changed. Findings are grouped by
theme and ranked by severity within each group. Severity key:

- **P0 – Critical**: data loss, account takeover, silent revenue/feature failure. Fix before launch.
- **P1 – High**: breaks a core promise of the product, or a real security gap with a plausible path.
- **P2 – Medium**: correctness/scale problem that will surface as the user base grows.
- **P3 – Polish**: quality, UX, or premium-tier differentiation.

The codebase is already unusually hardened for its size — there is a visible history of P0/P1/P2
security passes (CSRF, MIME-injection stripping, token encryption, OAuth-state, JWT `jti` revocation,
scope minimization). The findings below are what remains, plus the product-level work that separates a
working app from a premium one.

---

## 1. Security

### P0-A · Scheduled sends and snoozes only execute in the browser
`frontend/src/App.js:1430` runs a `setInterval` that fires due scheduled emails; `hooks/useEmail.js`
does the same for un-snoozing. There is **no server-side worker or cron** (confirmed: nothing in
`backend/` schedules anything). The DB rows in `scheduled_sends` / `snoozed_emails` are written but
nothing on the server ever acts on them.

Consequence: a user schedules "send at 9am," closes the laptop, and the email never sends. For a paid
feature this is a correctness/trust failure, not a polish item — hence P0 despite not being a classic
security bug. **Fix:** move execution to a backend job (Supabase `pg_cron` + an Edge Function, a Render
cron worker, or a small `setInterval` in the API process as a stopgap) that claims `pending` rows via
the existing CAS lock and sends server-side.

### P1-A · Account removal never revokes the Google grant or clears the token cache
`backend/routes/accounts.js:92` deletes the `gmail_accounts` row but does **not** call
`oauth2Client.revokeToken(...)` and does **not** call `invalidateClientCache(accountId)`
(`invalidateClientCache` is exported from `lib/google.js` but has zero call sites).

Consequences:
1. After "remove account," ALL THE MAIL still holds a valid refresh token at Google. The user believes
   access is gone; it is not. This contradicts the Privacy page promise (`Privacy.jsx:141`) and is a
   likely finding in Google's CASA / OAuth verification review.
2. The in-memory OAuth client for that account lives up to 50 minutes (`CLIENT_CACHE_TTL_MS`). If a row
   with the same `accountId` were ever re-created it could transiently use a stale client.

**Fix:** on delete, call `google.auth.OAuth2().revokeToken(refresh_token)` (best-effort, catch errors)
and `invalidateClientCache(accountId)` before the DB delete.

### P1-B · Login CSRF — the initial sign-in flow carries no OAuth `state`
`backend/routes/auth.js:14` (`/auth/google`) builds the auth URL with **no `state` parameter**, and the
callback (`auth.js:62`) explicitly treats a missing/invalid state as "fresh login." Only the
add-account and scope-upgrade flows use state.

This enables **login CSRF**: an attacker completes Google's consent with their own account, captures the
`code`, and tricks a victim into hitting the callback URL — logging the victim into the *attacker's*
account, where the victim may then enter data or connect accounts the attacker can read. Standard
mitigation is a signed/nonce `state` cookie validated on callback. **Fix:** issue a login-purpose state
(you already have `issueOAuthState`) on `/auth/google` and require it on the fresh-login branch.

### P1-C · Remote email images load directly — open-tracking + IP leak by default
`utils/helpers.js:112` allows `src` on `<img>`, and the frontend CSP (`vercel.json`) sets
`img-src 'self' data: https:`. Every tracking pixel in every marketing email loads on render, leaking
open events, IP address, and approximate location to senders. A premium mail client (Hey, Superhuman,
Apple Mail) blocks or proxies remote images by default. **Fix:** strip/defer remote images behind a
"load images" affordance, or proxy them through the backend to strip the client IP.

### P1-D · Third-party correspondence leak to Clearbit
`utils/helpers.js:71` (`getSenderLogoUrl`) requests `https://logo.clearbit.com/<domain>` for every
non-personal sender. That silently tells a third party the domains of everyone the user corresponds
with — a meaningful privacy leak for a product whose pitch is respecting account separation. **Fix:**
proxy/caches logos server-side, or drop Clearbit for a local icon set.

### P2-A · Single Supabase service-role key is the whole security boundary
`lib/supabase.js` uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS. The RLS policies in
`database-schema.sql` are therefore dead — every query is fully privileged. This is a defensible design
(the API is the only DB client), but it means any SSRF, log leak, or RCE in the API is total DB
compromise. Document this explicitly, keep the key out of all logs (mostly handled by `safeLogError`),
and consider a read-scoped key for read paths later.

### P2-B · In-process security state breaks the moment you run two instances
OAuth state (`lib/security.js`), JWT `jti` revocation, rate-limit counters, and the plan cache are all
in-process `Map`s. On Render free tier (single instance) this works, but the instant you scale
horizontally or the instance restarts mid-flow: OAuth logins fail (state not found on the other
instance), logout no longer revokes (jti set is per-process), and rate limits become per-instance. The
code comments acknowledge this. **Fix before scaling:** move state/jti to Supabase or Redis; use a
shared store for `express-rate-limit`.

### P3-A · `helmet` HSTS/defaults vs. `crossOriginEmbedderPolicy:false`
Reasonable given Google OAuth redirects, but worth a comment confirming COEP-off is intentional and
scoped. Low risk.

---

## 2. Architecture, Data & Scalability

### P1-E · `database-schema.sql` is stale and actively misleading
The canonical schema file defines `connected_accounts` with **plaintext `access_token` / `refresh_token`
columns** and a `user_settings` table — but the running code uses `gmail_accounts` with
`encrypted_tokens`, plus `subscriptions`, `stripe_customers`, `stripe_events`, `snoozed_emails`,
`scheduled_sends`. There is no checked-in `CREATE TABLE gmail_accounts`. A new engineer running
`database-schema.sql` builds a schema the app can't use, and a reader is misled into thinking tokens are
stored in plaintext. (CLAUDE.md says do not modify this file — so flag it, don't edit it: it needs an
owner decision to regenerate from the true schema + migrations.)

### P2-C · No pagination anywhere
Email list is capped at 100 with no `nextPageToken` surfaced (`routes/emails.js:300`); Drive list is a
flat `pageSize: 50` (`routes/docs.js`); calendar fans out `maxResults: 100` per calendar. Users with
real mail volume cannot reach older items. A unified inbox that can't scroll past 100 messages reads as a
demo. **Fix:** thread `pageToken` through list endpoints and add infinite scroll.

### P2-D · Per-account fan-out has no cross-account concurrency ceiling
`useContacts.js`, the "Everything" view, and calendar all `Promise.all` across every connected account
simultaneously; calendar additionally fans out across every calendar per account. A user with 8 accounts
× 10 calendars issues ~80 parallel Google calls on one load. Add a small concurrency limiter (the
`pMap` helper in `emails.js` already exists — promote it to a shared util).

### P2-E · Contacts cache is keyed by `accountId` only, and read before the ownership check
`routes/emails.js:995` returns the cached contacts before `verifyAccountOwnership`. `accountId` is an
unguessable UUID so the practical risk is low, but the cache should be keyed `${userId}:${accountId}` and
the ownership check should precede any cache hit — same pattern the email-body cache follows.

### P3-B · Monolith components remain
`App.js` is still 2,294 lines holding most modal/compose/slide-over state and JSX. The refactor extracted
Mail/Docs/Cals/Everything modules but left the shell enormous. This is a maintainability tax, not a bug;
continue extracting ComposeModal state and the slide-over into their own components/hooks.

---

## 3. Functionality & Correctness

### P2-F · Calendar times are formatted on the server in the server's timezone
`routes/calendar.js:151` builds display strings (`toLocaleTimeString`, "Today/Tomorrow") on the backend.
Render runs UTC, so a 7pm PT event renders as the wrong time/day for the user. All-day handling is
carefully corrected, but timed events inherit the server locale. **Fix:** return only ISO timestamps and
format in the browser (the frontend already has `parseEventStart` and formatting helpers).

### P2-G · Webhook `invoice.subscription` may be null on newer Stripe shapes
`routes/billing.js:351,375` read `inv.subscription`. That field is being removed from the Invoice object
in current Stripe API versions (moved under `parent`/lines). You've pinned `2024-12-18.acacia`, so it
works today, but a future SDK/API bump silently breaks renewal + past_due handling. Add a fallback that
reads the subscription id from `inv.lines.data[0].subscription` / `inv.parent`.

### P3-C · Batch multipart parser reconstructs index from `Content-ID` that it never sets in that form
`lib/gmailBatch.js` sends `Content-ID: <item-N>` but the parser matches `<response-item-(\d+)>` and
otherwise falls back to positional order. Gmail generally preserves order so it works, but the
"recover index from Content-ID" path is effectively dead. Align the sent and parsed Content-ID forms so
out-of-order responses are actually handled.

### P3-D · Silent partial failures
Batch fetches drop failed sub-requests with only a `console.warn` (`emails.js:373`). The user sees 49 of
50 messages with no indication one is missing. A subtle "1 message failed to load — retry" affordance
would prevent confusion.

---

## 4. Premium Product Opportunities

These are what move it from "works" to "worth paying for."

- **Server-side send/snooze (see P0-A)** is table stakes for the pricing page's promises.
- **Unified search across accounts.** Today search is per-account. A single query fanning across all
  connected inboxes (with source chips on results) is the headline feature a multi-account user pays for.
- **Real-time via Gmail `users.watch` + Pub/Sub** instead of 30s polling (`App.js:904`). Push
  notifications and instant inbox updates read as premium; polling reads as a hobby project.
- **Undo send is client-only.** The `sendDelaySeconds` hold-then-send lives in the tab; a true
  server-scheduled short-delay send (cancellable) is more reliable and demoable.
- **Keyboard-first command palette** already exists (`paletteOpen`) — lean into it; it's the single
  biggest "premium mail" signal and it's half-built.
- **Attachment previews inline** (PDF/image) rather than download-only.
- **Read receipts / open tracking as an opt-in feature** (you're already loading remote images — invert
  it into a user-facing feature with a privacy toggle).
- **Snooze/scheduled visibility across devices** — once execution is server-side, surface the queue
  everywhere, not just localStorage.

---

## 5. Testing & Delivery

- Backend tests (`__tests__/routes.test.js`) mock Supabase with a hand-rolled chained stub that returns
  `null` for everything — they assert routes wire up and 401 correctly but exercise almost no business
  logic (billing idempotency, MIME building, scope gating, CAS locking). The highest-value untested paths
  are the Stripe webhook state machine and `buildMimeEmail` header sanitization. Add focused unit tests
  there.
- `render.yaml` pins the API to Render **free** tier, which spins down on idle — cold starts + lost
  in-memory OAuth state will produce intermittent "login failed" reports. Move to a paid instance before
  launch, or externalize the ephemeral state (P2-B).
- No CI config is present in-repo (no `.github/workflows`). Add lint + `npm test` (both packages) +
  Playwright on PRs.

---

## Priority order (recommended)

1. **P0-A** server-side scheduled-send/snooze execution — a paid feature is currently non-functional when the tab closes.
2. **P1-A** revoke Google tokens + clear cache on account removal — security promise + Google review risk.
3. **P1-B** add OAuth `state` to the login flow — close login CSRF.
4. **P1-C / P1-D** default remote-image blocking + drop the Clearbit leak — privacy positioning.
5. **P1-E** regenerate the canonical schema file so it matches reality.
6. **P2 batch**: pagination, unified search, timezone-correct calendar, Stripe invoice-subscription fallback, shared-store for security state before scaling.
