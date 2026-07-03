// Entry points. esbuild bundles the whole import graph into one dist/main.gs; the
// build footer re-exposes the trigger/editor functions below as top-level globals
// so Apps Script can call them by bare name. Keep this list in sync with
// ENTRY_POINTS in build.js.
//
// generateReceiptPayload / buildDeepReceipt are exported for the local test
// harness (test-print.mjs), not as Apps Script globals.

export { checkAndPrintRobust, testPrinter, generateReceiptPayload } from './calendar';
export { printAIMorningBriefing, buildDeepReceipt } from './briefing';
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
