# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**receipt-printer** turns a thermal receipt printer into a personal output
device, driven by a standalone Google Apps Script (plain JavaScript, V8 runtime).
Anything Apps Script can reach can become a printed receipt; two independent
time-triggered jobs ship today and share one printing library (more are planned):

- `checkAndPrintRobust()` in `Code.js` — scans a Google Calendar and prints each
  new event as a receipt.
- `printAIMorningBriefing()` in `WeatherReport.gs.js` — builds a weather + Gemini
  briefing and prints it.

Both assemble [ESC/POS](https://en.wikipedia.org/wiki/ESC/POS) byte arrays and
POST them to a Raspberry Pi print bridge over an ngrok tunnel (`sendToPi`).

Local `src/` is the source of truth; `clasp` pushes it verbatim. The Apps Script
web editor is a mirror — edit locally, `npm run push`, don't hand-edit online.

## Commands

```bash
npm install        # dev tooling only: clasp + prettier
npm run format     # prettier --write
npm run status     # clasp status — list files that would be pushed
npm run push       # clasp push — upload src/ to the Apps Script project
npm run pull       # clasp pull — fetch remote back down (if the editor was edited)
```

Script ID: `1TQHIiH25ZM-aMjmeSvsy4sWlR0VSWZwO1zLO2y6-EW1QbGo-LCBBaS1d`
(also in `.clasp.json`; open with `npx clasp open-script`).

## Important: no build, no bundler — do NOT introduce one

Unlike the sibling `nudge` project (TypeScript + esbuild → single `dist/main.gs`),
this project is **plain Apps Script pushed as-is**, and it must stay that way:

- Apps Script runs every `.js`/`.gs` file in **one shared global scope**. The two
  files rely on that — `WeatherReport.gs.js` calls `sendToPi` and `CMD` which are
  defined in `Code.js`.
- Both files also define their own `wrapText` and `stringToBytes` at top level;
  they collide in the shared scope (last definition loaded wins). Bundling with
  esbuild would put each file in an isolated module and **silently change this
  behavior**. Don't do it.
- Trigger handlers and editor-run functions (`checkAndPrintRobust`,
  `printAIMorningBriefing`, `testPrinter`) are called by their bare global name,
  so they must remain top-level function declarations.

If you refactor, preserve the shared-global model (or consolidate the duplicate
helpers deliberately, in one place) — don't reach for a module bundler.

## Configuration & secrets

All real secrets live in **Script Properties**, never in the repo: `PI_URL`,
`NGROK_USER`, `NGROK_PASS`, `GEMINI_KEY` (used for both Gemini and the Google
Weather API), `NEWS_KEY`, `LAT`, `LON`. Never hardcode these or log them.
`CALENDAR_ID` and `EMAIL_ALERTS_TO` are hardcoded consts at the top of `Code.js`.
`PRINT_MEMORY` and `LAST_ALERT_TIME` are script-managed state keys.

`.clasp.json` **is committed** here (it holds only the scriptId + push config, no
credentials) so `git clone && npm run push` works. Only `.clasprc.json` (the
actual OAuth credential, in `~/`) is gitignored. gitleaks runs in CI and via an
optional pre-commit hook as a backstop.

## Conventions & gotchas

- **ESC/POS is byte-exact.** The `CMD` table and the `0xC9/0xCD/0xBB` box-drawing
  bytes assume the printer's CP437 code page (`CMD.CP437` is sent on init).
  Preserve byte values verbatim; don't "clean up" the escape sequences.
- **`sendToPi` converts to signed bytes** (`val - 256` for `>= 128`) before
  building the octet-stream blob — that's intentional for the transport, leave it.
- **Fail-loud calendar path.** `checkAndPrintRobust` holds a script lock, throws
  on a failed print, and emails a rate-limited alert (`sendAlertEmail`, 4h
  window). The briefing path logs and returns on missing config.
- **De-dup is stateful.** `PRINT_MEMORY.printedEventIds` (capped at 100) keeps an
  event from reprinting; the key is `eventId + "_" + startTime`.
- **Gemini model** is `gemini-3-pro-preview` over the REST API via `UrlFetchApp`
  (Apps Script has no `fetch`), with `googleSearch` grounding and
  `thinkingLevel: high`. The news fetch (`fetchNewsStream`) is currently commented
  out of the briefing.
- Keep formatting clean: `npm run format` before committing; CI runs
  `prettier --check`.
