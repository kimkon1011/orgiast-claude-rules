/**
 * AutoClose Cleaner — 完了案件の自動アーカイブ移動
 *
 * 案件管理シートのステータスが「完了」「却下」「中止」の行を検出。
 * 該当案件のフォルダを案件管理フォルダ直下の「_archive」サブフォルダへ移動。
 * シートの該当行にアーカイブ日時と移動先URLを追記。
 * 日次定期実行（夜間）。
 */

// ---- 設定 ----

var CONF_ = {
  // シートの想定列
  HEADERS: [
    '案件ID',          // 0
    '案件名',          // 1
    'ステータス',       // 2
    'フォルダURL',      // 3 — DriveフォルダURL
    'アーカイブ日時',    // 4 — スクリプト追記
    '移動先URL'         // 5 — スクリプト追記
  ],
  // アーカイブ対象ステータス
  TARGET_STATUSES: ['完了', '却下', '中止'],
  // アーカイブ先サブフォルダ名
  ARCHIVE_FOLDER_NAME: '_archive',
  // シートタブ名
  TAB_NAME: '案件一覧'
};

// ---- メインロジック ----

function runArchive() {
  return _withLock_(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONF_.TAB_NAME);
    if (!sheet) throw new Error('tab not found: ' + CONF_.TAB_NAME);

    // 案件管理フォルダ（シートを含むフォルダ）
    var parentFolder = _getSheetFolder_(ss);

    // _archive サブフォルダを取得または作成
    var archiveFolder = _ensureSubfolder_(parentFolder, CONF_.ARCHIVE_FOLDER_NAME);

    // ヘッダー行を読み取って列インデックスを解決
    var lastColumn = sheet.getLastColumn();
    var headerRow = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
    var colMap = _resolveColumns_(headerRow, CONF_.HEADERS);

    // データ行を取得
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: true, archived: 0, reason: 'no data rows' };

    var dataRange = sheet.getRange(2, 1, lastRow - 1, lastColumn);
    var data = dataRange.getDisplayValues();

    var archiveDate = new Date().toISOString();
    var results = [];

    // 下から処理（削除・移動で行番号がずれないように）
    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      var status = (row[colMap['ステータス']] || '').trim();
      if (CONF_.TARGET_STATUSES.indexOf(status) === -1) continue;

      var folderUrl = (row[colMap['フォルダURL']] || '').trim();
      var archiveUrl = (row[colMap['移動先URL']] || '').trim();

      // 既にアーカイブ済みならスキップ
      if (archiveUrl) {
        results.push({ row: i + 2, status: 'already_archived', folderUrl: folderUrl });
        continue;
      }

      // フォルダURLからフォルダIDを抽出
      var folderId = _extractFolderId_(folderUrl);
      if (!folderId) {
        results.push({ row: i + 2, status: 'no_folder', folderUrl: folderUrl });
        continue;
      }

      var movedUrl = '';
      try {
        var targetFolder = DriveApp.getFolderById(folderId);
        movedUrl = _moveFolder_(targetFolder, archiveFolder, archiveDate);
      } catch (e) {
        // フォルダが既に存在しない場合もある
        results.push({ row: i + 2, status: 'move_failed', error: e.message, folderId: folderId });
        continue;
      }

      // シートにアーカイブ日時と移動先URLを追記
      var actualRow = i + 2; // シート上の行番号（1-indexed、ヘッダー含む）
      var dateCol = colMap['アーカイブ日時'];
      var urlCol = colMap['移動先URL'];

      if (dateCol >= 0) {
        sheet.getRange(actualRow, dateCol + 1).setValue(archiveDate);
      }
      if (urlCol >= 0) {
        sheet.getRange(actualRow, urlCol + 1).setValue(movedUrl);
      }
      SpreadsheetApp.flush();

      results.push({ row: actualRow, status: 'archived', folderUrl: folderUrl, movedUrl: movedUrl });
    }

    return { ok: true, archived: results.length, details: results };
  });
}

// ---- 日次トリガー（夜間実行） ----

function nightlyArchive() {
  var result = runArchive();
  console.log('nightlyArchive completed: ' + JSON.stringify(result));
  return result;
}

// ---- フォルダ移動 ----

/**
 * 案件フォルダを _archive へ移動する。
 * 移動先は _archive 以下に "${archiveDate}_${フォルダ名}" のサブフォルダを作り、
 * その中に案件フォルダを移動する。
 */
function _moveFolder_(folder, archiveFolder, archiveDate) {
  var datePrefix = archiveDate.slice(0, 10); // YYYY-MM-DD
  var folderName = folder.getName();

  // _archive 内に日付別サブフォルダを作成
  var dateSubfolder = _ensureSubfolder_(archiveFolder, datePrefix);

  // 既に同名フォルダが存在しないか確認
  var existing = dateSubfolder.getFoldersByName(folderName);
  if (existing.hasNext()) {
    // 既存の場合は既存フォルダ内に移動
    var existingFolder = existing.next();
    // ファイルだけを移動
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      f.moveTo(existingFolder);
    }
    var subfolders = folder.getFolders();
    while (subfolders.hasNext()) {
      var sf = subfolders.next();
      // 再帰的に移動
      var sffiles = sf.getFiles();
      while (sffiles.hasNext()) {
        sffiles.next().moveTo(existingFolder);
      }
    }
    // 空になった元フォルダを削除
    folder.setTrashed(true);
  } else {
    folder.moveTo(dateSubfolder);
  }

  return dateSubfolder.getUrl();
}

/**
 * フォルダURLからIDを抽出する。
 * 対応形式:
 *   https://drive.google.com/drive/folders/<ID>
 *   https://drive.google.com/drive/u/0/folders/<ID>
 *   https://drive.google.com/open?id=<ID>
 */
function _extractFolderId_(url) {
  if (!url) return null;
  var m;
  m = url.match(/\/drive\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

// ---- ユーティリティ ----

function _getSheetFolder_(ss) {
  var file = DriveApp.getFileById(ss.getId());
  var parents = file.getParents();
  if (!parents.hasNext()) throw new Error('sheet has no parent folder');
  return parents.next();
}

function _ensureSubfolder_(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

/**
 * ヘッダー行から列名→インデックスのマップを作成する。
 */
function _resolveColumns_(headerRow, expected) {
  var map = {};
  for (var i = 0; i < expected.length; i++) {
    map[expected[i]] = -1;
  }
  for (var j = 0; j < headerRow.length; j++) {
    var header = (headerRow[j] || '').trim().replace(/\n/g, '');
    if (map.hasOwnProperty(header)) {
      map[header] = j;
    }
  }
  return map;
}

function _withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('could not acquire lock');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}