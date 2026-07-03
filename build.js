// Bundles the TypeScript source into a single Apps Script file.
//
// Apps Script has no module system and calls trigger/editor functions by their
// bare global name. esbuild bundles everything into one IIFE — resolving the
// import graph — and the footer below re-exposes the entry points as top-level
// globals so the runtime and editor can find them. treeShaking is off so
// nothing in src/ is silently dropped.

import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

// Names that must survive bundling as bare globals: the trigger handlers and the
// editor-run test. Keep in sync with the re-exports in src/main.ts.
const ENTRY_POINTS = ['printDailyArt', 'testDailyArt'];

const GLOBAL = '__receipt';

const footer = ENTRY_POINTS.map(
  (name) => `function ${name}() { return ${GLOBAL}.${name}.apply(this, arguments); }`,
).join('\n');

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.gs',
  bundle: true,
  format: 'iife',
  globalName: GLOBAL,
  target: 'es2020',
  charset: 'utf8', // preserve ° / box-drawing bytes and emoji in log strings
  legalComments: 'none',
  treeShaking: false, // keep every function in src/ in the bundle
  footer: { js: footer },
  logLevel: 'info',
});

if (existsSync('src/appsscript.json')) {
  copyFileSync('src/appsscript.json', 'dist/appsscript.json');
  console.log('Copied appsscript.json -> dist/');
}

console.log(`Build complete: dist/main.gs (globals: ${ENTRY_POINTS.join(', ')})`);
