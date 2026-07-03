// Shared ESC/POS command table and low-level helpers.
//
// The printer is an Epson TM-T20III (80mm, CP437). Every entry below is a raw
// byte sequence; see docs/epson-tm-t20iii-technical-reference-guide.pdf. Keep the
// byte values verbatim — they are not arbitrary.

// Printer geometry. This TM-T20III runs in standard 48-column mode — confirmed
// with `node test-print.mjs ruler` (a 48-char Font A line and a 64-char Font B
// line each fit without wrapping). The legacy calendar/briefing layouts wrap at
// 42 and simply leave a margin. Re-verify with the ruler if reconfigured.
export const COLS_A = 48;
export const COLS_B = 64;

// ESC 3 n values for gapless block art (one glyph height, so rows tile with no
// white seam). Calibrated empirically with the ruler page's ▀-stripe test:
// n = 24, 43, and 48 all rendered identical clean stripes, which means this
// firmware clamps line spacing UP to the print-data height when the set value
// is smaller — under-height values can never overlap rows, and these
// glyph-height values are exactly gapless under any motion-unit interpretation.
export const ROW_DOTS_A = 24; // one Font A row (24 dots tall)
export const ROW_DOTS_B = 17; // one Font B row (17 dots tall)

export const CMD = {
  INIT: [0x1b, 0x40],
  CP437: [0x1b, 0x74, 0x00],

  ALIGN_CENTER: [0x1b, 0x61, 0x01],
  ALIGN_LEFT: [0x1b, 0x61, 0x00],
  ALIGN_RIGHT: [0x1b, 0x61, 0x02],

  BOLD_ON: [0x1b, 0x45, 0x01],
  BOLD_OFF: [0x1b, 0x45, 0x00],

  UNDERLINE_ON: [0x1b, 0x2d, 0x01],
  UNDERLINE_2_ON: [0x1b, 0x2d, 0x02],
  UNDERLINE_OFF: [0x1b, 0x2d, 0x00],

  FONT_A: [0x1b, 0x4d, 0x00], // 12x24, COLS_A columns
  FONT_B: [0x1b, 0x4d, 0x01], // 9x17, COLS_B columns (denser texture)

  UPSIDE_DOWN_ON: [0x1b, 0x7b, 0x01],
  UPSIDE_DOWN_OFF: [0x1b, 0x7b, 0x00],

  INVERT_ON: [0x1d, 0x42, 0x01], // White text on black background
  INVERT_OFF: [0x1d, 0x42, 0x00],

  // Font Sizes
  SIZE_NORMAL: [0x1d, 0x21, 0x00], // Fits ~48 Chars
  SIZE_DOUBLE_HEIGHT: [0x1d, 0x21, 0x01], // Fits ~48 Chars (Tall)
  SIZE_2X: [0x1d, 0x21, 0x11], // Fits ~24 Chars (Big)

  // Generalized GS ! n — independent width/height multipliers, 1..8 each.
  // A width-w line fits floor(columns / w) characters.
  SIZE: (w: number, h: number): number[] => {
    const cw = Math.min(8, Math.max(1, Math.round(w || 1)));
    const ch = Math.min(8, Math.max(1, Math.round(h || 1)));
    return [0x1d, 0x21, ((cw - 1) << 4) | (ch - 1)];
  },

  FEED_LINES: (n: number): number[] => [0x1b, 0x64, n],
  CUT_PAPER: [0x1d, 0x56, 0x42, 0x00],

  // Line Spacing
  SET_LINE_SPACING: (n: number): number[] => [0x1b, 0x33, n],
  RESET_LINE_SPACING: [0x1b, 0x32],

  GET_BORDER_TOP: function (): number[] {
    const line = [0xc9];
    for (let i = 0; i < 40; i++) line.push(0xcd);
    line.push(0xbb);
    line.push(0x0a);
    return line;
  },

  GET_BORDER_BOTTOM: function (): number[] {
    const line = [0xc8];
    for (let i = 0; i < 40; i++) line.push(0xcd);
    line.push(0xbc);
    line.push(0x0a);
    return line;
  },
};

// Map a string to its raw byte sequence (one byte per UTF-16 code unit). The
// caller is responsible for staying within the printer's CP437 code page.
// Frozen for the legacy calendar/briefing payloads — new code uses encodeCP437.
export function stringToBytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));
  return bytes;
}

// Unicode → CP437 byte map for everything beyond printable ASCII that the
// TM-T20III can render. CP437's 0x01–0x1F "glyphs" (☺♥ etc.) are unreachable —
// ESC/POS interprets those bytes as control codes — so they are not mapped.
const CP437_MAP: { [ch: string]: number } = {
  // Shading + blocks
  '░': 0xb0,
  '▒': 0xb1,
  '▓': 0xb2,
  '█': 0xdb,
  '▄': 0xdc,
  '▌': 0xdd,
  '▐': 0xde,
  '▀': 0xdf,
  '■': 0xfe,
  // Box drawing — single
  '─': 0xc4,
  '│': 0xb3,
  '┌': 0xda,
  '┐': 0xbf,
  '└': 0xc0,
  '┘': 0xd9,
  '├': 0xc3,
  '┤': 0xb4,
  '┬': 0xc2,
  '┴': 0xc1,
  '┼': 0xc5,
  // Box drawing — double
  '═': 0xcd,
  '║': 0xba,
  '╔': 0xc9,
  '╗': 0xbb,
  '╚': 0xc8,
  '╝': 0xbc,
  '╠': 0xcc,
  '╣': 0xb9,
  '╦': 0xcb,
  '╩': 0xca,
  '╬': 0xce,
  // Box drawing — mixed single/double connectors
  '╒': 0xd5,
  '╓': 0xd6,
  '╕': 0xb8,
  '╖': 0xb7,
  '╘': 0xd4,
  '╙': 0xd3,
  '╛': 0xbe,
  '╜': 0xbd,
  '╞': 0xc6,
  '╟': 0xc7,
  '╡': 0xb5,
  '╢': 0xb6,
  '╤': 0xd1,
  '╥': 0xd2,
  '╧': 0xcf,
  '╨': 0xd0,
  '╪': 0xd8,
  '╫': 0xd7,
  // Symbols
  '°': 0xf8,
  '·': 0xfa,
  '∙': 0xf9,
  '•': 0xf9,
  '√': 0xfb,
  '±': 0xf1,
  '≈': 0xf7,
  '∞': 0xec,
  '²': 0xfd,
  ⁿ: 0xfc,
  '÷': 0xf6,
  '≥': 0xf2,
  '≤': 0xf3,
  '≡': 0xf0,
  '∩': 0xef,
  '⌐': 0xa9,
  '¬': 0xaa,
  '½': 0xab,
  '¼': 0xac,
  '¡': 0xad,
  '¿': 0xa8,
  '«': 0xae,
  '»': 0xaf,
  '¢': 0x9b,
  '£': 0x9c,
  '¥': 0x9d,
  '₧': 0x9e,
  ƒ: 0x9f,
  ª: 0xa6,
  º: 0xa7,
  '⌠': 0xf4,
  '⌡': 0xf5,
  // Greek (the CP437 subset)
  α: 0xe0,
  ß: 0xe1,
  β: 0xe1,
  Γ: 0xe2,
  π: 0xe3,
  Σ: 0xe4,
  σ: 0xe5,
  µ: 0xe6,
  μ: 0xe6,
  τ: 0xe7,
  Φ: 0xe8,
  Θ: 0xe9,
  θ: 0xe9,
  Ω: 0xea,
  δ: 0xeb,
  φ: 0xed,
  ε: 0xee,
  // Accented latin
  Ç: 0x80,
  ü: 0x81,
  é: 0x82,
  â: 0x83,
  ä: 0x84,
  à: 0x85,
  å: 0x86,
  ç: 0x87,
  ê: 0x88,
  ë: 0x89,
  è: 0x8a,
  ï: 0x8b,
  î: 0x8c,
  ì: 0x8d,
  Ä: 0x8e,
  Å: 0x8f,
  É: 0x90,
  æ: 0x91,
  Æ: 0x92,
  ô: 0x93,
  ö: 0x94,
  ò: 0x95,
  û: 0x96,
  ù: 0x97,
  ÿ: 0x98,
  Ö: 0x99,
  Ü: 0x9a,
  á: 0xa0,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  ñ: 0xa4,
  Ñ: 0xa5,
};

// Encode a string as CP437 printer bytes. Printable ASCII passes through, the
// table above translates the CP437 extended set, common typographic characters
// are normalized to ASCII, '\n' survives as a line feed, other control chars
// are dropped, and anything else prints as '?' (visible but harmless).
export function encodeCP437(str: string): number[] {
  const normalized = String(str)
    .replace(/[\u2018\u2019\u02bc]/g, "'") // curly/modifier apostrophes
    .replace(/[\u201c\u201d]/g, '"') // curly quotes
    .replace(/[\u2010-\u2015\u2212]/g, '-') // hyphens, en/em dashes, minus
    .replace(/\u2026/g, '...') // ellipsis
    .replace(/\u00a0/g, ' '); // nbsp

  const bytes: number[] = [];
  for (const ch of normalized) {
    const code = ch.codePointAt(0) as number;
    if (code === 0x0a) bytes.push(0x0a);
    else if (code >= 0x20 && code <= 0x7e) bytes.push(code);
    else if (CP437_MAP[ch] !== undefined) bytes.push(CP437_MAP[ch]);
    else if (code < 0x20 || code === 0x7f)
      continue; // control chars: drop
    else bytes.push(0x3f); // '?'
  }
  return bytes;
}
