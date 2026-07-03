# ESC/POS Protocol Spec — Epson TM-T20III

The complete wire protocol this project speaks, from HTTP request down to
printer dots. This replaces the bundled Epson Technical Reference Guide PDF: it
documents every command the code actually sends (the `CMD` table in
[`src/escpos.ts`](../src/escpos.ts)), the character encoding, the printer
geometry, and the behaviors that were confirmed empirically on this unit.
Semantics follow Epson's published ESC/POS reference; where this printer's
observed behavior matters (line-spacing clamping, column mode), the calibration
result is stated explicitly.

**Layers, top to bottom:**

```
HTTP POST (octet-stream, basic auth)      — transport to the Pi bridge
  └─ ESC/POS byte stream                  — commands + text, one buffer
      └─ CP437 code page                  — one byte per printed character
          └─ Epson TM-T20III              — 203 dpi thermal, 80mm roll
```

---

## 1. Transport: the Pi print bridge

The printer itself has no network protocol in this system — a Raspberry Pi
bridges HTTP to the USB character device (see
[`pi-print-server-runbook.md`](pi-print-server-runbook.md)).

| Aspect       | Value                                                            |
| ------------ | ---------------------------------------------------------------- |
| Method       | `POST` to `PI_URL` (ngrok static domain)                         |
| Auth         | HTTP Basic (`NGROK_USER` / `NGROK_PASS`), enforced by ngrok      |
| Content-Type | `application/octet-stream`                                       |
| Body         | the raw ESC/POS byte stream, verbatim — no framing, no wrapper   |
| `200`        | bytes were written to `/dev/usb/lp0`                             |
| `401`        | bad basic-auth credentials                                       |
| `502`        | tunnel up, Python server down (`sudo systemctl restart printer`) |

There is **no acknowledgment from the printer** — a `200` means the Pi wrote
the bytes to the device, not that paper came out. The printer consumes the
stream and prints; malformed streams print garbage rather than erroring.

End-to-end test from any machine:

```bash
printf "\x1B\x40SYSTEM ONLINE\x0A\x0A\x0A\x1D\x56\x42\x00" \
  | curl -u "<NGROK_USER>:<NGROK_PASS>" -X POST --data-binary @- "$PI_URL"
```

**Apps Script quirk:** `sendToPi` (`src/transport.ts`) converts values ≥ 128 to
signed bytes (`val - 256`) before `Utilities.newBlob` — the Blob API takes
signed 8-bit ints. The bytes on the wire are identical; leave the conversion
alone.

---

## 2. Printer geometry (this unit)

| Property          | Value                                              |
| ----------------- | -------------------------------------------------- |
| Model             | Epson TM-T20III, USB, auto partial cutter          |
| Resolution        | 203 dpi (≈ 8 dots/mm)                              |
| Paper             | 80 mm roll; ≈ 72 mm printable ≈ **576 dots** wide  |
| Font A glyph      | 12 × 24 dots → **48 columns** (`COLS_A`)           |
| Font B glyph      | 9 × 17 dots → **64 columns** (`COLS_B`)            |
| Font A row height | 24 dots (`ROW_DOTS_A`)                             |
| Font B row height | 17 dots (`ROW_DOTS_B`)                             |
| Color             | 1-bit black. No grayscale — texture is characters. |

This unit runs in the printer's standard 48-column mode, **confirmed with
`node test-print.mjs ruler`**: a 48-character Font A line and a 64-character
Font B line each fit without wrapping. (The TM-T20III can be reconfigured into
a 42-column emulation mode; if the printer is ever reset, re-run the ruler and
recalibrate `COLS_A`/`COLS_B`.)

---

## 3. Byte-stream rules

- The stream mixes **commands and text**. Bytes `0x20`–`0x7E` and `0x80`–`0xFF`
  print as CP437 characters; `LF` (`0x0A`) prints the buffered line and feeds;
  `ESC` (`0x1B`) and `GS` (`0x1D`) introduce commands.
- **Bytes `0x00`–`0x1F` are control codes, not glyphs.** CP437's smiley-face
  range is unreachable — the renderer strips those from incoming text
  (`renderArtSpec`) so stray control characters can't be interpreted as
  commands.
- The printer is **line-buffered**: text accumulates until a `LF` (or a feed
  command) prints the line. Style commands take effect for characters buffered
  _after_ them.
- Some commands are only honored **at the start of a line** (justification,
  upside-down mode). Send them before any text on that line.
- Settings are **sticky** until changed or reset (`ESC @`). The art renderer
  therefore emits a full style prelude for every op and restores defaults at
  the end — byte-predictable output, no state diffing.

---

## 4. Command reference

Every command the project sends. Hex as it appears on the wire; names match
the `CMD` table in `src/escpos.ts`.

### Quick reference

| `CMD` name               | Bytes (hex)       | ESC/POS    | Effect                             |
| ------------------------ | ----------------- | ---------- | ---------------------------------- |
| `INIT`                   | `1B 40`           | `ESC @`    | Reset printer state                |
| `CP437`                  | `1B 74 00`        | `ESC t 0`  | Select code page 0 (PC437)         |
| `ALIGN_LEFT`             | `1B 61 00`        | `ESC a 0`  | Left-justify                       |
| `ALIGN_CENTER`           | `1B 61 01`        | `ESC a 1`  | Center                             |
| `ALIGN_RIGHT`            | `1B 61 02`        | `ESC a 2`  | Right-justify                      |
| `BOLD_ON` / `BOLD_OFF`   | `1B 45 01` / `00` | `ESC E n`  | Emphasized mode                    |
| `UNDERLINE_ON`           | `1B 2D 01`        | `ESC - 1`  | 1-dot underline                    |
| `UNDERLINE_2_ON`         | `1B 2D 02`        | `ESC - 2`  | 2-dot underline                    |
| `UNDERLINE_OFF`          | `1B 2D 00`        | `ESC - 0`  | Underline off                      |
| `FONT_A` / `FONT_B`      | `1B 4D 00` / `01` | `ESC M n`  | Select font A (12×24) / B (9×17)   |
| `UPSIDE_DOWN_ON`/`OFF`   | `1B 7B 01` / `00` | `ESC { n`  | Rotate each line 180°              |
| `INVERT_ON`/`INVERT_OFF` | `1D 42 01` / `00` | `GS B n`   | White-on-black printing            |
| `SIZE(w, h)`             | `1D 21 n`         | `GS ! n`   | Glyph scaling, 1–8× each axis      |
| `SIZE_NORMAL`            | `1D 21 00`        | `GS ! 0`   | 1×1 (preset)                       |
| `SIZE_DOUBLE_HEIGHT`     | `1D 21 01`        | `GS ! 1`   | 1×2 (preset)                       |
| `SIZE_2X`                | `1D 21 11`        | `GS ! 17`  | 2×2 (preset)                       |
| `SET_LINE_SPACING(n)`    | `1B 33 n`         | `ESC 3 n`  | Line spacing = n units             |
| `RESET_LINE_SPACING`     | `1B 32`           | `ESC 2`    | Default spacing (≈ 1/6")           |
| `FEED_LINES(n)`          | `1B 64 n`         | `ESC d n`  | Print buffer, feed n lines         |
| `CUT_PAPER`              | `1D 56 42 00`     | `GS V B 0` | Feed to cutter, partial cut        |
| _(text)_                 | `0A`              | `LF`       | Print buffered line, feed one line |

### Initialization

- **`ESC @` — initialize** (`1B 40`)
  Clears the print buffer and resets all modes (font, size, style, alignment,
  line spacing, code page) to power-on defaults. Does not feed or cut. Every
  receipt starts with this so nothing leaks from the previous print.

- **`ESC t n` — select character code table** (`1B 74 n`)
  `n = 0` selects page 0, **PC437** (USA / Standard Europe) — the code page
  the whole project assumes (§5). Sent immediately after `INIT` on every
  receipt.

### Layout

- **`ESC a n` — justification** (`1B 61 n`; `0` left, `1` center, `2` right)
  Aligns each printed line within the 576-dot printable width. **Only honored
  at the start of a line.** The art renderer defaults to center.

- **`ESC M n` — font select** (`1B 4D n`; `0` Font A, `1` Font B)
  Font A: 12×24 glyphs, 48 columns — the default. Font B: 9×17 glyphs,
  64 columns — smaller type and finer texture for art (a Font B checkerboard
  has ~1.8× the spatial frequency of Font A's).

- **`GS ! n` — character size** (`1D 21 n`)
  Independent width/height magnification. High nibble = width − 1, low nibble
  = height − 1, each 0–7 (so 1–8×): `n = ((w−1) << 4) | (h−1)`.
  `CMD.SIZE(w, h)` computes and clamps this. A width-`w` line fits
  `floor(columns / w)` characters; the art renderer truncates to that budget.
  Scaling is per-character cell — an 8×8 Font A glyph is 96×192 dots.

- **`ESC { n` — upside-down mode** (`1B 7B n`; LSB on/off)
  Rotates each line 180° (line start only). In the table for completeness;
  the current renderer doesn't use it.

### Style

- **`ESC E n` — emphasized (bold)** (`1B 45 n`; LSB on/off)
  Thickens strokes by one dot. Subtle at 1×, strong on scaled-up type.

- **`ESC - n` — underline** (`1B 2D n`; `0` off, `1` 1-dot, `2` 2-dot)
  Underlines characters _and_ spaces of the line. Per Epson's spec, underline
  is **not applied to white/black-inverted characters** — don't combine
  `underline` with `invert` and expect both.

- **`GS B n` — white/black reverse (invert)** (`1D 42 n`; LSB on/off)
  Prints white glyphs on a black cell background. **Spaces print as solid
  black cells** — an inverted run of spaces is a solid black band, which is
  how the art gets night skies and heavy banners. Trailing spaces matter:
  pad inverted rows to full width or the band stops early.

### Line spacing & feeding

- **`ESC 3 n` — set line spacing** (`1B 33 n`, `n` = 0–255 vertical motion
  units)
  Sets the feed distance per `LF`. The default (`ESC 2`, ≈ 1/6 inch) leaves a
  white gap between 24-dot Font A rows — correct for text, fatal for block
  art. See §6 for the gapless calibration result on this unit.

- **`ESC 2` — default line spacing** (`1B 32`)
  Restores the default (readable-text) spacing. The renderer emits this after
  every gapless op and at the end of every receipt.

- **`LF`** (`0x0A`)
  Prints the buffered line and advances one line (current line spacing).

- **`ESC d n` — print and feed n lines** (`1B 64 n`)
  Prints the buffer, then feeds `n` lines at the current spacing. Used for
  blank space (`feedAfter`, header/footer breathing room).

### Cutting

- **`GS V B n` — feed and partial cut** (`1D 56 42 n`)
  Function B: feeds the paper to the cutting position plus `n` motion units,
  then performs a partial cut (one point uncut, so the receipt hangs rather
  than falls). `n = 0` cuts right at the cut position. The feed matters: the
  cutter sits above the print head, so cutting without feeding would slice
  through the last-printed lines.

---

## 5. Character encoding: CP437

`ESC t 0` puts the printer on code page 437. One byte per glyph:

| Byte range    | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `0x00`–`0x1F` | Control codes — **not printable** (CP437's ☺♥ glyphs are unreachable over ESC/POS) |
| `0x20`–`0x7E` | Printable ASCII, 1:1                                                               |
| `0x7F`        | Control (DEL) — stripped                                                           |
| `0x80`–`0xFF` | CP437 extended set: blocks, box drawing, symbols, accented Latin, Greek            |

All printed text goes through **`encodeCP437`** (`src/escpos.ts`), which maps
Unicode to these bytes:

- **Shading & blocks:** `░ ▒ ▓ █ ▄ ▌ ▐ ▀ ■` → `B0 B1 B2 DB DC DD DE DF FE` —
  the art's entire tonal range.
- **Box drawing:** full single (`─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`), double
  (`═ ║ ╔ ╗ ╚ ╝ ╠ ╣ ╦ ╩ ╬`), and mixed single/double connector sets.
- **Symbols:** `° · ∙ • √ ± ≈ ∞ ² ⁿ ÷ ≥ ≤ ≡ ∩ ⌐ ¬ ½ ¼ ¡ ¿ « » ¢ £ ¥ ₧ ƒ ª º ⌠ ⌡`
- **Greek subset:** `α ß Γ π Σ σ µ τ Φ Θ Ω δ φ ε` (plus lookalikes β→ß, θ→Θ,
  μ→µ).
- **Accented Latin:** the CP437 set (`é è ê ë à â ä å ç ñ ö ü …`).
- **Normalizations before mapping:** curly quotes → `'`/`"`, en/em dashes and
  minus → `-`, ellipsis → `...`, NBSP → space.
- **Everything else:** control characters are dropped; any other unmapped
  character prints as `?` — visible but harmless, never misinterpreted as a
  command.

The build preserves these mappings end to end: `build.js` bundles with
`charset: 'utf8'` so multi-byte source literals (like `°`) survive into
`dist/main.gs`.

---

## 6. Gapless block art (calibration result)

The signature trick of the art renderer: with default line spacing, stacked
`░▒▓█` rows show white seams; setting line spacing to exactly one glyph height
makes rows tile into contiguous fields.

Empirical result from this unit's ruler page (`node test-print.mjs ruler`,
▀-stripe test — `▀` is half-black, so any gap or overlap between rows is
immediately visible):

- `ESC 3 n` with **n = 24, 43, and 48 all rendered identical, clean, gapless
  stripes** for 24-dot Font A rows.
- Conclusion: **this firmware clamps line spacing _up_ to the print-data
  height** when the set value is smaller. An under-height value can never
  overlap rows.
- Therefore the renderer uses `n` = one glyph height — `ROW_DOTS_A = 24` for
  Font A, `ROW_DOTS_B = 17` for Font B, multiplied by the op's height
  multiplier (capped at 255) — which is exactly gapless under any
  motion-unit interpretation.

The renderer sets `ESC 3` only for ops marked `gapless: true` and resets with
`ESC 2` afterward; readable text keeps the default spacing.

---

## 7. Worked example

The `hello` mode payload from `test-print.mjs`, annotated:

```
1B 40                    ESC @        initialize
1B 74 00                 ESC t 0      code page → CP437
53 59 53 54 45 4D 20     "SYSTEM "    ASCII text (buffered)
4F 4E 4C 49 4E 45        "ONLINE"
0A                       LF           print the line
0A 0A                    LF LF        two blank lines
1D 56 42 00              GS V B 0     feed to cutter, partial cut
```

And the style prelude the art renderer emits for every op, in order:

```
ESC a n     alignment            (default center)
ESC M n     font A/B
GS  ! n     width/height 1–8×
ESC E n     bold on/off
GS  B n     invert on/off
ESC - n     underline on/off
ESC 3 n | ESC 2    gapless spacing or default
...text rows (encodeCP437 + LF each)...
ESC d n     feedAfter blank lines (if any)
```

Every op re-states all seven settings — no reliance on printer state — and the
receipt ends by restoring defaults, feeding, and cutting.
