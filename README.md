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

### Option 1: full site (recommended)

`public/` is the complete multi-language static site. Serve it with any static server:

```bash
cd public
python -m http.server 8000   # or npx serve .
# open http://127.0.0.1:8000
```

- Home: `/` (English by default, switchable to 中文) · `/en/` · `/zh/`
- Game app: `/play/` (Practice / Challenge / Mistake review, switch language anytime)

### Option 2: standalone single file

Open [multiplication_game.html](multiplication_game.html) directly (the Phase I deliverable, kept playable on its own).

> Use a modern browser such as Chrome, Edge, or Safari.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript | Zero dependencies, no build tools, no third-party requests |
| Theme | Red-and-white cute style + mascot Tangyuan | Unified palette via CSS variables |
| Fonts | System font stack | No external fonts; math digits use a readable system font |
| Tests | node:test | Unit tests for core logic (question generation / mistake book / records) |

## Project structure

```
tobemathmaster/
├── public/                    # Static site (M0)
│   ├── index.html             # Default English home (x-default, switch to 中文 top-right)
│   ├── en/ · zh/              # English/Chinese public pages (home, FAQ, about, privacy)
│   ├── play/                  # Game app (Practice/Challenge/Mistake review)
│   ├── js/ css/ locales/ img/ # Modules, styles, bilingual locale packs, assets
│   └── robots.txt · sitemap.xml
├── tests/                     # node:test unit tests
├── docs/DESIGN.md             # Design doc (v3.0 merged edition — the single design doc)
├── multiplication_game.html   # Phase I deliverable: standalone playable single-file game
└── README.md · readme.zh.md
```

## Roadmap

Milestones are detailed in [docs/DESIGN.md](docs/DESIGN.md) (v3.0 merged edition: overseas-first, parent accounts, never any ads).

- **M0 ✅ Free overseas trial**: full English UI + Chinese, untimed practice (choose range & count), 10-level challenge, mistake review, first/final answer tracking, per-question active time, accessibility, public pages (home/FAQ/about/privacy), local-only visitor data you can clear, zero ads and zero third-party scripts.
- **M1 ⏳ Parent accounts & cloud data**: email sign-up, child profiles, mistakes & stats in the cloud, idempotent import of visitor data.
- **M1.5 ⏳ Live Race (multiplayer)**: invite-code, same-question speed battle.
- **M2 ⏳ Real payments & Supporter**: hosted checkout, PDF worksheets, custom local celebration images.
- **M3 ⏳ Content & growth**: English tutorials, SEO/GEO, community outreach.

## Contributing

Issues and pull requests are welcome — let's raise Tangyuan together! 🍡
