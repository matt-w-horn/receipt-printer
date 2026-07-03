# receipt-printer

Turn a thermal receipt printer into a personal output device — driven by Google
Apps Script. The script assembles [ESC/POS](https://en.wikipedia.org/wiki/ESC/POS)
byte payloads and POSTs them to a printer bridge on a Raspberry Pi (reached over
an ngrok tunnel with HTTP basic auth), so anything Apps Script can reach — Google
services, any REST API, an LLM — can become a printed receipt.

The active job — one time-based trigger per day:

- **Daily art → receipt** (`src/art.ts`) — `printDailyArt()` asks Claude Fable 5
  (Anthropic API) to design an original piece of CP437 character art themed to
  the day: local weather, season, date, and the zeitgeist (the model can run a
  few web searches). The returned art spec (JSON) is rendered to ESC/POS — block
  shading ░▒▓█, half-blocks, box drawing, glyph scaling up to 8x, invert,
  gapless line spacing — and printed spare: a small date stamp, the artwork,
  and a short verse. Nothing else. A rolling archive of recent pieces is fed
  back into each prompt so the work varies day to day; the unprinted title,
  reference caption, and style note land in the execution log and the archive.

Two earlier jobs remain in the repo, **dormant** (code kept, triggers removed):

- **Calendar → receipt** (`src/calendar.ts`) — `checkAndPrintRobust()` scans a
  Google Calendar for events in a rolling window and prints each new one as a
  receipt (bordered header, big title, checkbox-aware description).
- **AI morning briefing → receipt** (`src/briefing.ts`) —
  `printAIMorningBriefing()` pulls current weather + a 24h forecast, asks Gemini
  (with Google Search grounding) for a short weather/news/status briefing, and
  prints it with a weather header and source links. The art job still reuses its
  weather fetcher.

```
Apps Script trigger
  └─ build ESC/POS byte array (CMD.* command table + text helpers)
      └─ sendToPi(): POST octet-stream to PI_URL (Basic auth: NGROK_USER/PASS)
          └─ Raspberry Pi bridge → Epson TM-T20III (USB, ESC/POS)
```

## Hardware

The printer is an **Epson TM-T20III** — an 80mm ESC/POS thermal receipt printer
with an auto-cutter. Its full command set is bundled at
[`docs/epson-tm-t20iii-technical-reference-guide.pdf`](docs/epson-tm-t20iii-technical-reference-guide.pdf)
(Epson's Technical Reference Guide) — the reference for every byte in the `CMD`
table: the CP437 code page, `GS !` sizing (48 columns at Font A on 80mm paper),
`GS V` cut, and `GS B` invert.

## The print server (Pi side)

The receiving end is a **Raspberry Pi Zero W** running a small Python
`http.server` that writes raw bytes straight to the printer's character device
(`/dev/usb/lp0`). It's exposed to Apps Script over an **ngrok static domain with
HTTP basic auth**, kept alive by **systemd** (`printer.service`), and rebooted
weekly by cron to reset the USB stack.

Setup, file paths, maintenance commands, troubleshooting (the ngrok 502/401
cases), disaster recovery, and an end-to-end curl test all live in
**[`docs/pi-print-server-runbook.md`](docs/pi-print-server-runbook.md)**.
Credentials in that runbook are redacted — the real values live in the password
manager and in Script Properties.

## Deploy

TypeScript under `src/` is the source of truth; esbuild bundles it to a single
`dist/main.gs`, which `clasp` pushes.

```bash
npm install        # dev tooling: clasp, typescript, esbuild, prettier
npm run build      # tsc --noEmit + esbuild bundle -> dist/main.gs
npm run status     # list the files clasp would push (dry check)
npm run push       # build, then clasp push (uploads dist/)
```

The Apps Script web editor is a mirror, not a second source of truth — edit
locally and push. `npm run pull` fetches remote back down if the editor was
touched directly.

First-time setup on a new machine: `npx clasp login` (writes `~/.clasprc.json`),
then `npm run push`. The project is already bound via the committed
`.clasp.json`.

## Configuration

No secrets live in the repo. Runtime config is read from **Script Properties**
(Apps Script editor → Project Settings → Script Properties):

| Property          | Used by       | What it is                                    |
| ----------------- | ------------- | --------------------------------------------- |
| `PI_URL`          | all           | ngrok HTTPS URL of the Pi print bridge        |
| `NGROK_USER`      | all           | basic-auth username for the tunnel            |
| `NGROK_PASS`      | all           | basic-auth password for the tunnel            |
| `ANTHROPIC_KEY`   | art           | Anthropic API key (`claude-fable-5`)          |
| `EMAIL_ALERTS_TO` | art, calendar | where failure alerts are emailed              |
| `GEMINI_KEY`      | art, briefing | Google API key — the Weather API (and Gemini) |
| `LAT`             | art, briefing | latitude for weather (optional for art)       |
| `LON`             | art, briefing | longitude for weather (optional for art)      |
| `CALENDAR_ID`     | calendar      | which Google Calendar to print (dormant)      |
| `NEWS_KEY`        | briefing      | NewsAPI key (dormant)                         |

State keys managed by the script itself (no setup): `LAST_ART_DATE` (one art
print per day; retries after failures), `ART_HISTORY` (rolling archive of
recent pieces — fed back into the prompt so each day differs in subject and
technique), `PRINT_MEMORY` (de-dupes printed events), and `LAST_ALERT_TIME`
(rate-limits alert emails).

## Local iteration

`test-print.mjs` sends ESC/POS straight to the Pi bridge (the same endpoint Apps
Script hits), so you can iterate on receipt layout without deploying or waiting
on a trigger. `calendar`/`briefing` load the real builders from the built
`dist/main.gs`, so run `npm run build` first; the preview then matches production.

```bash
cp .env.example .env            # then fill in NGROK_USER / NGROK_PASS
npm run build                   # needed for modes that load dist/main.gs
node test-print.mjs hello       # minimal "SYSTEM ONLINE" connectivity test
node test-print.mjs text "Hi"   # arbitrary text
node test-print.mjs ruler       # column + gapless-spacing calibration page
node test-print.mjs art         # golden art spec through the real renderer (no API)
node test-print.mjs art:live    # LIVE Fable art end-to-end (ANTHROPIC_KEY in .env)
node test-print.mjs calendar    # sample calendar-event receipt (edit MOCKS in the file)
node test-print.mjs briefing    # sample AI-briefing receipt
node test-print.mjs art --dry   # print the hex payload instead of sending
```

`.env` is gitignored; credentials never live in the repo. This script is local
only — it isn't bundled into `dist/` or pushed to Apps Script.

## Triggers

Set up in the Apps Script editor (Triggers → Add Trigger), time-driven:

- `printDailyArt` — daily (a morning hour works well). An hourly trigger is
  also safe: `LAST_ART_DATE` limits it to one print per day, and because the
  guard is only set on success, extra runs double as retries after a failure.
- The old `checkAndPrintRobust` / `printAIMorningBriefing` triggers should be
  **deleted** — those jobs are dormant (code kept, unscheduled).

`testDailyArt()` prints the golden art spec (no API call) to verify the hardware
path; `testPrinter()` does the same for the old calendar layout. Set
`DRY_RUN = true` in `src/art.ts` to log the art spec instead of printing.

## Layout

```
src/
  appsscript.json   manifest (V8, America/Los_Angeles, Calendar adv. service)
  escpos.ts         CMD command table, column constants, stringToBytes, encodeCP437
  art.ts            daily Fable art → receipt (schema, renderer, Anthropic client)
  calendar.ts       calendar → receipt (dormant), the sendToPi transport, alerts
  briefing.ts       AI morning briefing → receipt (dormant), weather fetcher
  main.ts           entry points re-exported for the build footer
build.js            esbuild bundle → dist/main.gs
```

`npm run build` bundles `src/` into `dist/main.gs`; `clasp` uploads `dist/`
(`.clasp.json` → `"rootDir": "dist"`). `dist/` is gitignored.
