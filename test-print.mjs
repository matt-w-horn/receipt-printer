#!/usr/bin/env node
// Local test / iteration harness for the receipt printer.
//
// Sends ESC/POS payloads straight to the Pi print bridge (the same endpoint the
// Apps Script uses via sendToPi), so you can iterate on receipt layout without
// deploying to Apps Script or waiting on a calendar trigger.
//
// For `calendar` / `briefing` it loads the REAL builders from src/ (Code.js +
// WeatherReport.gs.js) in the same order Apps Script does, so the preview matches
// what production prints — including the shared-global quirks (see CLAUDE.md).
//
// Credentials come from the environment or a gitignored .env (never hardcoded):
//   PI_URL, NGROK_USER, NGROK_PASS   — copy .env.example to .env and fill in.
//
// Usage:
//   node test-print.mjs hello               # minimal "SYSTEM ONLINE" connectivity test
//   node test-print.mjs text "Hi there"     # print arbitrary text
//   node test-print.mjs calendar            # render a sample calendar-event receipt
//   node test-print.mjs briefing            # render a sample AI-briefing receipt
//   ... add --dry to any command to print the hex payload instead of sending.
//
// Requires Node 18+ (global fetch). Edit the MOCKS below to iterate on content.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- MOCKS: edit these to iterate on layout/content ---------------------------
function mockEvent() {
  const start = new Date();
  return {
    getId: () => 'LOCALTEST',
    getTitle: () => 'Dentist Appointment',
    getDescription: () => 'Arrive 10 min early[ ] Bring insurance card[ ] Pay copay',
    getStartTime: () => start,
    isAllDayEvent: () => false,
  };
}
function mockBriefing() {
  return {
    ai: {
      text: [
        '**Weather Outlook**',
        'Clear through the afternoon, cooling into the evening with light winds.',
        '**News Sync**',
        'Local roadwork on Main St wraps this week; expect fewer delays downtown.',
        '**System Status**',
        'A good day to knock out the hard task first.',
      ].join('\n'),
      sources: [{ title: 'Example News', url: 'https://example.com/local/roadwork' }],
    },
    weather: {
      current: 68,
      feels_like: 66,
      high: 74,
      low: 55,
      wind: 6,
      rain_chance: 10,
      code: 'Sunny',
    },
  };
}
// -----------------------------------------------------------------------------

// Minimal .env loader (no dependency): KEY=VALUE lines, # comments.
function loadDotEnv() {
  const p = join(HERE, '.env');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// Load the plain-JS Apps Script sources and expose their top-level builders.
// GAS globals (UrlFetchApp, PropertiesService, ...) are only touched at call
// time by functions we don't invoke here, so loading is side-effect-free.
function loadBuilders() {
  const src = ['Code.js', 'WeatherReport.gs.js']
    .map((f) => readFileSync(join(HERE, 'src', f), 'utf8'))
    .join('\n;\n');
  const footer = `
    ;globalThis.__exports = {
      generateReceiptPayload:
        typeof generateReceiptPayload !== 'undefined' ? generateReceiptPayload : undefined,
      buildDeepReceipt:
        typeof buildDeepReceipt !== 'undefined' ? buildDeepReceipt : undefined,
    };`;
  const ctx = vm.createContext({ console, Logger: { log() {} } });
  vm.runInContext(src + footer, ctx, { filename: 'src(Code.js+WeatherReport.gs.js)' });
  return ctx.__exports;
}

// Self-contained ESC/POS for the hello/text modes (independent of src).
const ESC = 0x1b;
const GS = 0x1d;
const strBytes = (s) => [...s].map((c) => c.charCodeAt(0) & 0xff);
const hello = () => [ESC, 0x40, ESC, 0x74, 0x00, ...strBytes('SYSTEM ONLINE'), 0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00]; // prettier-ignore
const asText = (t) => [ESC, 0x40, ESC, 0x74, 0x00, ...strBytes(t), 0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00]; // prettier-ignore

const toHex = (bytes) =>
  bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');

async function send(bytes) {
  const { PI_URL, NGROK_USER, NGROK_PASS } = process.env;
  if (!PI_URL || !NGROK_USER || !NGROK_PASS) {
    console.error(
      'Missing PI_URL / NGROK_USER / NGROK_PASS.\n' +
        'Copy .env.example to .env and fill it in, or export them inline. ' +
        '(Or add --dry to preview the payload without sending.)',
    );
    process.exit(1);
  }
  const auth = 'Basic ' + Buffer.from(`${NGROK_USER}:${NGROK_PASS}`).toString('base64');
  let res;
  try {
    res = await fetch(PI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: auth },
      body: Buffer.from(bytes.map((b) => b & 0xff)),
    });
  } catch (e) {
    console.error(`✗ Network error reaching ${PI_URL}: ${e.message}`);
    console.error('  Is the Pi + ngrok tunnel up? See docs/pi-print-server-runbook.md.');
    process.exit(1);
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    console.error(
      `✗ HTTP ${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`,
    );
    if (res.status === 401) console.error('  401 = wrong NGROK_USER/NGROK_PASS.');
    if (res.status === 502)
      console.error(
        '  502 = ngrok up but Python dead: `sudo systemctl restart printer`.',
      );
    process.exit(1);
  }
  console.log(
    `✓ Sent ${bytes.length} bytes → HTTP ${res.status}. A receipt should print and cut.`,
  );
}

async function main() {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const [mode = 'hello', ...rest] = argv.filter((a) => a !== '--dry');
  const arg = rest.join(' ');

  let bytes;
  switch (mode) {
    case 'hello':
      bytes = hello();
      break;
    case 'text':
      bytes = asText(arg || 'HELLO FROM LOCAL');
      break;
    case 'calendar': {
      const { generateReceiptPayload } = loadBuilders();
      if (!generateReceiptPayload)
        throw new Error('generateReceiptPayload not found in src/');
      bytes = generateReceiptPayload(mockEvent());
      break;
    }
    case 'briefing': {
      const { buildDeepReceipt } = loadBuilders();
      if (!buildDeepReceipt) throw new Error('buildDeepReceipt not found in src/');
      const m = mockBriefing();
      bytes = buildDeepReceipt(m.ai, m.weather);
      break;
    }
    default:
      console.error(
        `Unknown mode "${mode}". Use: hello | text "..." | calendar | briefing  [--dry]`,
      );
      process.exit(1);
  }

  if (dry) {
    console.log(`[dry] ${mode}: ${bytes.length} bytes`);
    console.log(toHex(bytes));
  } else {
    await send(bytes);
  }
}

await main();
