# ALL THE MAIL — Premium Readiness Audit

_Date: 2026-07-12 · Lens: Gmail-parity experience · Security · Design cohesion · Commercial goal: a premium product that sustains 1,000+ paying users at $15/mo._

This audit reruns the three passes the product was originally shaped around — **experience
(Gmail-close), security, and design** — and re-scores each against a single question: _is this
worth $15/mo to 1,000 people who already have Gmail for free?_ At that scale ($180K ARR), the bar
is not "does it work" — it's "does it feel inevitable." Findings are ranked P0–P3 within each lens.

**History recovered.** The prior work is legible in the repo itself: 110 commits on `main`, a visible
security campaign (P0–P3 annotations across `auth.js`, `emails.js`, `billing.js`, the `security.js`/
`csrf.js`/`gmailErrors.js` libs), a performance campaign (PRs #33–36: SWR list cache, IndexedDB bodies,
Gmail batch-HTTP fan-out), and a design consolidation (PR #37 + `DESIGN.md`/`brand.css`). This audit
measures what those campaigns left on the table against the premium bar — it does not restart them.

---

## Executive read

The engineering floor is high — genuinely. Token encryption, CSRF, OAuth-state, JWT `jti` revocation,
MIME-injection stripping, Stripe idempotency, batch-HTTP inbox loading, IndexedDB SWR caching, a
keyboard layer, search operators. Most $15/mo competitors don't have this discipline under the hood.

But three things sit between this and 1,000 paying users, one per lens:

1. **Experience:** the inbox is fast to _first paint_ but not Gmail-fast to _scroll and search_, and the
   headline multi-account promise (unified cross-account search) isn't built. **P0-A** below is also an
   experience-killer: scheduled send silently fails when the tab closes.
2. **Security:** the hardening is real but leaks trust at the edges — account removal doesn't revoke
   Google access, login has no CSRF `state`, and every sender domain is broadcast to Clearbit.
3. **Design:** the "one cohesive premium surface" story is contradicted in the code — the **banned
   violet AI-accent still ships in 24 places** in `design-system.css`, layered under `brand.css`. The
   brand doc says paper/ink/red; the app still paints lilac gradients.

Fix those and the product earns the price. The rest is polish.

---

## Lens 1 — Gmail-parity experience

The competitive frame (from your own market analysis): Superhuman is $30/mo single-account; Shortwave
is Gmail-only; the container apps (Shift/Wavebox) don't unify at all. Your wedge is **unified
multi-account** at half Superhuman's price. That wedge only closes if the daily-driver mechanics feel
at least as good as Gmail. Today they're close but not there.

### P0-A · Scheduled send / snooze execute only in the browser tab
`App.js:1430` and `hooks/useEmail.js` run `setInterval` loops that fire due sends and un-snoozes. There
is **no server-side worker** (confirmed: nothing in `backend/` schedules anything). Close the laptop and
a 9am scheduled send never goes out. For a paid email client this is the single most damaging bug on the
list — it breaks a feature the pricing page implies and email users trust unconditionally in Gmail.
**Fix:** a backend job (Supabase `pg_cron` + Edge Function, or a Render worker) that claims `pending`
rows via the existing CAS lock and sends server-side. Un-snooze likewise.

### P0-B · No unified cross-account search — the headline feature is missing
Search is per-account (`emails.js:311` passes `q` to one account's Gmail API). The entire reason a
5-Gmail user pays you instead of using tabs is **one search box across all inboxes**. Right now they
still have to pick an account first, which is the exact pain the product claims to remove. This is the
feature that converts the demo into a subscription. **Fix:** a `/emails/search-all` route that fans out
`messages.list` across every `mail`-scoped account (concurrency-limited), merges by date, tags each
result with its source chip. The frontend already renders source chips everywhere.

### P1-A · Inbox scroll and search aren't Gmail-fast past the first screen
- **No list virtualization** (confirmed: no `react-window`/virtuoso). `MailModule.js:215` maps the full
  `filteredEmails` array to DOM nodes. First 50 is fine; a power user with a big unified list will feel
  jank Gmail never shows. **Fix:** virtualize the list.
- **No pagination** (`emails.js:300` caps at 100, no `nextPageToken` surfaced). You cannot scroll to
  older mail at all. Gmail is effectively infinite; a client that stops at 100 reads as a demo.
- **Local search filters an in-memory array** (`useEmail.js:359`) — good for instant feel on loaded
  mail, but it silently doesn't cover mail you haven't fetched, so results look wrong ("I know that
  email exists"). Pair local instant-filter with a server search fallback.

### P1-B · Polling, not push — the inbox is up to 30s stale
`App.js:904` polls every 30s. Gmail is instant. New mail arriving 30s late, and read-state not syncing
across your own devices, both read as "not quite real." **Fix:** Gmail `users.watch` + Pub/Sub push for
new-mail signal; drop the poll to a slow fallback. This is a top-3 "feels premium" lever.

### P1-C · Undo Send is client-only
`sendDelaySeconds` holds the send in the tab (`App.js`), so closing the tab during the hold either drops
or force-sends depending on timing. Gmail's undo-send is server-side and reliable. Fold this into the
P0-A server worker (queue with a short cancelable delay).

### P2 · Parity gaps that individually annoy, collectively signal "not my main client"
- **Calendar times formatted server-side in UTC** (`calendar.js:151`) — Render is UTC, so timed events
  render at the wrong time/day for the user. Return ISO, format in the browser (helpers already exist).
- **Remote images auto-load** with no per-sender control (privacy _and_ a features gap — see Security).
- **Partial inbox failures are silent** (`emails.js:373` warns to console only) — user sees 49 of 50
  messages with no "retry" affordance.
- **No labels/folders management, no filters/rules, no multi-select drag** — Gmail power users expect
  these. Not P0, but the gap widens the more accounts you unify.

### What's already good (keep it)
Keyboard layer (`j/k/e/c`, `⌘K` palette, `?` help), search-operator chips (`from:`, `has:attachment`,
`is:unread`…), saved searches, IndexedDB SWR body cache, Gmail batch-HTTP fan-out, contacts
autocomplete from sent-mail, per-account signatures. This is a strong spine — the P0/P1 items above are
what make it a _daily driver_ rather than a good demo.

---

## Lens 2 — Security

The prior campaign was thorough. What remains are trust-boundary leaks — the kind that don't fail a pen
test but do fail a privacy-conscious buyer or a Google OAuth review, and this audience (founders,
lawyers, consultants running 5 identities) is _exactly_ the privacy-conscious buyer.

### P1-A · Account removal never revokes the Google grant
`accounts.js:92` deletes the DB row but never calls `revokeToken(refresh_token)` and never calls
`invalidateClientCache(accountId)` (the latter is exported from `lib/google.js` with **zero call
sites**). After "remove account," you still hold a live refresh token at Google. This contradicts your
own Privacy page (`Privacy.jsx:141`) and is a likely finding in Google's CASA / OAuth verification —
which you _must_ pass to lift the 100-user cap and reach 1,000 users. **This one is on the critical path
to scale, not just correctness.** Fix: best-effort `revokeToken` + cache invalidation on delete.

### P1-B · Login flow has no OAuth `state` (login CSRF)
`/auth/google` (`auth.js:14`) builds the auth URL with no `state`; the callback treats missing state as
a fresh login (`auth.js:62`). Add-account and scope-upgrade flows _are_ protected — login isn't. An
attacker can log a victim into the attacker's account. `issueOAuthState` already exists; issue a
login-purpose token and require it on the fresh-login branch.

### P1-C · Every sender domain is broadcast to Clearbit
`helpers.js:71` fetches `logo.clearbit.com/<domain>` for each non-personal sender — silently telling a
third party who your users correspond with. For a product whose pitch is _respecting_ account
separation, this is an on-brand-breaking leak. Proxy/cache logos server-side or drop Clearbit for a
local icon set.

### P1-D · Remote email images leak IP + open events by default
`helpers.js:112` allows `<img src>`; CSP `img-src https:` lets every tracking pixel load on render.
Premium clients block/proxy by default. **Turn this into a feature:** default-block remote images with a
one-click "load images," and optionally a proxy that strips the client IP. Privacy-as-a-feature is a
selling point for this exact audience.

### P2 · Scale-time security debt
- **In-process security state** (OAuth state, `jti` revocation, rate limits, plan cache are all
  in-memory `Map`s). Single Render instance today; the moment you scale horizontally to serve 1,000
  users, logins fail across instances, logout stops revoking, and rate limits become per-instance.
  Move to Supabase/Redis before scaling. This is also on the path-to-scale critical list.
- **Render free tier** (`render.yaml`) spins down on idle → cold starts drop in-memory OAuth state
  mid-flow → intermittent "login failed." Move to a paid instance before launch.
- **Single service-role Supabase key** bypasses RLS entirely (the RLS policies in the schema are dead
  code). Defensible, but document it and keep it out of logs.

---

## Lens 3 — Design cohesion

`DESIGN.md` describes a genuinely premium, opinionated system: paper/ink/signature-red, hard edges,
printed offset shadows, one easing curve, editorial layout, and an explicit **banned list** (Inter,
pure black/white, "lila/violet AI accents `#8b7cff`", gradient text, glassmorphism-by-default). The
problem is the code doesn't match the doc — the design pass regressed and was never fully cleaned up.

### P1-A · The banned violet AI-accent still ships — in 24 places
`design-system.css` (4,710 lines) still defines `--accent: #7c6bf0` (line 126) and paints
`rgba(139, 124, 255, …)` as **background washes, scrollbar tints, and radial "AI gradients"** (lines
397, 402, 407, 423, 473, 522, 546, 769, 1873–1875, …). `App.js` imports **both** `design-system.css`
_and_ `brand.css`; `brand.css` only overrides the tokens it redefines, so anything using the raw violet
rgba literals (not the `--accent` token) still renders lilac. This is the single most visible
contradiction of the "cohesive premium surface" story — the brand doc bans exactly this color and calls
it an "AI-default tell," yet it's live in the app shell. **Fix:** purge the violet literals from
`design-system.css` (or delete the file if `brand.css` now supersedes it) and route everything through
`--primary`. High visual impact, low risk.

### P1-B · Two overlapping design systems is itself the incoherence
Shipping a 4,710-line `design-system.css` _and_ a 1,050-line `brand.css` where the second silently
overrides the first is fragile and is the root cause of P1-A. A premium product has one source of truth.
Either fold the still-needed parts of `design-system.css` into `brand.css` and drop it, or clearly scope
each. Right now "which token wins" depends on import order, which is how the violet survives.

### P2 · Cohesion tells the audit doc itself flags as deferred
- **Mixed icon systems.** `lucide-react` is used across ~15 components; `DESIGN.md` standardizes on
  Phosphor/Radix and explicitly calls mixing icon sets "an inconsistency tell." Pick one.
- **Light-only with dead dark-mode code paths.** `DESIGN.md` says light-only (no toggle shipped), yet
  `App.js` has a `theme`/`toggleTheme` with a Sun/Moon control and writes `data-theme`. Either commit to
  the dark canvas properly or remove the half-shipped toggle — a broken/partial theme toggle is a
  premium tell in the wrong direction.
- **Fonts are stand-ins.** Space Grotesk/Geist stand in for the paid Monument/NN Grotesk. Fine for now,
  but the licensed swap is part of "looks like it costs $15/mo."

### What's already good (keep it)
The _system_ is genuinely distinctive and anti-SaaS — hard edges, printed shadows, one easing curve,
editorial layout, source chips. When it renders as designed, it looks like a product with a point of
view, which is exactly what earns a premium price. The work here is enforcement, not redesign.

---

## Path to 1,000 paying users — priority order

The critical path is: (1) make it a daily driver, (2) build the reason to pay, (3) clear the gates to
scale, (4) make it look as premium as it's priced.

1. **P0-A** server-side scheduled-send/snooze/undo worker — a paid feature is currently broken.
2. **P0-B** unified cross-account search — the single feature that converts demo → subscription.
3. **P1 (security, path-to-scale):** revoke Google tokens on account removal + externalize in-process
   state. Both are prerequisites for passing Google review and running >1 instance for 1,000 users.
4. **P1 (experience):** list virtualization + pagination + Gmail `users.watch` push. This is the gap
   between "fast first paint" and "my main email client."
5. **P1 (design):** purge the banned violet, collapse to one design system. Highest visual-impact,
   lowest-risk item on the list.
6. **P1 (security/privacy-as-feature):** default-block remote images + drop the Clearbit leak — and
   market it. This audience buys privacy.
7. **P2 batch:** login CSRF `state`, UTC calendar formatting, single icon system, resolve the theme
   toggle, licensed fonts, labels/filters.

**One-line thesis:** the plumbing is already premium; the product isn't yet, because the thing you sell
(unified multi-account) isn't fully built (search), the thing users trust (scheduled send) silently
fails, and the thing they see (the surface) still ships the one color your own brand bans. Close those
three and $15/mo × 1,000 is a defensible ask.
