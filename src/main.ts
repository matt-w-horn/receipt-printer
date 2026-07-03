// Entry points. esbuild bundles the whole import graph into one dist/main.gs; the
// build footer re-exposes the trigger/editor functions below as top-level globals
// so Apps Script can call them by bare name. Keep this list in sync with
// ENTRY_POINTS in build.js.
//
// The pure art builders (renderArtSpec, buildArtContext, …) are exported for
// the local test harness (test-print.mjs), not as Apps Script globals.

export {
  printDailyArt,
  testDailyArt,
  renderArtSpec,
  renderDailyArtReceipt,
  buildArtContext,
  buildArtRequestBody,
  parseArtResponse,
  GOLDEN_ART_SPEC,
} from './art';
