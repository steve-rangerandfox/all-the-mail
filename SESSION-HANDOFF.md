# Session handoff — ALL THE MAIL premium audit + build

_Purpose: let a fresh Claude Code session resume exactly where the prior session stopped._
_Branch: `claude/all-the-mail-audit-fghne7` · Read `AUDIT-PREMIUM.md` for the full plan + status table._

## What this work is
A premium-readiness audit of ALL THE MAIL (unified multi-Google-account mail/docs/calendar,
$15/mo card-upfront trial) plus phased implementation of the fixes, aimed at reaching 1,000+ paying
users. Three lenses: Gmail-parity experience, security, design cohesion. Plus a 1,000-run Monte Carlo
on commercial feasibility.

## Deliverable docs already on this branch
- `AUDIT.md` — full engineering/security audit.
- `AUDIT-PREMIUM.md` — the premium audit (4 lenses + Monte Carlo + **Implementation status table** +
  reordered priority path). **Start here.**
- `monte-carlo-model.py` — runnable feasibility model (P(1,000 payers): ~9% status quo → 80–98% with
  product fixes + funded distribution; distribution is the binding constraint, not the product).

## Shipped (committed on this branch, tested)
- **Phase 1 — security gate:** account removal now revokes the Google grant + fixed `invalidateClientCache`
  key bug. `backend/lib/google.js`, `backend/routes/accounts.js`, `backend/__tests__/google.test.js`
  (5 tests pass).
- **Phase 3 — design cohesion:** purged the banned violet AI-accent → brand red (36 spots).
  `frontend/src/design-system.css`, `frontend/src/App.js`. Build compiles.
- **Phase 4 — privacy:** dropped the Clearbit correspondence leak; block remote email images by default
  with a "Show images" opt-in wired into all 3 readers. `frontend/src/utils/helpers.js` (+tests),
  `App.js`, `MailModule.js`, `EverythingModule.js`. 64 helper tests pass; build compiles.
- **Audit correction:** unified cross-account search already exists (`useEmail.js:470 searchAllAccounts`),
  downgraded from P0 to P2.

## Next phases (NOT started — deliberately, need live verification)
Priority order (see AUDIT-PREMIUM.md "Path to 1,000"):
1. **Google OAuth verification** — Phase 1 is the code half; still need to apply for verified status to
   lift the 100-user cap. Hard gate before any growth.
2. **P0-A server-side scheduled-send/snooze/undo worker** — currently these only run in the browser tab,
   so scheduled sends silently fail when the tab closes. Needs a backend job (Supabase pg_cron / Render
   worker) claiming `pending` rows via the existing CAS lock. **Sends real email — verify on staging.**
3. **P1-B login CSRF `state`** — `/auth/google` issues no OAuth state; add cookie-bound state, verify on
   the fresh-login branch of `backend/routes/auth.js`. **Auth path — needs a live OAuth smoke test.**
4. Experience: list virtualization + pagination (stops at 100), Gmail `users.watch` push (vs 30s poll),
   mobile PWA.
5. UTC calendar formatting bug (`backend/routes/calendar.js:151` formats in server TZ; return ISO,
   format client-side).
6. Fund distribution (~$1.5–3K/mo ads + SEO); keep the $15 card-upfront model (Monte Carlo validated it).

## Key context / decisions
- Backend tests: 10 pre-existing failures are CSRF-middleware 403s in the test harness (tests predate
  `requireCsrfHeader` and don't send `X-Requested-By`). Not caused by this work. Fixing the harness is a
  small separate task.
- Design: `design-system.css` (4,710 lines) and `brand.css` (1,050) are two overlapping systems; brand.css
  wins by import order. Consolidating to one is open design debt (P1-B design in the audit).
- Do NOT revert to the older market-doc freemium/$9 recommendation — the shipped $15 card-upfront tier is
  the modeled-best path to paying users.

## How to verify after resuming
- Backend: `cd backend && npm install && npm test` (expect the 10 pre-existing CSRF failures only).
- Frontend: `cd frontend && npm install && CI= npx react-scripts build` (compiles with pre-existing warns).
