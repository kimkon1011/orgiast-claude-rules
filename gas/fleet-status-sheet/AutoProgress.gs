// auto-progress: 宣言した「この後の自動進行」を台帳化したものを共有シートに集約する。
// tools/auto-progress-watch.mjs（kind: auto-progress）と tools/auto-progress-digest.mjs
// （kind: auto-progress-list）が使う。タブ「自動進行」は無ければ自動作成（列は固定）。

var AUTO_PROGRESS_TAB_ = '自動進行';
var AUTO_PROGRESS_HEADERS_ = ['key', 'pc', 'user', 'sessionId', 'promise', 'recordedAt', 'lastEvidenceAt', 'verdict', 'reason', 'resumeAttempted', 'resumeOutcome', 'reportedAt'];

function _autoProgressSheet_() {
  var spreadsheet = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  var sheet = spreadsheet.getSheetByName(AUTO_PROGRESS_TAB_);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(AUTO_PROGRESS_TAB_);
    sheet.getRange(1, 1, 1, AUTO_PROGRESS_HEADERS_.length).setValues([AUTO_PROGRESS_HEADERS_]);
    sheet.getRange('A:L').setNumberFormat('@'); // ISO 日時を Date に自動変換させない
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// key(pc/user/sessionId/recordedAt)で upsert。同じ件の再報告(再開結果の更新)は行を上書きする。
function upsertAutoProgress(payload) {
  var row = payload.row || {};
  if (!row.key || !row.pc) return { ok: false, status: 400, error: 'row_required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = _autoProgressSheet_();
    var values = AUTO_PROGRESS_HEADERS_.map(function(h) { return h === 'resumeAttempted' ? String(row[h] === true) : String(row[h] == null ? '' : row[h]).slice(0, 500); });
    var last = sheet.getLastRow();
    var keys = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
    for (var i = 0; i < keys.length; i += 1) {
      if (String(keys[i][0]) === values[0]) { sheet.getRange(i + 2, 1, 1, values.length).setValues([values]); return { ok: true, updated: true }; }
    }
    sheet.appendRow(values);
    return { ok: true, updated: false };
  } finally { lock.releaseLock(); }
}

// digest 用: reportedAt が sinceMs 以降の行を返す。
function listAutoProgress(payload) {
  var sinceMs = Number(payload.sinceMs) || 0;
  var sheet = _autoProgressSheet_();
  var last = sheet.getLastRow();
  var rows = last > 1 ? sheet.getRange(2, 1, last - 1, AUTO_PROGRESS_HEADERS_.length).getValues() : [];
  var out = rows.map(function(r) {
    var o = {};
    AUTO_PROGRESS_HEADERS_.forEach(function(h, i) { o[h] = r[i]; });
    o.resumeAttempted = String(o.resumeAttempted) === 'true' || String(o.resumeAttempted) === 'TRUE';
    return o;
  }).filter(function(o) { var t = Date.parse(o.reportedAt); return isFinite(t) && t >= sinceMs; });
  return { ok: true, rows: out, count: out.length };
}
