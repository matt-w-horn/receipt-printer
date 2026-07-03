# Contributing

## Setup

```bash
git clone https://github.com/matt-w-horn/receipt-printer.git
cd receipt-printer
npm install
npm run build      # tsc --noEmit + esbuild bundle -> dist/main.gs
```

You don't need the printer or a Pi to work on most of this. `node
test-print.mjs art --dry` renders the golden art spec through the real
production renderer and prints the ESC/POS payload as hex — that's the
fastest way to see the effect of a renderer change. With hardware, drop
`--dry` and it prints (credentials go in `.env`; copy `.env.example`).

## Working with Claude Code

This repo is built for it. Start Claude Code in the repo root:

```bash
claude
```

It reads [`CLAUDE.md`](CLAUDE.md) automatically — the architecture, the deploy
ritual, and the gotchas that matter (byte-exact ESC/POS, the CP437 encoding
rules, which functions must stay pure for the test harness). The repo also
ships two skills in `.claude/skills/` that Claude Code picks up on its own:
the Apps Script deploy ritual and a prose style guide for docs. No install
step for any of it. A good first prompt:

> Read CLAUDE.md and docs/escpos-protocol.md, then walk me through how an art
> spec becomes bytes on paper. Use `node test-print.mjs art --dry` to show me.

The two docs worth knowing before touching anything:

- [`docs/escpos-protocol.md`](docs/escpos-protocol.md) — every byte this
  project sends, with calibration results. Spec new commands here before code
  emits them.
- [`docs/pi-print-server-runbook.md`](docs/pi-print-server-runbook.md) — the
  receiving end (Pi + ngrok + systemd).

## Before you open a PR

- `npm run build` passes (typecheck + bundle)
- `npm run format` (CI runs `prettier --check`)
- No secrets anywhere — keys live in Script Properties or a gitignored `.env`,
  never in code, docs, or history. gitleaks runs in CI; there's an optional
  pre-commit hook in `.pre-commit-config.yaml`.
- Renderer or prompt changes: include a `--dry` hex diff or a photo of a real
  print. Byte output is the product; prose descriptions of it don't review well.

Bigger ideas (raster graphics, evals, deploy tooling) are mapped out in the
[roadmap issues](https://github.com/matt-w-horn/receipt-printer/issues) —
comment there before building so we don't collide.
