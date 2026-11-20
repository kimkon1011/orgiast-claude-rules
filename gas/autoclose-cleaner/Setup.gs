/**
 * AutoClose Cleaner — Setup & Command Queue
 *
 * setupOnce() のみ手動実行。プロジェクト固有初期化 + installCommandQueue() を内包。
 */

// ---- セットアップ（kim ▶実行 1クリックのみ） ----

function setupOnce() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _ensureTab_(ss);

  // 日次トリガー（夜間22時〜23時）を設置
  _installNightlyTrigger_();

  // コマンドキューインストール
  installCommandQueue();

  // read-back
  var back = _readBack_(ss, sheet);
  console.log('autoclose-cleaner setup done; tab=' + sheet.getName() + '; headers=' + back.headers.length + '; rows=' + back.rowCount);
  return { ok: true, tabName: sheet.getName(), headers: back.headers, rowCount: back.rowCount };
}

// ---- トリガー管理 ----

function _installNightlyTrigger_() {
  var existing = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'nightlyArchive'; });
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('nightlyArchive')
    .timeBased()
    .everyDays(1)     // 日次
    .atHour(22)       // 22時台
    .nearMinute(30)   // 22:30頃
    .create();
}

function installNightlyTrigger() {
  _installNightlyTrigger_();
  return { ok: true };
}

// ---- シート管理 ----

function _ensureTab_(ss) {
  var sheet = ss.getSheetByName(CONF_.TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONF_.TAB_NAME);
    // ヘッダー行を書き込む
    sheet.getRange(1, 1, 1, CONF_.HEADERS.length).setValues([CONF_.HEADERS]);
    SpreadsheetApp.flush();
  }
  // 1行目がヘッダーでなければ書き込む
  var row1 = sheet.getRange(1, 1, 1, CONF_.HEADERS.length).getDisplayValues()[0];
  var hasValidHeader = false;
  for (var i = 0; i < CONF_.HEADERS.length; i++) {
    if ((row1[i] || '').replace(/\n/g, '') === CONF_.HEADERS[i]) {
      hasValidHeader = true;
      break;
    }
  }
  if (!hasValidHeader) {
    sheet.getRange(1, 1, 1, CONF_.HEADERS.length).setValues([CONF_.HEADERS]);
    SpreadsheetApp.flush();
  }
  return sheet;
}

function _readBack_(ss, sheet) {
  var lc = sheet.getLastColumn();
  var lr = sheet.getLastRow();
  return {
    headers: lc > 0 ? sheet.getRange(1, 1, 1, lc).getDisplayValues()[0] : [],
    rowCount: lr > 0 ? lr - 1 : 0
  };
}

// ---- 設定確認 ----

function describeConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    cmdFolderId: props.getProperty('CMD_FOLDER_ID') || null,
    nightlyTrigger: ScriptApp.getProjectTriggers()
      .filter(function (t) { return t.getHandlerFunction() === 'nightlyArchive'; })
      .map(function (t) { return { hour: t.getTriggerSource().toString(), nextRun: t.getNextRun() ? t.getNextRun().toISOString() : null }; })
  };
}