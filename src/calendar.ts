// Calendar → receipt. A daily-ish time trigger runs checkAndPrintRobust(), which
// scans a Google Calendar and prints each new event, plus the shared transport
// (sendToPi) that both this and the briefing use.

import { CMD, stringToBytes } from './escpos';

// --- CONFIGURATION ---
// CALENDAR_ID (which calendar to print) and EMAIL_ALERTS_TO (where failure alerts
// go) are read from Script Properties at runtime — not hardcoded here, so no PII
// lives in the repo. Set them in the Apps Script editor → Project Settings.
const MAX_RETRIES = 3;

// --- TIME WINDOW SETTINGS ---
const LOOKBACK_HOURS = 12;

// The subset of a CalendarEvent this module needs. Real CalendarApp events and
// the testPrinter() mocks both satisfy it structurally.
export interface ReceiptEvent {
  getId(): string;
  getTitle(): string;
  getDescription(): string | null;
  getStartTime(): Date;
  isAllDayEvent(): boolean;
}

export function checkAndPrintRobust(): void {
  Logger.log('🔒 [System] Attempting to acquire script lock...');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return;
  }

  try {
    const now = new Date();
    const scriptProperties = PropertiesService.getScriptProperties();

    const calendarId = scriptProperties.getProperty('CALENDAR_ID');
    if (!calendarId) throw new Error('Missing CALENDAR_ID in Script Properties');

    const memory = JSON.parse(
      scriptProperties.getProperty('PRINT_MEMORY') || '{"printedEventIds":[]}',
    );

    const timeWindowStart = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
    const timeWindowEnd =
      now.getHours() >= 6
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
        : now;

    const calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) {
      throw new Error('Calendar not found — check the CALENDAR_ID Script Property');
    }

    const events = calendar.getEvents(
      timeWindowStart,
      timeWindowEnd,
    ) as unknown as ReceiptEvent[];

    Logger.log(
      `📅 Found ${events.length} event(s) in window ` +
        `${timeWindowStart.toLocaleString()} → ${timeWindowEnd.toLocaleString()}`,
    );

    let printed = 0;
    events.forEach((event) => {
      const eventId = event.getId() + '_' + event.getStartTime().getTime();
      if (memory.printedEventIds.includes(eventId)) {
        Logger.log(`⏭️ Skip (already printed): ${event.getTitle()}`);
        return;
      }

      const startTime = event.getStartTime();
      const shouldPrint =
        event.isAllDayEvent() ||
        (startTime >= timeWindowStart && startTime <= timeWindowEnd);

      if (!shouldPrint) {
        Logger.log(`⏭️ Skip (outside window): ${event.getTitle()}`);
        return;
      }

      const binaryPayload = generateReceiptPayload(event);
      const printSuccess = callWithRetry(() => sendToPi(binaryPayload));

      if (printSuccess) {
        Logger.log(`✅ Printed: ${event.getTitle()}`);
        printed++;
        memory.printedEventIds.push(eventId);
        if (memory.printedEventIds.length > 100) memory.printedEventIds.shift();
        scriptProperties.setProperty('PRINT_MEMORY', JSON.stringify(memory));
        Utilities.sleep(2000);
      } else {
        throw new Error(`Failed to print '${event.getTitle()}'`);
      }
    });

    Logger.log(`🏁 Done. Printed ${printed} new receipt(s).`);
  } catch (e) {
    Logger.log('💥 [Critical Error] ' + e.toString());
    sendAlertEmail('Printing Failed', e.toString());
  } finally {
    lock.releaseLock();
  }
}

// --- HELPER: GENERATE RECEIPT ---
export function generateReceiptPayload(event: ReceiptEvent): number[] {
  let payload: number[] = [];

  const now = new Date();
  const dateString = now
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase();
  const timeHeader = event.isAllDayEvent()
    ? 'ALL DAY'
    : event.getStartTime().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // --- CLEAN DESCRIPTION ---
  const rawDesc = event.getDescription() || '';
  const cleanDesc = rawDesc
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>?/gm, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\[\s*\]/g, '\n[ ] ') // Ensure newline before checkboxes
    .replace(/\n\s*\n/g, '\n') // Collapse empty lines
    .trim();

  // --- BUILD RECEIPT ---

  // 1. Init
  payload = payload.concat(CMD.INIT);
  payload = payload.concat(CMD.CP437);
  payload = payload.concat(CMD.ALIGN_CENTER);

  // 2. Top Border
  payload = payload.concat(CMD.GET_BORDER_TOP());

  // 3. Header
  payload = payload.concat(CMD.INVERT_ON);
  payload = payload.concat(stringToBytes(' ' + dateString + ' - ' + timeHeader + ' \n'));
  payload = payload.concat(CMD.INVERT_OFF);

  // 4. TITLE
  payload = payload.concat(CMD.FEED_LINES(1));
  payload = payload.concat(CMD.SIZE_2X);

  const titleLines = wrapText(event.getTitle().toUpperCase(), 24);
  titleLines.forEach((line) => {
    payload = payload.concat(stringToBytes(line + '\n'));
  });

  payload = payload.concat(CMD.SIZE_NORMAL);
  payload = payload.concat(CMD.FEED_LINES(1));

  // 5. Bottom Border
  payload = payload.concat(CMD.GET_BORDER_BOTTOM());

  // 6. Description Logic
  if (cleanDesc.length > 0) {
    payload = payload.concat(CMD.FEED_LINES(1));
    payload = payload.concat(CMD.ALIGN_LEFT);
    payload = payload.concat(CMD.SET_LINE_SPACING(100)); // Wide spacing for Double Height

    // Split paragraphs first to preserve intended structure
    const paragraphs = cleanDesc.split('\n');

    paragraphs.forEach((paragraph) => {
      const line = paragraph.trim();
      if (line.length === 0) return;

      // --- CHECKBOX LOGIC ---
      if (line.indexOf('[ ]') === 0) {
        // This is a checkbox line.
        // Strip the "[ ]" prefix to handle the text separately
        const itemText = line.substring(3).trim();

        // Wrap the Item Text aggressively (30 chars) to account for the wide Checkbox
        const wrappedLines = wrapText(itemText, 30);

        wrappedLines.forEach((wLine, index) => {
          if (index === 0) {
            // First line: Print Checkbox (2X Bold) + First part of text (Double Height Bold)
            payload = payload.concat(CMD.SIZE_2X);
            payload = payload.concat(CMD.BOLD_ON);
            payload = payload.concat(stringToBytes('[ ]')); // Icon

            payload = payload.concat(CMD.SIZE_DOUBLE_HEIGHT);

            payload = payload.concat(CMD.BOLD_OFF);
            // Keep Bold ON for the item header
            payload = payload.concat(stringToBytes(' ' + wLine + '\n'));
          } else {
            // Subsequent wrapped lines: Indent slightly, Double Height, No Bold
            payload = payload.concat(CMD.SIZE_DOUBLE_HEIGHT);
            payload = payload.concat(stringToBytes('    ' + wLine + '\n'));
          }
        });
      } else {
        // --- STANDARD TEXT LOGIC ---
        // Just wrap to 42 chars and print Double Height
        const wrappedLines = wrapText(line, 42);
        wrappedLines.forEach((wLine) => {
          payload = payload.concat(CMD.SIZE_DOUBLE_HEIGHT);
          payload = payload.concat(stringToBytes(wLine + '\n'));
        });
      }
    });

    payload = payload.concat(CMD.SIZE_NORMAL);
    payload = payload.concat(CMD.RESET_LINE_SPACING);
  }

  // 7. Feed & Cut
  payload = payload.concat(CMD.FEED_LINES(2)); // Padding restored
  payload = payload.concat(CMD.CUT_PAPER);

  return payload;
}

// --- UTILITY: WORD WRAPPER ---
// This variant breaks words longer than maxChars; the briefing module has its
// own (simpler) wrapText. They used to collide in Apps Script's shared global
// scope; module scope now keeps each caller on its own — see CLAUDE.md.
function wrapText(text: string, maxChars: number): string[] {
  const resultLines: string[] = [];
  // Note: We only wrap single paragraphs here because the main loop handles \n splitting
  const words = text.split(' ');
  let currentLine = '';

  words.forEach((word) => {
    const spaceNeeded = currentLine.length > 0 ? 1 : 0;
    if (currentLine.length + spaceNeeded + word.length <= maxChars) {
      currentLine += (currentLine.length > 0 ? ' ' : '') + word;
    } else {
      if (currentLine.length > 0) resultLines.push(currentLine);
      currentLine = word;
      while (currentLine.length > maxChars) {
        resultLines.push(currentLine.slice(0, maxChars));
        currentLine = currentLine.slice(maxChars);
      }
    }
  });
  if (currentLine.length > 0) resultLines.push(currentLine);

  return resultLines;
}

// --- UTILITY: COMMUNICATIONS ---
// Shared transport: the single sink for every payload. Imported by the briefing.
export function sendToPi(byteArray: number[]): boolean {
  if (!byteArray || !Array.isArray(byteArray) || byteArray.length === 0) {
    Logger.log('⚠️ Error: Payload is empty.');
    return false;
  }

  // 🛠️ DEBUG: LOG HEX PAYLOAD
  const hexString = byteArray
    .map(function (byte) {
      return ('0' + (byte & 0xff).toString(16)).slice(-2).toUpperCase();
    })
    .join(' ');
  Logger.log('📦 API PAYLOAD (HEX): ' + hexString);

  const signedBytes = byteArray.map(function (b) {
    const val = parseInt(b as unknown as string, 10);
    return val < 128 ? val : val - 256;
  });

  const blob = Utilities.newBlob(signedBytes, 'application/octet-stream');
  const scriptProps = PropertiesService.getScriptProperties();
  const USER = scriptProps.getProperty('NGROK_USER');
  const PASS = scriptProps.getProperty('NGROK_PASS');
  const URL = scriptProps.getProperty('PI_URL');

  if (!USER || !PASS || !URL) throw new Error('Configuration Error');

  const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
    method: 'post',
    contentType: 'application/octet-stream',
    payload: blob,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(USER + ':' + PASS) },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(URL, options);
  if (response.getResponseCode() === 200) return true;
  throw new Error(
    `Ngrok Error ${response.getResponseCode()}: ${response.getContentText()}`,
  );
}

export function callWithRetry(func: () => boolean): boolean | undefined {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (func() === true) return true;
    } catch (e) {
      if (attempt < MAX_RETRIES) Utilities.sleep(Math.pow(2, attempt) * 1000);
      else return false;
    }
  }
}

export function sendAlertEmail(subject: string, body: string): void {
  const scriptProperties = PropertiesService.getScriptProperties();
  const alertTo = scriptProperties.getProperty('EMAIL_ALERTS_TO');
  if (!alertTo) {
    Logger.log('⚠️ EMAIL_ALERTS_TO not set in Script Properties; skipping alert email.');
    return;
  }
  const lastAlert = parseInt(scriptProperties.getProperty('LAST_ALERT_TIME') || '0');
  const now = new Date().getTime();
  if (now - lastAlert > 14400000) {
    MailApp.sendEmail({
      to: alertTo,
      subject: '⚠️ PRINTER ALERT: ' + subject,
      body: body,
    });
    scriptProperties.setProperty('LAST_ALERT_TIME', now.toString());
  }
}

// --- TEST SUITE ---
export function testPrinter(): void {
  Logger.log('🧪 Starting Printer Test Suite...');

  const createMock = (
    title: string,
    desc: string,
    isAllDay: boolean,
    hourOffset: number,
  ): ReceiptEvent => {
    const t = new Date();
    t.setHours(t.getHours() + hourOffset);
    return {
      getId: () => 'TEST_' + Math.random(),
      getTitle: () => title,
      getDescription: () => desc,
      getStartTime: () => t,
      isAllDayEvent: () => isAllDay,
    };
  };

  const testCases = [
    createMock(
      'TEST: Checkboxes',
      'Description joined:[ ] Item 1[ ] Item 2 [ ] Fix Printer Now',
      true,
      0,
    ),
    createMock('TEST: Standard', 'Short description. Should look normal.', false, 1),
  ];

  testCases.forEach((mockEvent, i) => {
    try {
      Logger.log(
        `🖨️ Printing Test ${i + 1}/${testCases.length}: ${mockEvent.getTitle()}`,
      );
      sendToPi(generateReceiptPayload(mockEvent));
      Utilities.sleep(3000);
    } catch (e) {
      Logger.log(`❌ Test ${i + 1} Failed: ${e.toString()}`);
    }
  });

  Logger.log('✅ Test Suite Complete.');
}
