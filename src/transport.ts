// Transport + alerting: the single sink for every print payload, plus the
// rate-limited failure email. sendToPi POSTs raw ESC/POS bytes to the Pi print
// bridge (ngrok static domain + basic auth); the receiving end is documented in
// docs/pi-print-server-runbook.md and the byte protocol in
// docs/escpos-protocol.md.

const MAX_RETRIES = 3;

// POST an ESC/POS byte array to the Pi bridge. Bytes >= 128 are converted to
// signed values (val - 256) before building the blob — Utilities.newBlob wants
// signed 8-bit ints; the wire bytes come out identical. Leave it.
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
