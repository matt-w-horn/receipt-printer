# receipt-printer

Turn a thermal receipt printer into a personal output device — driven by Google
Apps Script. The script assembles [ESC/POS](https://en.wikipedia.org/wiki/ESC/POS)
byte payloads and POSTs them to a printer bridge on a Raspberry Pi (reached over
an ngrok tunnel with HTTP basic auth), so anything Apps Script can reach — Google
services, any REST API, an LLM — can become a printed receipt.

Two jobs ship today, each on its own time-based trigger; more are planned:

- **Calendar → receipt** (`Code.js`) — `checkAndPrintRobust()` scans a Google
  Calendar for events in a rolling window and prints each new one as a receipt
  (bordered header, big title, checkbox-aware description).
- **AI morning briefing → receipt** (`WeatherReport.gs.js`) —
  `printAIMorningBriefing()` pulls current weather + a 24h forecast, asks Gemini
  (with Google Search grounding) for a short weather/news/status briefing, and
  prints it with a weather header and source links.

```
Apps Script trigger
  └─ build ESC/POS byte array (CMD.* command table + text helpers)
      └─ sendToPi(): POST octet-stream to PI_URL (Basic auth: NGROK_USER/PASS)
          └─ Raspberry Pi bridge → USB/serial thermal printer
```

## Deploy

Local source is the source of truth; `clasp` pushes it straight to the Apps
Script project (no build step — the files are pushed as-is).

```bash
npm install        # dev tooling: clasp + prettier
npm run status     # list the files clasp would push (dry check)
npm run push       # clasp push — upload src/ to the Apps Script project
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

| Property     | Used by  | What it is                                          |
| ------------ | -------- | --------------------------------------------------- |
| `PI_URL`     | both     | ngrok HTTPS URL of the Pi print bridge              |
| `NGROK_USER` | both     | basic-auth username for the tunnel                  |
| `NGROK_PASS` | both     | basic-auth password for the tunnel                  |
| `GEMINI_KEY` | briefing | Google API key — Gemini **and** the Weather API     |
| `NEWS_KEY`   | briefing | NewsAPI key (currently optional — news path is off) |
| `LAT`        | briefing | latitude for weather                                |
| `LON`        | briefing | longitude for weather                               |

A couple of values are still hardcoded at the top of `Code.js` —
`CALENDAR_ID` (which calendar to print) and `EMAIL_ALERTS_TO` (where failure
alerts go). Two state keys are managed by the script itself and need no setup:
`PRINT_MEMORY` (de-dupes already-printed events) and `LAST_ALERT_TIME` (rate-limits
alert emails).

## Triggers

Set up in the Apps Script editor (Triggers → Add Trigger), time-driven:

- `checkAndPrintRobust` — e.g. hourly / a few times a day; it de-dupes so
  re-runs are safe.
- `printAIMorningBriefing` — once each morning.

`testPrinter()` prints two sample receipts to verify the hardware path. Set
`DRY_RUN = true` in `WeatherReport.gs.js` to log the briefing instead of
printing it.

## Layout

```
src/
  appsscript.json       manifest (V8, America/Los_Angeles, Calendar adv. service)
  Code.js               calendar → receipt + the shared CMD/print helpers
  WeatherReport.gs.js   AI morning briefing → receipt
```

`src/` is what `clasp` uploads (`.clasp.json` → `"rootDir": "src"`).
