// Receives "report conditions" posts from isitdry and appends them to this spreadsheet.
// Paste into Extensions → Apps Script of a new Google Sheet, then Deploy → Web app.

const COLS = ['received', 'reported_at', 'date', 'time', 'crag_id', 'crag', 'sector', 'face', 'cracks',
  'conditions', 'note', 'pred_face', 'pred_cracks', 'pred_conditions', 'pred_hours', 'model'];

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (!d.crag_id || !d.face) return ContentService.createTextOutput('missing fields');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('reports') || ss.insertSheet('reports');
  if (sh.getLastRow() === 0) sh.appendRow(COLS);
  sh.appendRow(COLS.map(c => c === 'received' ? new Date() : String(d[c] ?? '').slice(0, 300)));
  return ContentService.createTextOutput('ok');
}
