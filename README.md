# Trakr

Taiwan stock social-trading platform. Traders link a real broker account through a read-only agent on their own machine; followers see delayed trades, holdings and a verified leaderboard.

```
packages/core   pure TS: hash chain, TWR, win rate, flow inference, delay rules (tested)
apps/server     Fastify + node:sqlite API (Node 22.13+)
apps/web        Vite + React, mobile-first, Safari/iOS-safe
agent/          Python read-only sync agent (Shioaji adapter + mock)
```

## Documents

- [docs/user-guide.md](docs/user-guide.md): 使用說明書 for end users (levels, CSV import, broker sync, privacy, leaderboard rules, troubleshooting).
- [docs/broker-api-research.md](docs/broker-api-research.md): which Taiwan brokers expose read-only account data, with what was verified against official docs and what was not.
- [docs/security.md](docs/security.md): what read-only enforcement and security controls exist, what is missing before launch, and what to ask a lawyer. It is not a compliance certificate.

## Run locally

```bash
npm install
npm test                 # core + server tests
npm run seed             # SYNTHETIC demo traders (fresh DB only)
npm run dev:server       # http://127.0.0.1:3000
npm run dev:web          # http://localhost:5173 (proxies /api)
```

Try the agent without a broker: `TOT_TOKEN=<token> python -m tot_agent --broker mock --once` (from `agent/`).

Demo logins after `npm run seed`: `demo_alpha@example.test` (also `demo_beta`, `demo_gamma`) / `demo-password-1`. The dev DB is `apps/server/data/tot.db`; delete it if the schema changes.

## Market data (TWSE)

The home screen's 市場 and 自選 tabs use the TWSE **OpenAPI** (`openapi.twse.com.tw/v1`), the channel TWSE provides for automated access. Datasets: `STOCK_DAY_ALL` (every listed stock), `MI_INDEX20` (top 20 by volume), `MI_INDEX` (index levels), `FMTQIK` (market totals).

- **Two rankings.** The home screen offers 成交額 (by trade value) and 成交量 (by shares). TWSE publishes an official ranking only for volume (`MI_INDEX20`), so the value ranking is `STOCK_DAY_ALL` sorted by `TradeValue`. That approach was checked first: sorting the same dataset by volume reproduces TWSE's official top 20 exactly (20 of 20, same order).
- **Stock names** on trades, holdings and the following feed come from the same cached dataset via `market.names()`. It never throws: if TWSE is down the names are `null` and the UI shows the code, so trade lists never fail because of a market-data outage.
- **End-of-day only.** The latest row is the last trading day; nothing here is real-time and the UI says so.
- **Licence.** The data is released under the Government Open Data License (commercial use allowed). The licence is void without an attribution notice naming agency, year, dataset and version, the licence statement and a link, so `Attribution` renders it on every screen that shows this data. Do not remove it.
- **Do not scrape twse.com.tw.** Its terms forbid automated downloading and redistribution without consent. Only the OpenAPI is called, once per dataset per 10 minutes regardless of user count (single-flight cache), serving the last good copy if TWSE is down.
- Listed (上市) stocks and ETFs only; OTC (上櫃) and emerging (興櫃) are not in these datasets.
- Watchlists are private, capped at 50 stocks.

## Profile photos

Tap 上傳照片 on 我. The browser centre-crops to a square, shrinks to 256px and re-encodes as JPEG (which drops EXIF and GPS) before upload. The server accepts only JPEG or PNG judged by file signature, rejects declared sizes outside 32-1024px and files over 200 KB, rate-limits uploads, and serves with `nosniff`, a sandboxing CSP and URL-versioned permanent caching. There is no photo moderation yet; see docs/security.md.

## UI rules that matter

- **Never call `window.confirm`, `alert` or `prompt`.** In-app browsers and webviews (the kind people open links from inside chat and social apps) suppress them and answer "cancel" instantly, so a confirm-guarded button silently does nothing; this is how delete and remove-photo once looked fake. Use `confirmAction()` for confirmations and `showToast()` for messages (both in `ui.tsx`, rendered by `<DialogHost />`). Keyboard focus starts on Cancel so a reflexive Enter cannot confirm a destructive action; Escape and a backdrop tap cancel.
- **Mutating actions must show failure.** Wrap them in `attempt()` (or your own try/catch) so a rejected request becomes a visible message instead of nothing.
- `apps/web/src/no-native-popups.test.ts` enforces both rules and fails the build if either is broken.
- If a button seems dead in development, restart the Vite dev server: after several quick edits to one file it can keep serving a half-updated copy of the module (this once caused `attempt is not defined` at click time even though the source and production build were correct).

## Bio and social links

On 我, tapping the avatar opens the photo picker (there is no separate button), and 個人簡介與社群連結 holds a 160-character plain-text bio plus up to six accounts on Threads, Instagram, X, Facebook, YouTube, TikTok, Telegram and LINE.

Users never submit a URL. They give an account name (or paste a profile URL, which is reduced to the name), and the server builds the address from a fixed template on the platform's own domain (`packages/core/src/social.ts`). Look-alike domains, `instagram.com@evil.com`, non-https schemes, group invites (LINE `/ti/g/`, Telegram `t.me/+…`) and non-profile paths are all rejected, and links open with `rel="noopener noreferrer nofollow ugc"`. The bio is rendered as text and never auto-linked. Three distinct 檢舉簡介 reports hide a person's bio and links from others while the owner still sees and can fix them. This matters on an investment platform because "join my LINE group" is the classic scam; see docs/security.md for what is still unmoderated.

## Typography and themes

- **Fonts:** the system stack only (SF Pro and PingFang TC on Apple devices, Segoe UI and Microsoft JhengHei on Windows, Roboto and Noto Sans TC elsewhere). No web font means no download, no layout shift, and no third-party request that would send users' IPs to a font CDN. Digits use tabular lining figures so columns align.
- **Scale (rem):** 12 tags only, 14 secondary text, 16 body, 18 lead, 20 titles, 24 key numbers. Weights 400 / 600 / 700; Chinese fonts have no true 800. Reading text uses line-height 1.7, slight tracking, strict CJK line breaking and `text-autospace`.
- **User control:** 我 > 外觀與文字大小 offers four text sizes (×0.9 to ×1.25) and system / dark / light themes, saved in `localStorage`. On iPhone the base size also follows iOS Dynamic Type (`font: -apple-system-body`, clamped to 14-28px). Inputs stay at least 16px so Safari never zooms on focus.
- **Colour (softened on purpose).** Neither theme uses pure black or pure white, both of which glare in long reading. **Dark** is a warm charcoal `#1d1b1e` with warm off-white text `#dedad6`. **Light** is a very pale warm white close to ivory with a faint pink-grey cast, `#f8f4f1`, with warm near-black text `#26211f`. Every colour is a token at the top of `apps/web/src/styles.css`, so changing the warmth is a one-line edit per token.
- **Contrast (WCAG, computed for every pairing, text on the page, on a pressed row and in code blocks).** Dark: body 12.3:1, secondary 6.8:1, link 7.5:1, red 7.0:1, green 8.8:1. Light: body 14.5:1, secondary 5.5:1, link 5.8:1, red 5.4:1, green 5.3:1. All pass AA (4.5:1) for normal-size text; control outlines are at least 3:1 (WCAG non-text contrast). Avatar initials are white on shades of at least 4.8:1. Measured in a real browser, both themes, signed in and out, including the confirmation dialog and toast: every text element passes, lowest 4.82:1 (an avatar initial).
- The browser chrome colour (`theme-color`), the web manifest and `typography.ts` carry the same two backgrounds; change them together with the tokens.

## Holdings snapshots (期初庫存)

Trades alone cannot give a position, because the opening holdings are unknown. Users upload a holdings snapshot for one day (`POST /api/me/holdings-import`, `asOf` as `YYYY-MM-DD` meaning the close, `csv` with symbol and shares or lots). The derived position is the snapshot plus every trade after it, up to the trader's display delay.

- **Level 1.** Snapshots are user-submitted, so they are labelled as such and never enter the broker-verified leaderboard or the hash chain. Trades in CSV form and snapshots stay outside `tradesOf`.
- **Reconciliation.** Each new snapshot is compared with the previous snapshot plus the trades in between; differences are stored with the snapshot and listed to the user.
- **Precedence.** A broker-verified snapshot newer than the uploaded one replaces it.
- **Logic** lives in `packages/core/src/holdings.ts` (`parseHoldingsCsv`, `applyTrades`, `compareLines`). An empty snapshot means nothing held that day. A position that would go negative is flagged, not clipped.
- Deleting a snapshot does not re-run reconciliation for the snapshot after it; that is a known limitation.

## Verification levels

| Level | Source | Shown | Ranked |
|---|---|---|---|
| 2 · Broker Verified | Broker API through the sync agent (hash-chained, price/quantity/time as the broker reports them) | trades, holdings, performance, blue check | yes, if it meets the leaderboard rules |
| 1 · User Submitted | CSV the user uploads (no proof of origin) | trades only, each tagged 自行回報 | never |

CSV rows live in the same table with `source = 'csv'` but are outside the hash chain and are excluded from every statistic, the reconciliation and the leaderboard, even for a Level 2 user. Imports are idempotent (row ids are content hashes), limited to 2000 rows and 10 imports per hour, and the user can delete them all. The parser accepts English or common Taiwan broker column names, lots or shares, ROC or Gregorian dates (Taipei time), comma or tab separators.

## App navigation

Visual style follows X and Threads, in softer colours (a warm charcoal dark theme and an ivory light theme, see below): flat rows separated by hairlines, avatars, underline tab switchers, a sticky blurred top bar, and a full-width icon-only tab bar (outline when idle, solid when selected) with four tabs: **首頁** (達人榜單 / 追蹤中), **社群** (forum), **排行榜** (ranking by return or win rate), **我** (account, levels, CSV import, sync keys, privacy). The bar clears the home indicator via `env(safe-area-inset-bottom)`.

## Forum (社群)

Anyone can read; signing in is required to post or comment (plain text, up to 500 characters, rendered as text so markup is never interpreted). Rate limits: 10 posts and 30 comments per user per 10 minutes. Authors can delete their own items. Any signed-in user can report an item, and three distinct reports hide it automatically until a human reviews it. There is no admin tool yet, so reviewing means editing the `reports` table by hand.

App Store note: apps with user-generated content must offer reporting, a way to block abusive users, and timely moderation (Guideline 1.2). Reporting exists; blocking and a moderator view do not.

## Account IDs

Every account has a public, unique **ID** (`@id`, 3-20 ASCII letters, digits or underscores). Rules live in `packages/core/src/handle.ts`.

- **Unique without regard to case.** `Alice`, `alice` and `ALICE` are one ID; the owner's spelling is kept for display, identity is `handle_lc` (lower case) behind a unique index. All lookups go through that key.
- **ASCII only**, which also rules out look-alike letters from other alphabets (a Cyrillic `а` for `a`).
- **Reserved:** platform and staff words, broker and exchange names, page names, and anything starting `admin` or `trakr`. Existing accounts are not affected.
- **Race-safe:** the database decides between simultaneous sign-ups; the loser gets `409 handle_taken`, not a 500.
- **Immutable** after sign-up (no endpoint changes it), and it is never reused because accounts cannot be deleted yet.
- The sign-up form checks availability live via `GET /api/auth/handle-available` (60 per minute per IP).
- Upgrading an older database backfills the key and adds the unique index; if two accounts differ only by case it refuses to start and names them.

## Authentication

- **Web:** email + password (scrypt). A random session id lives in an `HttpOnly; SameSite=Lax` cookie (`Secure` when `NODE_ENV=production`); only its hash is stored. Sessions last 30 days, and changing the password signs out every other session.
- **Sync agent:** separate, revocable keys (`tot_ak_…`, max 5 per user, shown once, stored hashed). A key can call `/api/ingest` and nothing else; a login cookie cannot ingest. Revoking a key stops the agent immediately. The agent reads it from `TOT_AGENT_KEY`.
- **Abuse limits:** 5 failed logins per IP+email and 40 per IP per 15 minutes (429), 10 sign-ups per IP per hour. Login gives one generic error and does equal work for unknown emails.
- **CSRF:** SameSite cookies plus rejection of any write whose `Origin` host differs from the request host.
- **Behind a reverse proxy** set `TOT_TRUST_PROXY=1` and forward `Host`/`X-Forwarded-For`/`X-Forwarded-Host`; otherwise rate limits see the proxy's IP. Limiters are in memory, so use a shared store if you run several instances.
- Passwords on iOS: the forms use real `<form>` markup and `autocomplete` hints so iCloud Keychain can save and fill them.

## How credibility is enforced

- Data comes only from the broker API via the agent; there is no endpoint to add or edit a trade by hand.
- Trades are append-only and SHA-256 hash-chained; `/api/traders/:handle/integrity` re-verifies the chain.
- One broker account per user and one user per account (hashed fingerprint). Tracking starts at link time; earlier trades are rejected.
- Equity and deposit/withdrawal flow are computed server-side. Returns are time-weighted, so deposits do not inflate them.
- Holdings reported by the broker are reconciled against the trade history; a mismatch removes the trader from the leaderboard.
- Silence during a trading session is recorded as a gap and keeps the trader off the leaderboard for 14 days.

Known limit: the agent runs on the trader's machine, so a determined user could tamper with it or run a second, unlinked account. Closing that needs a broker-side partnership.

## Anti-sniping

Trades are public only after the trader's delay (minimum 3 minutes, enforced server-side). Holdings can be public, weights-only, or hidden, and holdings snapshots are delayed the same way.

## iPhone / Safari notes

Built for Safari 14+: `viewport-fit=cover` with safe-area padding, `dvh` with `vh` fallback, 16px inputs (no focus zoom), 44px touch targets, `-webkit-backdrop-filter`, phone-number auto-linking disabled, `localStorage` guarded for private mode, polling plus refresh on `visibilitychange` instead of long-lived sockets, and an "Add to Home Screen" manifest. The web app is for viewing and following; syncing needs a desktop or server because the broker SDK does not run on iOS.

## Not done yet

- Password reset and email verification (needs a mailer), 2FA/passkeys, and Sign in with Apple. Apple requires Sign in with Apple in an App Store app that offers other third-party logins; plain email+password does not trigger that.
- No account deletion or data export endpoint yet (needed for Taiwan PDPA requests).
- Shioaji adapter is untested against a live or simulated account.
- Rate limiting, HTTPS/deploy config, Apple touch icons, App Store packaging.
- Taiwan market holidays are not modelled in gap detection.
