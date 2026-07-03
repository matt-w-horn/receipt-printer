#!/usr/bin/env node
// Local test / iteration harness for the receipt printer.
//
// Sends ESC/POS payloads straight to the Pi print bridge (the same endpoint the
// Apps Script uses via sendToPi), so you can iterate on receipt layout without
// deploying to Apps Script or waiting on the daily trigger.
//
// For `art` / `art:live` it loads the REAL builders from the built bundle
// (dist/main.gs) — run `npm run build` first — so the preview matches exactly what
// gets deployed and printed.
//
// Credentials come from the environment or a gitignored .env (never hardcoded):
//   PI_URL, NGROK_USER, NGROK_PASS   — copy .env.example to .env and fill in.
//
// Usage:
//   node test-print.mjs hello               # minimal "SYSTEM ONLINE" connectivity test
//   node test-print.mjs text "Hi there"     # print arbitrary text
//   node test-print.mjs ruler               # column/gapless calibration page
//   node test-print.mjs art                 # render the golden art spec (no API)
//   node test-print.mjs art:live            # LIVE Fable art (needs ANTHROPIC_KEY)
//   ... add --dry to any command to print the hex payload instead of sending.
//
// Requires Node 18+ (global fetch).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

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

// Load the built bundle and expose its receipt builders. The bundle's IIFE only
// defines things at eval time (GAS globals are touched only inside functions we
// don't call here), so loading is side-effect-free.
function loadBuilders() {
  const bundle = join(HERE, 'dist', 'main.gs');
  if (!existsSync(bundle)) {
    console.error('dist/main.gs not found — run `npm run build` first.');
    process.exit(1);
  }
  const ctx = vm.createContext({ console, Logger: { log() {} } });
  vm.runInContext(readFileSync(bundle, 'utf8'), ctx, { filename: 'dist/main.gs' });
  return ctx.__receipt; // { renderDailyArtReceipt, GOLDEN_ART_SPEC, ... }
}

// Self-contained ESC/POS for the hello/text/ruler modes (independent of src).
const ESC = 0x1b;
const GS = 0x1d;
const strBytes = (s) => [...s].map((c) => c.charCodeAt(0) & 0xff);
const hello = () => [ESC, 0x40, ESC, 0x74, 0x00, ...strBytes('SYSTEM ONLINE'), 0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00]; // prettier-ignore
const asText = (t) => [ESC, 0x40, ESC, 0x74, 0x00, ...strBytes(t), 0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00]; // prettier-ignore

// Calibration page: (a) numbered rulers reveal the real column counts (where a
// 48/64-char line wraps, if it wraps); (b) rows of ▀ (top half black, bottom
// half white) under candidate ESC 3 values reveal the true gapless spacing —
// the section whose black and white stripes are EQUAL and clean is the value
// for one 24-dot row (solid black = overlap, value too small; extra white =
// gaps, value too big); (c) an inverted band sanity-checks GS B.
function ruler() {
  const b = [ESC, 0x40, ESC, 0x74, 0x00, ESC, 0x61, 0x00]; // init, CP437, left
  const seq = (n) => {
    let s = '';
    for (let i = 1; i <= n; i++) s += String(i % 10);
    return s;
  };
  const halfTop = (n) => Array(n).fill(0xdf); // ▀ in CP437
  b.push(...strBytes('FONT A ruler (48 cols):\n'), ...strBytes(seq(48)), 0x0a, 0x0a);
  b.push(ESC, 0x4d, 0x01); // Font B
  b.push(...strBytes('FONT B ruler (64 cols):\n'), ...strBytes(seq(64)), 0x0a, 0x0a);
  b.push(ESC, 0x4d, 0x00); // Font A
  b.push(...strBytes('SPACING: pick the n with EQUAL clean\n'));
  b.push(...strBytes('black/white stripes. solid black =\n'));
  b.push(...strBytes('overlap; wide white = gaps.\n\n'));
  for (const n of [24, 43, 48]) {
    b.push(...strBytes(`n=${n}:\n`));
    b.push(ESC, 0x33, n);
    for (let i = 0; i < 4; i++) b.push(...halfTop(20), 0x0a);
    b.push(ESC, 0x32, 0x0a);
  }
  b.push(GS, 0x42, 0x01, ...strBytes('  INVERT BAND  '), GS, 0x42, 0x00, 0x0a);
  b.push(0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00);
  return b;
}

// --- Anthropic live call (art:live) -------------------------------------------
// Mirrors src/art.ts generateDailyArt(): same request body (built by the
// bundle's buildArtRequestBody), same pause_turn / tool-version handling.
async function fableArtSpec(receipt) {
  const key = process.env.ANTHROPIC_KEY;
  const oauth = process.env.ANTHROPIC_ACCESS_TOKEN; // e.g. ant auth print-credentials --access-token
  if (!key && !oauth) {
    console.error(
      'art:live needs ANTHROPIC_KEY in .env (or ANTHROPIC_ACCESS_TOKEN exported).',
    );
    process.exit(1);
  }

  const weather = await nodeWeather();
  const ctx = receipt.buildArtContext(
    new Date(),
    weather,
    process.env.LAT ?? null,
    process.env.LON ?? null,
  );
  console.log(`— context —\n${ctx}\n`);

  const toolTypes = ['web_search_20260209', 'web_search_20250305'];
  let toolIdx = 0;
  let messages = [{ role: 'user', content: ctx }];

  for (let attempt = 0; attempt < 5; attempt++) {
    const body = receipt.buildArtRequestBody(messages, toolTypes[toolIdx]);
    const headers = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta':
        'server-side-fallback-2026-06-01' + (oauth && !key ? ',oauth-2025-04-20' : ''),
    };
    if (key) headers['x-api-key'] = key;
    else headers['authorization'] = `Bearer ${oauth}`;

    console.log(`→ calling ${body.model} (attempt ${attempt + 1})...`);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 400 && toolIdx === 0 && text.includes(toolTypes[0])) {
        console.log('↩ retrying with basic web_search variant');
        toolIdx = 1;
        continue;
      }
      throw new Error(`Anthropic ${res.status}: ${text.slice(0, 600)}`);
    }
    const json = JSON.parse(text);
    if (json.stop_reason === 'pause_turn') {
      console.log('⏸ pause_turn — resuming server tool loop');
      messages = [...messages, { role: 'assistant', content: json.content }];
      continue;
    }
    if (json.usage) {
      console.log(
        `tokens: in=${json.usage.input_tokens} out=${json.usage.output_tokens}`,
      );
    }
    return receipt.parseArtResponse(json);
  }
  throw new Error('Anthropic call did not complete after 5 attempts');
}

// Compact Node-side mirror of getDeepWeather (optional: GEMINI_KEY/LAT/LON in .env).
async function nodeWeather() {
  const { GEMINI_KEY, LAT, LON } = process.env;
  if (!GEMINI_KEY || !LAT || !LON) return null;
  try {
    const base = 'https://weather.googleapis.com/v1';
    const loc = `location.latitude=${LAT}&location.longitude=${LON}&unitsSystem=IMPERIAL`;
    const cur = await (
      await fetch(`${base}/currentConditions:lookup?key=${GEMINI_KEY}&${loc}`)
    ).json();
    const fc = await (
      await fetch(`${base}/forecast/hours:lookup?key=${GEMINI_KEY}&${loc}&hours=24`)
    ).json();
    let high = -100,
      low = 200,
      rain = 0;
    for (const h of fc.forecastHours ?? []) {
      const t = h.temperature.degrees;
      const pr = h.precipitation?.probability?.percent || 0;
      if (t > high) high = t;
      if (t < low) low = t;
      if (pr > rain) rain = pr;
    }
    if (high === -100) high = low = cur.temperature.degrees;
    return {
      current: Math.round(cur.temperature.degrees),
      feels_like: Math.round(cur.feelsLikeTemperature.degrees),
      high: Math.round(high),
      low: Math.round(low),
      humidity: cur.relativeHumidity,
      wind: Math.round(cur.wind.speed.value),
      uv: cur.uvIndex,
      rain_chance: rain,
      code: cur.weatherCondition.description.text,
      forecast: '',
      currentConditions: '',
    };
  } catch (e) {
    console.log(`(weather unavailable: ${e.message})`);
    return null;
  }
}

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
    case 'ruler':
      bytes = ruler();
      break;
    case 'art': {
      const receipt = loadBuilders();
      if (!receipt.renderDailyArtReceipt || !receipt.GOLDEN_ART_SPEC)
        throw new Error('art builders not found — run `npm run build` first');
      bytes = receipt.renderDailyArtReceipt(receipt.GOLDEN_ART_SPEC, new Date());
      break;
    }
    case 'art:live': {
      const receipt = loadBuilders();
      if (!receipt.renderDailyArtReceipt || !receipt.buildArtRequestBody)
        throw new Error('art builders not found — run `npm run build` first');
      const spec = await fableArtSpec(receipt);
      console.log(`\n🎨 "${spec.title}" — ${spec.ops.length} ops`);
      console.log(JSON.stringify(spec, null, 2));
      bytes = receipt.renderDailyArtReceipt(spec, new Date());
      break;
    }
    default:
      console.error(
        `Unknown mode "${mode}". Use: hello | text "..." | ruler | art | art:live  [--dry]`,
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
