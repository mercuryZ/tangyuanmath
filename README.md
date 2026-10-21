# Tangyuan's Multiplication Adventure 🍡

> A friendly "two-digit × two-digit" multiplication practice game in a cute red-and-white theme, with Tangyuan the mascot cheering players on.
>
> [中文版](readme.zh.md)

![Mascot Tangyuan](public/img/tangyuan_web.png)

## About

Tangyuan Math is a pure front-end mental-math practice game that turns two-digit (10–99) multiplication into untimed practice, a 10-level timed challenge, and mistake review. With its adorable red-and-white visual style, the mascot Tangyuan (a sweet rice ball) encourages players along the way, making arithmetic practice feel fun instead of stressful.

### Current features (M0 — complete)

- **10-level Challenge**: 10 questions per level; level 1 gives 120 seconds, level 10 only 20.
- **Untimed Practice**: pick a number range (times tables up to two-digit × two-digit) and 5, 10 or 20 questions.
- **Mistake review**: wrong answers collect in a mistake book; replay them until they're gone.
- **First/final answer tracking**: first-attempt accuracy and final completion are recorded separately.
- **Bilingual**: full English interface + 中文.
- **Accessibility**: keyboard (Enter jumps to the next question), focus styles, reduced-motion support.
- **Private by design**: all data stays in your browser, clearable anytime. No ads, no third-party scripts.

## Quick start

### Option 1: full site with server (recommended, M1)

```bash
cd server
npm install
npm start          # default 3000, override with PORT=3100; serves the static site + API from one origin
# open http://127.0.0.1:3000 — email verification/reset links print to the server console
```

- Home: `/` (English by default, switchable to 中文) · `/en/` · `/zh/`
- Game app: `/play/` (Practice / Challenge / Mistake review, switch language anytime)
- Parent center: `/account/` (parent sign-in, family membership, co-parent invites, child accounts, synced stats & data management)

Run the tests with `cd server && npm test` (121 tests: question generation, records, mistake book, family membership/invites, child logins, encrypted backups, Waffo payments/orders/webhooks/$1 trial, and the full HTTP/WebSocket APIs including Google sign-in and the mail channel).

### Email delivery

Two transports, selected by `TM_MAIL_TRANSPORT`:

| Value | Behaviour |
|---|---|
| `console` (default) | Verification/reset links are printed to the server log. Fine for local development; recipients get nothing. |
| `cloudflare` | Sends over the [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) REST API (HTTPS, not SMTP). Requires `TM_CF_ACCOUNT_ID`, `TM_CF_API_TOKEN` (token needs **Email Sending: Edit**), and `TM_MAIL_FROM`. |

To use the Cloudflare transport you must first onboard the sending domain under **Compute → Email Service → Email Sending** in the Cloudflare dashboard, and the sending domain has to be on Cloudflare DNS. Sending to arbitrary recipients requires the Workers Paid plan (3,000 emails/month included, then $0.35 per 1,000).

The project has no dotenv-style loader — `server/src/config.js` reads only `process.env` — so to exercise real delivery locally, start with `node --env-file=../.env.development src/index.js` and set `TM_MAIL_TRANSPORT=cloudflare` plus the two Cloudflare values in that file.

Mail failures never break the request: registration and password reset return their normal response even if the provider is down or misconfigured, and the failure is logged as `[mailer:cloudflare]`.

### Payments (Waffo Pancake)

Supporter memberships are sold through **Waffo Pancake** as a hosted checkout (merchant of record). The server creates the checkout session with the SDK's `checkout.authenticated.create()`; the browser only receives `checkoutUrl`. Entitlements are written **only** by the verified webhook — opening the success URL never grants access.

New registrations receive **no free membership**. The intro offer is the one-time `supporter_trial7` product: **$1 for 7 days**, no auto-renewal, limited to one per family. After it ends, paid features lock unless the family subscribes.

Old databases may still contain the discontinued 3-month launch promo. To revoke those remaining grants (dry run first):

```bash
cd server
npm run revoke-launch-promo
npm run revoke-launch-promo -- --yes
```

| Env var | Meaning |
|---|---|
| `WAFFO_PRIVATE_KEY` | API private key (PEM, literal `\n`, or use `WAFFO_PRIVATE_KEY_BASE64`) |
| `WAFFO_MERCHANT_ID` / `WAFFO_STORE_ID` | Merchant and store IDs (defaults match the current store) |
| `WAFFO_ENVIRONMENT` | `test` (default) or `prod` |
| `WAFFO_PRODUCT_TRIAL7` / `..._MONTHLY` / `..._YEARLY` / `..._LIFETIME` | Product IDs returned by the setup script (the trial is the $1/7-day one-time product) |
| `WAFFO_WEBHOOK_PUBLIC_KEY` | Optional override; the SDK ships Waffo's public keys |

One-time setup:

```bash
cd server
export WAFFO_PRIVATE_KEY="$(cat private.pem)"      # never commit this
npm run waffo:products       # creates missing products, prints the four product IDs
# put WAFFO_PRODUCT_* into the server environment, then restart

# local webhook testing (ngrok preserves x-waffo-signature; localtunnel does not)
ngrok http 3000
npm run waffo:webhook -- https://<ngrok-host>/api/payments/waffo/webhook

npm run waffo:list           # list store products
npm run waffo:publish        # publish test products to production (go-live)
```

Going live:

1. **Publish products** to production (dashboard → Publish, or `npm run waffo:publish` while the test-environment key is configured).
2. In the production environment set `WAFFO_ENVIRONMENT=prod` and `WAFFO_PRIVATE_KEY` / `WAFFO_PRIVATE_KEY_BASE64` to the **production** API key. Test and production keys are different.
3. Copy the four `WAFFO_PRODUCT_*` IDs from `npm run waffo:list` while using the production key (the IDs are usually the same as test, but verify).
4. Register the production webhook with the production key: `WAFFO_ENVIRONMENT=prod node scripts/waffo-setup.js webhook https://tangyuanmath.com/api/payments/waffo/webhook`. The script registers with `testMode: false`; test and production webhooks are separate registrations.
5. Run one controlled real transaction and a refund; check the Waffo webhook delivery log and the `[waffo-webhook]` lines in the server log.
6. If test-mode orders were created against the production database, revoke their `source_type='order'` entitlements before launch.

Prices live in `server/src/waffo.js` (`SKUS`). When you change them, update the matching Waffo product prices in the dashboard and publish a new version; otherwise checkout still charges the old amount and the lifetime amount check can reject the order.

Product tax categories default to `saas` for subscriptions and `digital_goods` for lifetime access; adjust them in the Waffo dashboard if your tax advisor requires different categories.

Test cards (any future expiry/CVC): success `4576 7500 0000 0110`; declined `4576 7500 0000 0220`. Webhook events carry `mode: "test" | "prod"`; the server ignores events from the other environment. `payment_events` deduplicates by `(provider, event_id)`, and each event is matched back to an order through `metadata.orderNo` / `orderMerchantExternalId`, then checked against store, mode, currency and SKU before any entitlement changes.

Subscribe → monthly/yearly renewals extend the existing order's entitlements to `currentPeriodEnd`; `subscription.canceling` keeps access, `subscription.canceled` and `refund.succeeded` revoke only that order's source. Cancelling from the Parent Center calls `orders.cancelSubscription()`.

**Manage subscription & refunds.** Parents also get a button in the Parent Center that opens the Waffo customer portal (`auth.createCustomerPortalLink`). The link is issued per click, expires within minutes, and is never cached or logged. The portal handles cancellation, payment-method changes, invoices and refund requests. Refund tickets are reviewed in the Waffo dashboard; when `refund.succeeded` arrives, only that order's entitlements are revoked.

Troubleshooting:

```bash
cd server
npm run waffo:doctor                     # config check, no secrets printed
node --env-file=../.env.production scripts/waffo-doctor.js --api   # also query Waffo
```

- `503 payments_not_configured` → `WAFFO_PRIVATE_KEY` or one of the `WAFFO_PRODUCT_*` IDs is missing (check the exact variable names).
- Payment succeeds but membership stays inactive → `WAFFO_ENVIRONMENT` must be `prod`; check the Waffo webhook delivery log (401 means the wrong environment's public key) and the `[waffo-webhook]` lines in the server log.
- `waffo:doctor --api` also flags products whose Waffo price differs from `SKUS`.

### Backups

The server makes an **encrypted database backup once a day**, keeps the last **30 days**, and verifies each new backup by decrypting it and running SQLite `integrity_check` + `foreign_key_check`. It uses SQLite's online backup API (not a raw copy of a live file), so a backup is consistent while the app keeps serving requests. Failures are logged as `[backup]` and never stop the server.

| Env var | Default | Meaning |
|---|---|---|
| `TM_BACKUP_DIR` | `<database dir>/backups` | Where encrypted backups are written (on Render: `/data/backups`) |
| `TM_BACKUP_KEY` | auto-generated key file | Passphrase for AES-256-GCM (key derived with scrypt) |
| `TM_BACKUP_RETENTION_DAYS` | `30` | How long each backup is kept |
| `TM_BACKUP_INTERVAL_HOURS` | `24` | Minimum interval between automatic backups |
| `TM_BACKUP_DISABLED` | unset | Set to `1` to turn the scheduler off |

If `TM_BACKUP_KEY` is not set, the first run generates `<backupDir>/backup.key`. That makes backups work out of the box, but the key then sits on the same disk as the data — **copy it somewhere safe**. In production, set `TM_BACKUP_KEY` in the service environment instead.

```bash
cd server
npm run backup                    # back up now
npm run backup:list               # list backups (UTC timestamps, size)
npm run backup:verify             # decrypt + integrity-check the newest backup
node scripts/backup.js verify tangyuan-20261020T031500Z.db.enc
node scripts/backup.js decrypt tangyuan-20261020T031500Z.db.enc /tmp/restore.db
npm run backup:prune              # apply the retention period now
```

Restore:

1. Stop the web service so nothing writes to the database.
2. Keep the current file: `cp app.db app.db.before-restore`.
3. Decrypt the chosen backup (command above).
4. Replace `app.db` with the decrypted file and delete `app.db-wal` / `app.db-shm` next to it.
5. Start the service. Any pending migrations run automatically.

Backups live **on the same persistent disk** by default, so they protect against corruption, a bad migration or an accidental delete — not against losing the disk itself. Copy them off the server for disaster recovery and keep the encryption key separate. A backup can contain records that were deleted later; those records disappear when the backup holding them expires. Re-apply any deletion requests made after the restored backup's timestamp.

### Option 2: static-only (guest mode)

```bash
cd public
python -m http.server 8000   # game + public pages work fully; account features need the server
```

### Option 3: standalone single file

Open [multiplication_game.html](multiplication_game.html) directly (the Phase I deliverable, kept playable on its own).

> Use a modern browser such as Chrome, Edge, or Safari.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript | Zero dependencies, no build tools, no third-party requests |
| Backend | Express + SQLite (better-sqlite3) + `ws` | Versioned migrations; rooms live in memory, only signed-in results are persisted |
| Payments | `@waffo/pancake-ts` (Waffo Pancake) | Hosted checkout + RSA-SHA256 webhook verification; entitlements are written only by the verified webhook |
| Theme | Red-and-white cute style + mascot Tangyuan | Unified palette via CSS variables |
| Fonts | System font stack | No external fonts; math digits use a readable system font |
| Tests | node:test | Unit tests for core logic plus full HTTP and WebSocket integration tests |

## Project structure

```
tobemathmaster/
├── public/                    # Static site (M0)
│   ├── index.html             # Default English home (x-default, switch to 中文 top-right)
│   ├── en/ · zh/              # English/Chinese public pages (home, FAQ, about, privacy)
│   ├── play/                  # Game app (Practice/Challenge/Mistake review/Live Race)
│   ├── js/ css/ locales/ img/ # Modules, styles, bilingual locale packs, assets
│   └── robots.txt · sitemap.xml
├── server/                    # Express + SQLite backend (M1/M1.5)
│   └── src/                   # routes, auth, records, live-race (rooms), race-ws (WebSocket)
├── tests/                     # node:test unit + integration tests
├── docs/DESIGN.md             # Design doc (v3.0 merged edition — the single design doc)
├── multiplication_game.html   # Phase I deliverable: standalone playable single-file game
└── README.md · readme.zh.md
```

## Roadmap

Milestones are detailed in [docs/DESIGN.md](docs/DESIGN.md) (v3.0 merged edition: overseas-first, parent accounts, never any ads).

- **M0 ✅ Free overseas trial**: full English UI + Chinese, untimed practice (choose range & count), 10-level challenge, mistake review, first/final answer tracking, per-question active time, accessibility, public pages (home/FAQ/about/privacy), local-only visitor data you can clear, zero ads and zero third-party scripts.
- **M1 ✅ Parent accounts & cloud data**: Express + SQLite (versioned migrations), email register/verify/login/reset + session revocation (CSRF + rate limits + strict CSP), child profiles with ownership checks, server-authoritative grading with idempotent upload (first/final answers + per-question active time), cloud mistake review, idempotent guest import, timezone-aware streaks, export & account deletion.
- **M1.5 ✅ Live Race (multiplayer)**: invite-code 2–4 player speed races over WebSocket. Server-authoritative grading (clients never receive answers), system-generated display names with no chat or free text, 30-second reconnect window back to the same seat, and results saved only for signed-in child profiles. Live Race is now a family Supporter feature (Practice and Challenge stay free).
- **M1.6 ✅ Family membership & child logins**: one Supporter membership covers up to 2 parents and 2 children. Parents sign in with email/password or Google; children use a parent-created username and password. A second parent joins by email invite. New registrations no longer receive a free membership; paid access starts with the $1 7-day trial or a monthly/yearly/lifetime plan.
- **M2 ⏳ Real payments & Supporter**: hosted checkout (pending), printable PDF worksheets (live — free samples for everyone, supporter-only custom generation with US Letter/A4 and optional answer pages), custom local celebration images.
- **M3 ⏳ Content & growth**: English tutorials, SEO/GEO, community outreach.

## License

Code and content in this repository are released under the [MIT License](LICENSE).

You are free to use, modify, distribute and sell copies of this project, provided the copyright notice and permission notice are retained in all copies or substantial portions. The software is provided "as is", without warranty of any kind.

The Tangyuan Math name and the Tangyuan mascot are the project's brand. The MIT License does not grant trademark rights, so modified redistributions should not present themselves as the official product.

## Contributing

Issues and pull requests are welcome — let's raise Tangyuan together! 🍡
