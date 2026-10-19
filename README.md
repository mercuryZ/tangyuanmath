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
- Parent center: `/account/` (sign in, child profile, synced stats & data management)

Run the tests with `cd server && npm test` (45 tests: question generation, records, mistake book, and the full HTTP API including Google sign-in and the mail channel).

### Email delivery

Two transports, selected by `TM_MAIL_TRANSPORT`:

| Value | Behaviour |
|---|---|
| `console` (default) | Verification/reset links are printed to the server log. Fine for local development; recipients get nothing. |
| `cloudflare` | Sends over the [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) REST API (HTTPS, not SMTP). Requires `TM_CF_ACCOUNT_ID`, `TM_CF_API_TOKEN` (token needs **Email Sending: Edit**), and `TM_MAIL_FROM`. |

To use the Cloudflare transport you must first onboard the sending domain under **Compute → Email Service → Email Sending** in the Cloudflare dashboard, and the sending domain has to be on Cloudflare DNS. Sending to arbitrary recipients requires the Workers Paid plan (3,000 emails/month included, then $0.35 per 1,000).

The project has no dotenv-style loader — `server/src/config.js` reads only `process.env` — so to exercise real delivery locally, start with `node --env-file=../.env.development src/index.js` and set `TM_MAIL_TRANSPORT=cloudflare` plus the two Cloudflare values in that file.

Mail failures never break the request: registration and password reset return their normal response even if the provider is down or misconfigured, and the failure is logged as `[mailer:cloudflare]`.

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
- **M1.5 ✅ Live Race (multiplayer)**: invite-code 2–4 player speed races over WebSocket. Server-authoritative grading (clients never receive answers), system-generated display names with no chat or free text, guests play without an account and leave no trace, 30-second reconnect window back to the same seat, and results saved only for signed-in child profiles. Not yet load-tested.
- **M2 ⏳ Real payments & Supporter**: hosted checkout, PDF worksheets, custom local celebration images.
- **M3 ⏳ Content & growth**: English tutorials, SEO/GEO, community outreach.

## Contributing

Issues and pull requests are welcome — let's raise Tangyuan together! 🍡
