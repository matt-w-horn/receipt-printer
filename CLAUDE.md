# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**morningprint** turns a thermal receipt printer into a personal output
device, driven by a standalone Google Apps Script (TypeScript, V8 runtime).
One job: `printDailyArt()` in `src/art.ts` asks Claude Fable 5 (Anthropic API)
to design an original piece of CP437 character art themed to the day (weather,
season, zeitgeist via web search), renders the returned JSON art spec to
ESC/POS, and prints it. (Two earlier jobs, calendar-event receipts and an AI
morning briefing, were deleted in July 2026; they live in git history.)

The script assembles [ESC/POS](https://en.wikipedia.org/wiki/ESC/POS) byte
arrays and POSTs them to a Raspberry Pi print bridge over an ngrok tunnel
(`sendToPi` in `src/transport.ts`). That receiving end (a Pi Zero W running a
Python `http.server` that pipes raw bytes to `/dev/usb/lp0`, behind an ngrok
static domain + basic auth, managed by systemd) is documented in
[`docs/pi-print-server-runbook.md`](docs/pi-print-server-runbook.md). The byte
protocol itself (every command, CP437 mapping, geometry, calibration results)
is specced in [`docs/escpos-protocol.md`](docs/escpos-protocol.md).

TypeScript under `src/` is the source of truth. esbuild bundles it to a single
`dist/main.gs`; `clasp` pushes that. The Apps Script web editor is never edited
directly: edit locally, `npm run push`.

## Commands

```bash
npm install        # dev tooling: clasp, typescript, esbuild, prettier
npm run build      # tsc --noEmit + esbuild bundle -> dist/main.gs (+ appsscript.json)
npm run typecheck  # tsc --noEmit
npm run format     # prettier --write
npm run test:print # local print/iteration harness (see below + README)
npm run status     # clasp status: list files that would be pushed (from dist/)
npm run push       # npm run build && clasp push: build then upload dist/
npm run pull       # clasp pull: fetch remote back down (if the editor was touched)
```

Script ID: `1TQHIiH25ZM-aMjmeSvsy4sWlR0VSWZwO1zLO2y6-EW1QbGo-LCBBaS1d`
(also in `.clasp.json`; open with `npx clasp open-script`).

## Deployment

Push-first, always: the `apps-script-deploy` skill has the full ritual. The
short version: ask the user to close any open Apps Script editor tabs (a stale
editor session has silently saved old code over a fresh push, twice), then
`npm run push`, then verify in a **fresh** tab via `npx clasp open-script`,
never in a tab that was already open. If the remote looks stale, re-push once;
if it reverts again, hunt down the open editor session instead of pushing a
third time.

## Architecture (TypeScript + esbuild, like `nudge`)

Apps Script has no module system and calls trigger/editor functions by their bare
global name. esbuild bundles the whole `src/` import graph into one IIFE
(`dist/main.gs`), and a footer in `build.js` re-exposes the entry points as
top-level globals so the runtime and editor can find them.

```
src/escpos.ts     CMD command table, COLS_A/COLS_B, ROW_DOTS_A/B, encodeCP437
src/art.ts        printDailyArt, testDailyArt, art-spec schema + renderer,
                  Anthropic (Fable 5) client; pure functions exported for the harness
src/transport.ts  sendToPi (HTTP → Pi bridge), callWithRetry, sendAlertEmail
src/weather.ts    getDeepWeather (Google Weather API); context for the art prompt
src/main.ts       re-exports the entry points (+ pure builders, for the harness)
build.js          esbuild bundle -> dist/main.gs; ENTRY_POINTS -> global footer
```

- **Entry points** = `printDailyArt`, `testDailyArt`. They must be exported from
  `src/main.ts` **and** listed in `ENTRY_POINTS` in `build.js` (the footer wraps
  each as a bare global). The existing time trigger references `printDailyArt`
  by name, so don't rename it.
- **`treeShaking: false`** in `build.js` keeps every function in `src/` in the
  bundle; nothing is silently dropped.
- The deployed project is the single bundled `main.gs` plus `appsscript.json`.

## Configuration & secrets

All real config/secrets live in **Script Properties**, never in the repo:
`PI_URL`, `NGROK_USER`, `NGROK_PASS`, `ANTHROPIC_KEY` (daily art, Fable 5),
`EMAIL_ALERTS_TO` (where failure alerts go), and optionally `GEMINI_KEY` (a
Google API key used for the Google Weather API), `LAT`, `LON` (weather is
garnish; the art degrades gracefully without it). Never hardcode these or log
them. `LAST_ART_DATE`, `ART_HISTORY`, and `LAST_ALERT_TIME` are script-managed
state keys. `ART_HISTORY` entries carry a `c` field when a piece continued an
earlier one: the model judges continuity per the prompt's rules, reports the
link in the spec's `continues` field, and sees the resulting markers in future
contexts; that visibility is the rarity mechanism, so don't add code-side
dice or cooldowns. (Leftover properties from the deleted calendar/
briefing jobs, `CALENDAR_ID`, `NEWS_KEY`, and `PRINT_MEMORY`, are unused and can
be removed in the editor.)

`.clasp.json` **is committed** here (it holds only the scriptId + push config, no
credentials) so `git clone && npm run push` works. `.clasprc.json` (the OAuth
credential, in `~/`), `dist/`, and `.env` (local test creds) are gitignored.
gitleaks runs in CI and via an optional pre-commit hook as a backstop.

## Local iteration

`test-print.mjs` (run via `npm run test:print -- <mode>` or `node test-print.mjs
<mode>`) POSTs ESC/POS straight to the Pi (the same endpoint Apps Script uses)
so you can iterate without deploying. `art`/`art:live` load the real builders
from the built `dist/main.gs`, so **run `npm run build` first**; the preview
then matches production exactly. `art` renders the golden spec with no API
call; `art:live` runs the full Fable pipeline (needs `ANTHROPIC_KEY` in
`.env`); `ruler` prints the column/gapless calibration page. Credentials come
from a gitignored `.env` (copy `.env.example`). Add `--dry` to preview the hex
payload without printing.

## Conventions & gotchas

- **ESC/POS is byte-exact.** The target printer is an **Epson TM-T20III** (80mm,
  auto-cutter); every command the project sends is specced in
  [`docs/escpos-protocol.md`](docs/escpos-protocol.md). The `CMD` table
  (`src/escpos.ts`) assumes the printer's CP437 code page (`CMD.CP437` is sent
  on init). Preserve byte values verbatim. `build.js` uses `charset: 'utf8'` so
  multi-byte literals (e.g. `°`) survive bundling.
- **`sendToPi` converts to signed bytes** (`val - 256` for `>= 128`) before
  building the octet-stream blob; that's intentional for the transport
  (`Utilities.newBlob` takes signed 8-bit ints), leave it.
- **Fail-loud art path.** `printDailyArt` holds a script lock, throws on a
  failed print, and emails a rate-limited alert (`sendAlertEmail`, 4h window).
  The `LAST_ART_DATE` guard is only set on success, so an hourly trigger
  doubles as a retry mechanism.
- **Daily art model** is `claude-fable-5` over the Anthropic Messages API via
  `UrlFetchApp` (raw REST, no SDK). Fable-specific rules: never send a
  `thinking` param or `temperature`/`top_p`/`top_k` (400); depth is controlled
  with `output_config.effort`; the art spec comes back via
  `output_config.format` (json_schema); web search is a server tool
  (`web_search_20260209`, basic `20250305` fallback) and can return
  `stop_reason: "pause_turn"`; the client loop echoes the assistant content
  back to resume. A refusal fallback to `claude-opus-4-8` is enabled via the
  `server-side-fallback-2026-06-01` beta header.
- **`encodeCP437` for all printed text.** It maps Unicode block/box/symbol
  characters to CP437 bytes, drops control characters (they'd be interpreted
  as printer commands), and prints `?` for anything unmapped.
- **`COLS_A`/`COLS_B` in `src/escpos.ts` are the single column constants** (48/64
  for this printer's standard 48-column mode). The Fable prompt interpolates
  them, so the model and renderer always agree. Recalibrate with
  `node test-print.mjs ruler` if the printer is reconfigured; the same page
  verifies the gapless line-spacing values (`ROW_DOTS_A = 24`, `ROW_DOTS_B = 17`).
- **Confirm art-direction changes before building them.** For any rework of the
  art pipeline's visual output (prompt, spec schema, renderer), agree on the
  intended style/layout with the user first; a past redesign was built
  pixel-grid-first when vector-style art was wanted, and had to be redone.
- Keep it green: `npm run build` (tsc + bundle) and `npm run format` before
  committing. CI runs `prettier --check`.

## Positioning & copy (canonical: reuse, don't reinvent)

When writing or editing anything user-facing (README, issues, posts,
descriptions), use these approved lines verbatim or stay in their register.
The contrast with feeds is drawn through concrete objects (refresh, scroll,
cutter, corkboard), never editorializing about social media.

- **Tagline:** One original print, every morning.
- **One-liner (HN-style):** Morningprint – my receipt printer prints one
  original artwork each morning
- **Two sentences:** A thermal receipt printer in the kitchen wakes before you
  do and prints a one-of-a-kind piece of character art, themed to the date,
  the weather, and the mood of the news, with a short verse underneath. The
  day's whole feed is a strip of paper you pin to a corkboard.
- **Paragraph:** Every morning a thermal receipt printer in my kitchen prints
  something that has never existed before: a small piece of character art,
  designed seconds earlier by Claude and themed to the day: the weather
  outside, the season, a holiday, an eclipse, an election. A short verse sits
  beneath it. It reads the same restless inputs the feeds do, then hands you
  one finished, physical thing and stops. There is nothing to refresh; the
  archive is a stack of receipts on a corkboard, and once in a while a piece
  answers the one printed the day before. Under the hood: a Google Apps
  Script, structured output from Claude, a hand-rolled ESC/POS renderer
  drawing with the 1981 CP437 character set, and a Raspberry Pi Zero W feeding
  an Epson receipt printer.
