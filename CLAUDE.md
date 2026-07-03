# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**receipt-printer** turns a thermal receipt printer into a personal output
device, driven by a standalone Google Apps Script (TypeScript, V8 runtime).
Anything Apps Script can reach can become a printed receipt. One job is active;
two older ones are dormant (code kept, triggers removed):

- `printDailyArt()` in `src/art.ts` — **active.** Asks Claude Fable 5
  (Anthropic API) to design an original piece of CP437 character art themed to
  the day (weather, season, zeitgeist via web search), renders the returned
  JSON art spec to ESC/POS, and prints it.
- `checkAndPrintRobust()` in `src/calendar.ts` — **dormant.** Scans a Google
  Calendar and prints each new event as a receipt. Still owns the shared
  `sendToPi` transport and `sendAlertEmail`.
- `printAIMorningBriefing()` in `src/briefing.ts` — **dormant.** Weather +
  Gemini briefing. Still owns `getDeepWeather`, which the art job reuses.

Both assemble [ESC/POS](https://en.wikipedia.org/wiki/ESC/POS) byte arrays and
POST them to a Raspberry Pi print bridge over an ngrok tunnel (`sendToPi`). That
receiving end — a Pi Zero W running a Python `http.server` that pipes raw bytes
to `/dev/usb/lp0`, behind an ngrok static domain + basic auth, managed by systemd
— is documented in [`docs/pi-print-server-runbook.md`](docs/pi-print-server-runbook.md).

TypeScript under `src/` is the source of truth. esbuild bundles it to a single
`dist/main.gs`; `clasp` pushes that. The Apps Script web editor is never edited
directly — edit locally, `npm run push`.

## Commands

```bash
npm install        # dev tooling: clasp, typescript, esbuild, prettier
npm run build      # tsc --noEmit + esbuild bundle -> dist/main.gs (+ appsscript.json)
npm run typecheck  # tsc --noEmit
npm run format     # prettier --write
npm run test:print # local print/iteration harness (see below + README)
npm run status     # clasp status — list files that would be pushed (from dist/)
npm run push       # npm run build && clasp push — build then upload dist/
npm run pull       # clasp pull — fetch remote back down (if the editor was touched)
```

Script ID: `1TQHIiH25ZM-aMjmeSvsy4sWlR0VSWZwO1zLO2y6-EW1QbGo-LCBBaS1d`
(also in `.clasp.json`; open with `npx clasp open-script`).

## Architecture (TypeScript + esbuild, like `nudge`)

Apps Script has no module system and calls trigger/editor functions by their bare
global name. esbuild bundles the whole `src/` import graph into one IIFE
(`dist/main.gs`), and a footer in `build.js` re-exposes the entry points as
top-level globals so the runtime and editor can find them.

```
src/escpos.ts     CMD command table, COLS_A/COLS_B, stringToBytes, encodeCP437
src/art.ts        printDailyArt, testDailyArt, art-spec schema + renderer,
                  Anthropic (Fable 5) client — pure functions exported for the harness
src/calendar.ts   checkAndPrintRobust (dormant), generateReceiptPayload, sendToPi,
                  sendAlertEmail, callWithRetry, testPrinter
src/briefing.ts   printAIMorningBriefing (dormant), buildDeepReceipt, getDeepWeather
src/main.ts       re-exports the entry points (+ builders, for the harness)
build.js          esbuild bundle -> dist/main.gs; ENTRY_POINTS -> global footer
```

- **Entry points** = `printDailyArt`, `testDailyArt`, `checkAndPrintRobust`,
  `printAIMorningBriefing`, `testPrinter`. They must be exported from
  `src/main.ts` **and** listed in `ENTRY_POINTS` in `build.js` (the footer wraps
  each as a bare global). Existing time triggers reference these names, so don't
  rename them.
- **The old shared-global collision is resolved.** These were two plain `.gs`
  files in one global scope; both defined `wrapText`/`stringToBytes`, and the
  last-loaded won. In the module version each file keeps its own `wrapText`
  (calendar's breaks long words; briefing's doesn't) and `stringToBytes` is shared
  from `escpos.ts` (both old copies were byte-identical). The conversion was
  verified **byte-for-byte** against the old output for the sample calendar and
  briefing receipts — behavior is preserved for realistic input. The only place
  they could diverge is a single word longer than the wrap width.
- **`treeShaking: false`** in `build.js` keeps every function in `src/` in the
  bundle, including the currently-dormant `fetchNewsStream`.
- The deployed project is now the single bundled `main.gs` (it replaced the old
  `Code`/`WeatherReport.gs` files on push).

## Configuration & secrets

All real config/secrets live in **Script Properties**, never in the repo:
`PI_URL`, `NGROK_USER`, `NGROK_PASS`, `ANTHROPIC_KEY` (daily art — Fable 5),
`GEMINI_KEY` (used for the Google Weather API and Gemini), `NEWS_KEY`, `LAT`,
`LON`, `CALENDAR_ID` (which calendar to print), and `EMAIL_ALERTS_TO` (where
failure alerts go). Never hardcode these or log them. `LAST_ART_DATE`,
`PRINT_MEMORY`, and `LAST_ALERT_TIME` are script-managed state keys.

`.clasp.json` **is committed** here (it holds only the scriptId + push config, no
credentials) so `git clone && npm run push` works. `.clasprc.json` (the OAuth
credential, in `~/`), `dist/`, and `.env` (local test creds) are gitignored.
gitleaks runs in CI and via an optional pre-commit hook as a backstop.

## Local iteration

`test-print.mjs` (run via `npm run test:print -- <mode>` or `node test-print.mjs
<mode>`) POSTs ESC/POS straight to the Pi — the same endpoint Apps Script uses —
so you can iterate without deploying. `art`/`art:live`/`calendar`/`briefing` load
the real builders from the built `dist/main.gs`, so **run `npm run build` first**;
the preview then matches production exactly. `art` renders the golden spec with
no API call; `art:live` runs the full Fable pipeline (needs `ANTHROPIC_KEY` in
`.env`); `ruler` prints the column/gapless calibration page. Credentials come
from a gitignored `.env` (copy `.env.example`). Add `--dry` to preview the hex
payload without printing.

## Conventions & gotchas

- **ESC/POS is byte-exact.** The target printer is an **Epson TM-T20III** (80mm,
  auto-cutter); its command reference is bundled at
  `docs/epson-tm-t20iii-technical-reference-guide.pdf`. The `CMD` table
  (`src/escpos.ts`) and the `0xC9/0xCD/0xBB` box-drawing bytes assume the printer's
  CP437 code page (`CMD.CP437` is sent on init). Preserve byte values verbatim.
  `build.js` uses `charset: 'utf8'` so the `°` byte survives bundling.
- **`sendToPi` converts to signed bytes** (`val - 256` for `>= 128`) before
  building the octet-stream blob — that's intentional for the transport, leave it.
- **Fail-loud calendar path.** `checkAndPrintRobust` holds a script lock, throws
  on a failed print, and emails a rate-limited alert (`sendAlertEmail`, 4h
  window). The briefing path logs and returns on missing config.
- **De-dup is stateful.** `PRINT_MEMORY.printedEventIds` (capped at 100) keeps an
  event from reprinting; the key is `eventId + "_" + startTime`.
- **Daily art model** is `claude-fable-5` over the Anthropic Messages API via
  `UrlFetchApp` (raw REST, no SDK). Fable-specific rules: never send a
  `thinking` param or `temperature`/`top_p`/`top_k` (400); depth is controlled
  with `output_config.effort`; the art spec comes back via
  `output_config.format` (json_schema); web search is a server tool
  (`web_search_20260209`, basic `20250305` fallback) and can return
  `stop_reason: "pause_turn"` — the client loop echoes the assistant content
  back to resume. A refusal fallback to `claude-opus-4-8` is enabled via the
  `server-side-fallback-2026-06-01` beta header.
- **`encodeCP437` for all new printed text.** It maps Unicode block/box/symbol
  characters to CP437 bytes and prints `?` for anything unmapped.
  `stringToBytes` is frozen for the dormant calendar/briefing payloads — don't
  switch them over.
- **`COLS_A`/`COLS_B` in `src/escpos.ts` are the single column constants** (42/56
  for this printer's 42-column mode). The Fable prompt interpolates them, so the
  model and renderer always agree. Recalibrate with `node test-print.mjs ruler`
  if the printer is reconfigured — the same page verifies the gapless
  line-spacing value (`ROW_DOTS_A = 24`).
- **Gemini model** (dormant briefing) is `gemini-3-pro-preview` over the REST API
  via `UrlFetchApp`, with `googleSearch` grounding and `thinkingLevel: high`. The
  news fetch (`fetchNewsStream`) is currently commented out of the briefing.
- Keep it green: `npm run build` (tsc + bundle) and `npm run format` before
  committing. CI runs `prettier --check`.
