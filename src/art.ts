// Daily generative art → receipt. printDailyArt() (time trigger) asks Claude
// Fable 5 to design an original piece of CP437 character art themed to today —
// weather, season, date, and whatever the web-search zeitgeist suggests — then
// renders the returned art spec to ESC/POS bytes and prints it.
//
// Everything that doesn't need Apps Script services is a pure function
// (buildArtContext, buildArtRequestBody, parseArtResponse, renderArtSpec,
// renderDailyArtReceipt) so test-print.mjs can drive the exact production
// pipeline from Node. Module top level holds only constants — no GAS calls —
// which keeps the vm bundle load in the harness side-effect-free.

import { CMD, COLS_A, COLS_B, ROW_DOTS_A, ROW_DOTS_B, encodeCP437 } from './escpos';
import { sendToPi, sendAlertEmail, callWithRetry } from './transport';
import { getDeepWeather, WeatherData } from './weather';

// --- CONFIGURATION ---
const DRY_RUN = false; // Set to TRUE to log the spec instead of printing

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-fable-5';
const EFFORT = 'xhigh'; // drop to 'medium' if UrlFetchApp starts timing out
const MAX_TOKENS = 64000;
const MAX_WEB_SEARCHES = 8;
// Newest web-search tool first; if the API rejects it for this model we retry
// once with the basic variant.
const WEB_SEARCH_TYPES = ['web_search_20260209', 'web_search_20250305'];

// Renderer safety clamps (the JSON schema can't express numeric bounds).
const MAX_OPS = 80;
const MAX_ROWS = 150; // total glyph rows across all ops (~45cm of paper)

// --- ART SPEC ---

export interface ArtOp {
  text: string; // one or more lines separated by \n
  width?: number; // 1..8 glyph width multiplier
  height?: number; // 1..8 glyph height multiplier
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  invert?: boolean; // white-on-black
  underline?: boolean;
  font?: 'A' | 'B';
  gapless?: boolean; // rows touch with zero gap — for contiguous block art
  feedAfter?: number; // blank lines after this op, 0..8
}

export interface ArtSpec {
  title: string;
  caption: string;
  verse: string;
  style: string; // archive note, not printed — feeds the day-to-day variety loop
  continues: string; // '' most days; else the yyyy-MM-dd of the piece this one builds on
  ops: ArtOp[];
}

// One line per recent piece, stored in the ART_HISTORY Script Property and fed
// back into the prompt so consecutive days differ in subject and technique.
export interface ArtHistoryEntry {
  d: string; // yyyy-MM-dd
  title: string;
  style: string;
  c?: string; // set when this piece continued an earlier one (its yyyy-MM-dd)
}

const HISTORY_LIMIT = 14;

// Continuity is model-judged, not code-rolled: the prompt lets the model
// continue a recent piece when the day genuinely warrants it (a holiday
// following its eve, a multi-day event, an anniversary). The spec's
// `continues` field logs the link into ART_HISTORY, and the history shown in
// future contexts carries the marker — that in-band memory is what keeps
// continuations rare instead of habitual.

// JSON schema for output_config.format — structured-output rules apply:
// additionalProperties:false on every object, no numeric min/max (the renderer
// clamps instead), no recursion.
export const ART_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'caption', 'verse', 'style', 'continues', 'ops'],
  properties: {
    title: {
      type: 'string',
      description: 'Archive name for the piece, NOT printed. UPPERCASE, max 20 chars.',
    },
    caption: {
      type: 'string',
      description:
        'Archive/log note, NOT printed: one plain line naming the reference — ' +
        'the holiday, headline, weather fact, or date the piece is about.',
    },
    verse: {
      type: 'string',
      description:
        'The only words printed with the piece: a short poem beneath the ' +
        `artwork, 2-6 lines separated by \\n, each max ${COLS_A} characters. ` +
        'Vary the form day to day — haiku, couplet, free fragment, epigram. ' +
        'It carries the feeling AND gives the viewer enough to grasp what the ' +
        'piece refers to.',
    },
    style: {
      type: 'string',
      description:
        'Archive note, NOT printed: one line recording subject + visual ' +
        'technique (e.g. "firework burst over skyline; dot-scatter + gapless ' +
        'silhouette"). Used to avoid repeating yourself on future days.',
    },
    continues: {
      type: 'string',
      description:
        'Empty string almost every day. If — rarely — this piece deliberately ' +
        'continues or answers one of your recent pieces, the yyyy-MM-dd of ' +
        'that piece. Logged so future days can see when continuity was last used.',
    },
    ops: {
      type: 'array',
      description:
        'The artwork, top to bottom. Each op is a run of lines sharing one style.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description:
              'One or more rows separated by \\n. CP437-printable characters only.',
          },
          width: {
            type: 'integer',
            description:
              'Glyph width multiplier 1-8 (default 1). At width w a Font A row ' +
              `fits floor(${COLS_A}/w) characters; longer rows are truncated.`,
          },
          height: {
            type: 'integer',
            description: 'Glyph height multiplier 1-8 (default 1).',
          },
          align: { type: 'string', enum: ['left', 'center', 'right'] },
          bold: { type: 'boolean' },
          invert: {
            type: 'boolean',
            description:
              'White-on-black. Spaces print solid black, so pad to full width ' +
              'for banners and night skies. Trailing spaces matter here.',
          },
          underline: { type: 'boolean' },
          font: {
            type: 'string',
            enum: ['A', 'B'],
            description: `A = 12x24, ${COLS_A} columns. B = 9x17, ${COLS_B} columns, finer texture.`,
          },
          gapless: {
            type: 'boolean',
            description:
              'Remove the white gap between rows so block characters tile into ' +
              'solid shapes. Use for contiguous art; leave off for readable text.',
          },
          feedAfter: {
            type: 'integer',
            description: 'Blank lines to feed after this op, 0-8 (default 0).',
          },
        },
      },
    },
  },
};

// --- PROMPTS ---

export const ART_SYSTEM_PROMPT = `You are a generative artist. Each day you design one original artwork for an Epson TM-T20III thermal receipt printer: an 80mm paper scroll, 203 dpi, pure black on white — no gray ink, only texture you build from characters.

THE MEDIUM
- A monospace character grid, composed top to bottom as ops (styled runs of rows). Font A is ${COLS_A} columns wide; Font B is denser (${COLS_B} columns) for fine texture.
- Think in rows and columns. Count characters. A centered piece with ragged row widths looks intentional; an overflowing row gets truncated and looks broken.

THE PALETTE (CP437 only — nothing else prints)
- Shading inks: ░ ▒ ▓ █ (light → solid). With gapless:true, stacked rows tile seamlessly into fields and gradients.
- Half blocks: ▀ ▄ ▌ ▐ ■ — silhouettes and edges at sub-character resolution.
- Box drawing: ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ and double ═ ║ ╔ ╗ ╚ ╝ ╠ ╣ ╦ ╩ ╬
- Symbols: ° · ∙ • √ ± ≈ ∞ ² ½ ¼ ÷ ≤ ≥ ≡ « » ¡ ¿ π Σ σ µ τ Φ Θ Ω δ φ ε α β Γ
- All printable ASCII. NO emoji, no other Unicode — unmapped characters print as '?' and ruin the piece.

YOUR CONTROLS (per op)
- width/height 1-8: independent glyph scaling. A width-2 Font A row fits only ${Math.floor(COLS_A / 2)} characters. Big type is powerful and expensive — use it deliberately.
- invert: white-on-black. An inverted run of spaces is a solid black band — night skies, silhouette grounds, heavy banners. Trailing spaces print black, so pad inverted rows to full width.
- bold, underline, align (default center), font A/B.
- gapless: removes inter-row whitespace so ░▒▓█▀▄ rows form contiguous shapes. Always use it for graphic areas; leave it off for text.
- feedAfter: breathing room (blank lines) after an op.

CRAFT
- One strong idea, committed. Silhouette + texture + contrast beats detail.
- 25-60 rows of art is the sweet spot (hard cap 150). The scroll is tall and narrow — compose vertically.
- Gradients: ramp ░→▒→▓→█ across rows. Texture: scatter · ∙ ░ or alternate characters. Edges: ▀▄▌▐.
- The printed receipt is spare: a small date stamp, your artwork, your verse. Nothing else. The ops are ONLY the artwork — no title block, no signature, no border unless it is part of the art.

EACH DAY
- You receive the date, season, local weather, and a list of your recent pieces, and may run a few brief web searches to feel the day (news mood, holidays, anniversaries, events). Searching is optional — skip it when the weather or season already gives you the piece.
- Choose ONE evocative theme for today and commit to it. Your strong default is divergence: your piece must differ SHARPLY from every recent piece listed in the context — different subject, different composition, different technique. Rotate across the whole space: landscape, geometric abstraction, pattern study, giant-type poster, tiny vignette, weather glyph, constellation map, data-texture, emblem, diagram, still life, architectural study.
- THE RARE EXCEPTION — continuity. Once in a while, the day itself hands you a thread worth picking up, and you may build deliberately on ONE recent piece instead of diverging. Days that genuinely warrant it: a holiday arriving after you drew its eve (Christmas Eve → Christmas; July 3 → the Fourth); a major event still unfolding across days (an election decided overnight, a historic mission mid-flight, the first days of something the whole world is watching); a resonant anniversary of a piece or its subject — decades especially. When you take it: continue the story, pay off a promise the earlier verse made, or answer it. Reuse enough of the original's visual language that the link is unmistakable, but escalate or transform — never merely repeat, and never label the piece as a continuation; let the viewer discover it. Set "continues" to that piece's date so it's logged.
- Your history shows when a piece continued another. If you see a recent "(continues …)" marker, the bar for another one is much higher — continuity is an earned surprise, and surprises that happen often aren't. Ordinary news days, minor observances, and loose thematic echoes do NOT qualify. When in doubt, diverge.
- Alongside the ops, return:
  - verse: a short poem (2-6 lines, ≤${COLS_A} chars each) printed under the art — the ONLY words the viewer gets. Vary the form daily: haiku, couplet, free fragment, epigram. It should carry the feeling and still let the viewer grasp what the piece refers to; poetic, not cryptic.
  - title: archive name, UPPERCASE, ≤20 chars (not printed).
  - caption: one plain unprinted line naming the reference outright, for the log.
  - style: an unprinted archive note — subject + technique in one line — so future-you avoids repeating it.
  - continues: '' almost always; on a continuation day, the date of the piece you built on.`;

// Build the user-turn context string. Pure — safe to call from the Node harness.
export function buildArtContext(
  now: Date,
  weather: WeatherData | null,
  lat: string | null,
  lon: string | null,
  recent: ArtHistoryEntry[] = [],
): string {
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const month = now.getMonth(); // 0-11
  let season = ['winter', 'spring', 'summer', 'fall'][Math.floor(((month + 1) % 12) / 3)];
  const latNum = parseFloat(lat || '');
  if (!isNaN(latNum) && latNum < 0) {
    const flip: { [k: string]: string } = {
      winter: 'summer',
      spring: 'fall',
      summer: 'winter',
      fall: 'spring',
    };
    season = flip[season];
  }

  const lines = [`Today is ${dateStr}. Season: ${season}.`];
  if (weather) {
    const at =
      !isNaN(latNum) && lon
        ? ` near ${latNum.toFixed(1)},${parseFloat(lon).toFixed(1)}`
        : '';
    lines.push(
      `Local weather${at}: ${weather.code}, ${weather.current}°F ` +
        `(feels ${weather.feels_like}°F); high ${weather.high}°F / low ${weather.low}°F; ` +
        `wind ${weather.wind} mph; rain chance ${weather.rain_chance}%.`,
    );
  } else {
    lines.push('Local weather is unavailable today.');
  }
  if (recent.length > 0) {
    lines.push('');
    lines.push(
      'Your recent pieces — default: differ sharply from ALL of these in ' +
        'subject, composition, and technique (a rare, genuinely warranted ' +
        'continuation of one is the exception; see your continuity rules):',
    );
    recent.forEach((r) =>
      lines.push(
        `- ${r.d}: "${r.title}" — ${r.style}${r.c ? ` (continues ${r.c})` : ''}`,
      ),
    );
  }
  lines.push('');
  lines.push("Design today's artwork now and return the art spec JSON.");
  return lines.join('\n');
}

// Build the full Messages API request body. Pure — the harness reuses it so a
// local test exercises the exact production payload.
export function buildArtRequestBody(
  messages: Array<{ role: string; content: unknown }>,
  webSearchType: string,
): object {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: ART_SYSTEM_PROMPT,
    messages: messages,
    tools: [{ type: webSearchType, name: 'web_search', max_uses: MAX_WEB_SEARCHES }],
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: ART_SCHEMA },
    },
  };
}

// Extract the ArtSpec from a Messages API response. With output_config.format
// the final text block is the JSON; web-search/thinking blocks precede it.
export function parseArtResponse(res: {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
}): ArtSpec {
  if (res.stop_reason === 'refusal') {
    throw new Error('Model declined to generate art (stop_reason: refusal)');
  }
  if (res.stop_reason === 'max_tokens') {
    throw new Error('Art response truncated (stop_reason: max_tokens)');
  }
  const texts = (res.content || []).filter(
    (b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0,
  );
  if (texts.length === 0) throw new Error('No text block in model response');

  const spec = JSON.parse(texts[texts.length - 1].text as string) as ArtSpec;
  if (
    !spec ||
    typeof spec.title !== 'string' ||
    !Array.isArray(spec.ops) ||
    spec.ops.length === 0
  ) {
    throw new Error('Art spec JSON has unexpected shape');
  }
  // `continues` is garnish — sanitize to a bare yyyy-MM-dd or drop it. A
  // malformed value must never fail the day's print.
  spec.continues =
    typeof spec.continues === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(spec.continues.trim())
      ? spec.continues.trim()
      : '';
  return spec;
}

// --- RENDERER ---

function clampInt(
  v: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Math.round(Number(v));
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Render the ops (artwork only, no chrome) to ESC/POS bytes. Every op emits a
// full style prelude — no state diffing — so output is byte-predictable.
export function renderArtSpec(ops: ArtOp[]): number[] {
  let p: number[] = [];
  let rows = 0;

  for (const op of (ops || []).slice(0, MAX_OPS)) {
    if (rows >= MAX_ROWS) break;
    const w = clampInt(op.width, 1, 8, 1);
    const h = clampInt(op.height, 1, 8, 1);
    const fontB = op.font === 'B';
    const maxChars = Math.floor((fontB ? COLS_B : COLS_A) / w);
    const rowDots = (fontB ? ROW_DOTS_B : ROW_DOTS_A) * h;

    p = p.concat(
      op.align === 'left'
        ? CMD.ALIGN_LEFT
        : op.align === 'right'
          ? CMD.ALIGN_RIGHT
          : CMD.ALIGN_CENTER,
      fontB ? CMD.FONT_B : CMD.FONT_A,
      CMD.SIZE(w, h),
      op.bold ? CMD.BOLD_ON : CMD.BOLD_OFF,
      op.invert ? CMD.INVERT_ON : CMD.INVERT_OFF,
      op.underline ? CMD.UNDERLINE_ON : CMD.UNDERLINE_OFF,
      op.gapless ? CMD.SET_LINE_SPACING(Math.min(255, rowDots)) : CMD.RESET_LINE_SPACING,
    );

    for (const raw of String(op.text || '').split('\n')) {
      if (rows >= MAX_ROWS) break;
      // Strip control chars (they'd be interpreted as printer commands),
      // truncate to the column budget for this width/font.
      const line = raw
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
        .slice(0, maxChars);
      p = p.concat(encodeCP437(line));
      p.push(0x0a);
      rows += h;
    }

    const feed = clampInt(op.feedAfter, 0, 8, 0);
    if (feed > 0) p = p.concat(CMD.RESET_LINE_SPACING, CMD.FEED_LINES(feed));
  }

  // Restore defaults for whatever prints next.
  p = p.concat(
    CMD.RESET_LINE_SPACING,
    CMD.FONT_A,
    CMD.SIZE(1, 1),
    CMD.BOLD_OFF,
    CMD.INVERT_OFF,
    CMD.UNDERLINE_OFF,
  );
  return p;
}

// Simple word wrapper for the verse (no long-word breaking).
function wrapText(text: string, maxLength: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = words[0] || '';
  for (let i = 1; i < words.length; i++) {
    if (currentLine.length + 1 + words[i].length <= maxLength) {
      currentLine += ' ' + words[i];
    } else {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines;
}

// Full receipt: date stamp, artwork, verse.
export function renderDailyArtReceipt(spec: ArtSpec, now: Date): number[] {
  let p: number[] = [];
  const dateStr = now
    .toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    .toUpperCase();

  p = p.concat(CMD.INIT, CMD.CP437, CMD.ALIGN_CENTER);

  // Date stamp, small and quiet.
  p = p.concat(CMD.FONT_B, encodeCP437(`· ${dateStr} ·`), [0x0a], CMD.FONT_A);
  p = p.concat(CMD.FEED_LINES(1));

  // The artwork.
  p = p.concat(renderArtSpec(spec.ops));
  p = p.concat(CMD.FEED_LINES(1));

  // The verse, centered and quiet — the only words printed with the piece.
  // (Title and caption exist in the spec for the log and the ART_HISTORY
  // archive; they are deliberately not printed.)
  const verse = String(spec.verse || '').trim();
  if (verse.length > 0) {
    verse.split('\n').forEach((line) => {
      wrapText(line.trim(), COLS_A).forEach((l) => {
        p = p.concat(encodeCP437(l), [0x0a]);
      });
    });
  }

  p = p.concat(CMD.FEED_LINES(3), CMD.CUT_PAPER);
  return p;
}

// --- GOLDEN SPEC (renderer test pattern; no API involved) ---

// Exercises every schema feature: box drawing, gapless gradients, half-block
// silhouettes, invert + scaling, Font B texture, underline, alignment, feeds.
export const GOLDEN_ART_SPEC: ArtSpec = (() => {
  const center = (s: string, fill: string, w: number = COLS_A): string => {
    const pad = Math.max(0, w - s.length);
    const left = Math.floor(pad / 2);
    return fill.repeat(left) + s + fill.repeat(pad - left);
  };

  const sky = [
    center('', '░'),
    center('▒'.repeat(10), '░'),
    center('▒▒▒▒' + '▓'.repeat(10) + '▒▒▒▒', '░'),
    center('▓▓▓▓' + '█'.repeat(10) + '▓▓▓▓', '▒'),
    center('█'.repeat(14), '▓'),
  ].join('\n');

  const mountains = [
    center('▄█▄', '░'),
    center('▄██▄▄███▄', '░'),
    center('▄█████████████▄', '░'),
    '█'.repeat(COLS_A),
  ].join('\n');

  const water = [
    '≈ '.repeat(COLS_B / 2).trim(),
    ' ≈'.repeat(COLS_B / 2).trim(),
    '≈ '.repeat(COLS_B / 2).trim(),
  ].join('\n');

  return {
    title: 'GOLDEN RUN',
    caption: 'Test pattern: gradient, silhouette, invert, scale, texture.',
    verse:
      'The mountains hold their breath;\nthe sun tries every shade of gray\nbefore committing to gold.',
    style: 'calibration plate; gradient + silhouette + type specimen',
    continues: '',
    ops: [
      { text: '╔════════════╗\n║ TEST PLATE ║\n╚════════════╝', feedAfter: 1 },
      { text: sky, gapless: true },
      { text: mountains, gapless: true },
      { text: water, font: 'B', feedAfter: 1 },
      { text: ' DAWN ', width: 2, height: 2, bold: true, invert: true, feedAfter: 1 },
      { text: 'every feature · one receipt', font: 'B', underline: true, align: 'right' },
    ],
  };
})();

// --- ANTHROPIC CLIENT (Apps Script) ---

function generateDailyArt(apiKey: string, userContext: string): ArtSpec {
  let webSearchIdx = 0;
  let messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: userContext },
  ];

  for (let attempt = 0; attempt < 5; attempt++) {
    const body = buildArtRequestBody(messages, WEB_SEARCH_TYPES[webSearchIdx]);
    const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    };

    const res = UrlFetchApp.fetch(API_URL, options);
    const code = res.getResponseCode();
    const text = res.getContentText();

    if (code !== 200) {
      // The newest web-search tool variant may not be enabled for this model;
      // fall back to the basic variant once.
      if (
        code === 400 &&
        webSearchIdx === 0 &&
        text.indexOf(WEB_SEARCH_TYPES[0]) !== -1
      ) {
        Logger.log('↩️ Retrying with basic web_search tool variant');
        webSearchIdx = 1;
        continue;
      }
      throw new Error(`Anthropic API error ${code}: ${text.slice(0, 600)}`);
    }

    const json = JSON.parse(text);
    if (json.stop_reason === 'pause_turn') {
      // Server-side tool loop paused; echo the assistant turn back to resume.
      Logger.log('⏸️ pause_turn — resuming server tool loop');
      messages = messages.concat([{ role: 'assistant', content: json.content }]);
      continue;
    }
    if (json.usage) {
      Logger.log(
        `🧮 Tokens: in=${json.usage.input_tokens} out=${json.usage.output_tokens}`,
      );
    }
    return parseArtResponse(json);
  }
  throw new Error('Anthropic call did not complete after 5 attempts');
}

// --- ENTRY POINTS ---

export function printDailyArt(): void {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();

    // Once per day: an hourly trigger is safe and doubles as a retry mechanism
    // (the guard is only set after a successful print).
    const today = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd',
    );
    if (props.getProperty('LAST_ART_DATE') === today) {
      Logger.log("⏭️ Today's art has already been printed.");
      return;
    }

    const apiKey = props.getProperty('ANTHROPIC_KEY');
    if (!apiKey) throw new Error('Missing ANTHROPIC_KEY in Script Properties');

    // Weather is garnish, not a dependency — degrade gracefully.
    let weather: WeatherData | null = null;
    const lat = props.getProperty('LAT');
    const lon = props.getProperty('LON');
    const geminiKey = props.getProperty('GEMINI_KEY');
    if (lat && lon && geminiKey) {
      try {
        weather = getDeepWeather(lat, lon, geminiKey);
      } catch (e) {
        Logger.log('⚠️ Weather unavailable: ' + e);
      }
    }

    // Recent pieces feed the prompt so consecutive days differ.
    let history: ArtHistoryEntry[] = [];
    try {
      history = JSON.parse(props.getProperty('ART_HISTORY') || '[]');
    } catch (e) {
      Logger.log('⚠️ ART_HISTORY unreadable, starting fresh');
    }

    const context = buildArtContext(new Date(), weather, lat, lon, history);
    Logger.log('🖼️ Context:\n' + context);

    const spec = generateDailyArt(apiKey, context);
    Logger.log(`🎨 "${spec.title}" — ${spec.caption || ''}`);
    Logger.log(`🗂️ ${spec.ops.length} ops — ${spec.style || ''}`);

    const payload = renderDailyArtReceipt(spec, new Date());
    if (DRY_RUN) {
      Logger.log('--- DRY RUN ---\n' + JSON.stringify(spec, null, 2));
      return;
    }

    if (callWithRetry(() => sendToPi(payload)) !== true) {
      throw new Error('Print failed after retries');
    }
    props.setProperty('LAST_ART_DATE', today);
    if (spec.continues) Logger.log('🔗 Continues ' + spec.continues);
    const entry: ArtHistoryEntry = {
      d: today,
      title: spec.title,
      style: spec.style || '',
    };
    if (spec.continues) entry.c = spec.continues;
    history.push(entry);
    while (history.length > HISTORY_LIMIT) history.shift();
    props.setProperty('ART_HISTORY', JSON.stringify(history));
    Logger.log('✅ Daily art printed.');
  } catch (e) {
    Logger.log('💥 [Daily Art Error] ' + e);
    sendAlertEmail('Daily Art Failed', String(e));
  } finally {
    lock.releaseLock();
  }
}

// Hardware/layout smoke test — renders the golden spec, zero API cost.
// Run from the Apps Script editor.
export function testDailyArt(): void {
  Logger.log('🧪 Printing golden art spec...');
  sendToPi(renderDailyArtReceipt(GOLDEN_ART_SPEC, new Date()));
  Logger.log('✅ Golden art sent.');
}
