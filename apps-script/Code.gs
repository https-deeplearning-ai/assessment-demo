/**
 * Assessment results collector (Google Apps Script Web app).
 *
 * Paste this into Extensions → Apps Script of the Google Sheet that should hold
 * the results, then Deploy → New deployment → Web app
 *   Execute as: Me    Who has access: Anyone
 * and copy the ".../exec" URL into src/config.js (RESULTS_ENDPOINT).
 *
 * Each POST from the assessment appends one row to the "results" tab
 * (created automatically with a header row on first use).
 */

const SHEET_NAME = 'results';
const MAX_BODY_CHARS = 100000;
const EVENTS = ['started', 'submitted'];
const COLUMNS = [
  'received_at', 'event', 'uh', 'variant', 'assessment_id', 'fingerprint',
  'session_id', 'started_at', 'submitted_at', 'duration_sec',
  'total_earned', 'total_possible', 'percentage',
  'by_challenge_json', 'answers_json', 'user_agent',
];

function doPost(e) {
  try {
    const body = (e && e.postData && e.postData.contents) || '';
    if (!body || body.length > MAX_BODY_CHARS) return reply_('rejected: size');
    const d = JSON.parse(body);
    if (!d || EVENTS.indexOf(d.event) === -1) return reply_('rejected: event');

    d.received_at = new Date();
    const row = COLUMNS.map(function (c) {
      const v = d[c];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
      // Stop text that starts with = + - @ from being run as a spreadsheet formula.
      if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
      return v;
    });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      sheet_().appendRow(row);
    } finally {
      lock.releaseLock();
    }
    return reply_('ok');
  } catch (err) {
    return reply_('error: ' + err);
  }
}

// Visiting the /exec URL in a browser just confirms the deployment is live.
function doGet() {
  return reply_('assessment results collector is running');
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(COLUMNS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function reply_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

/** Run once from the editor (▶ Run → testAppend) to grant permissions and see a sample row. */
function testAppend() {
  doPost({ postData: { contents: JSON.stringify({ event: 'started', uh: 'test', variant: 'A' }) } });
}
