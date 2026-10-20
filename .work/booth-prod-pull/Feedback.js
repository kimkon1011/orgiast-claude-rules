/**
 * 実行パネルの「🐛 不具合・要望の入力欄」から不具合/要望を受け付け、master の
 * 「不具合要望」シートに記録する（＋Script Property に webhook があれば Discord 通知）。
 *
 * 実行経路: 実行パネルで「🐛 不具合・要望を報告」の ▶ をチェック
 *   → master simple onEdit が状態を書く → booth の processCommandQueue(1分毎) が
 *     ホワイトリスト経由で Feedback_submitFromPanel() を noCase 実行（CommandQueue.js に登録）。
 *
 * 画面キャプチャ添付 (2026-08-21 kim 要望):
 *   - パネル経路: シートに Ctrl+V で貼った over-grid image を拾って Drive 保存 + Discord 実添付
 *   - ダイアログ経路: master bound script の 🐛 ダイアログが記録まで行い、
 *     Discord 通知だけ cmd キュー経由で Feedback_notifyExternal に委譲する（webhook は booth 側にしかない）
 *
 * 開発側の回収: master(1t6eMvbPIu…) の「不具合要望」シートを読む → 対応 → 状態列を done に。
 *   （aujust の scripts/list-feedback.ts と同じ「キューを拾って改善」の GAS 版）
 */
var _FEEDBACK_MASTER_SS = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
var _FEEDBACK_PANEL = '🚀実行パネル';
var _FEEDBACK_LOG = '不具合要望';
var _FEEDBACK_IMAGE_FOLDER = '不具合要望スクショ';
var _FEEDBACK_MAX_IMAGES = 5;
var _FEEDBACK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
var _FEEDBACK_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
// MasterPanel.js Panel_rebuild で書き込むタイトル文字列と先頭一致で照合（レイアウト変化に強い）
var _FEEDBACK_TITLE_PREFIX = '🐛 不具合・要望の入力欄';

/** 実行パネル内の入力欄タイトル行を col A から探す（見つからなければ -1）。 */
function _Feedback_findSection(p) {
  var lastRow = p.getLastRow();
  if (lastRow < 6) return -1;
  var colA = p.getRange(1, 1, lastRow, 1).getValues();
  for (var r = 6; r <= lastRow; r++) {
    if (String(colA[r - 1][0] || '').indexOf(_FEEDBACK_TITLE_PREFIX) === 0) return r; // タイトル行
  }
  return -1;
}

/** サイズ・枚数上限内の添付だけを選ぶ（Node テスト可能な純関数）。 */
function _Feedback_selectImages(candidates) {
  var selected = [];
  var totalBytes = 0;
  var dropped = 0;
  for (var i = 0; i < candidates.length; i++) {
    var item = candidates[i];
    var bytes = Number(item.bytes) || 0;
    if (bytes > _FEEDBACK_MAX_IMAGE_BYTES || selected.length >= _FEEDBACK_MAX_IMAGES ||
        totalBytes + bytes > _FEEDBACK_MAX_TOTAL_BYTES) {
      dropped++;
      continue;
    }
    selected.push(item);
    totalBytes += bytes;
  }
  return { selected: selected, totalBytes: totalBytes, dropped: dropped };
}

/** Discord multipart payload を組み立てる（Node テスト可能な純関数）。 */
function _Feedback_buildDiscordRequest(content, blobs) {
  var payload = { payload_json: JSON.stringify({ content: content, flags: 4 }) };
  for (var i = 0; i < blobs.length; i++) payload['files[' + i + ']'] = blobs[i];
  return payload;
}

/** 既存 A-F を維持したまま G-J ヘッダを追加する。 */
function _Feedback_migrateLogHeaders(log) {
  var values = log.getRange(1, 7, 1, 4).getValues()[0];
  if (!values[0]) log.getRange(1, 7).setValue('画像');
  if (!values[1]) log.getRange(1, 8).setValue('送信元');
  if (!values[2]) log.getRange(1, 9).setValue('受付ID');
  if (!values[3]) log.getRange(1, 10).setValue('報告者');
  log.getRange(1, 6).copyTo(log.getRange(1, 7, 1, 4), { formatOnly: true });
}

function _Feedback_getImageFolder() {
  var parent = DriveApp.getRootFolder();
  try {
    var parents = DriveApp.getFileById(_FEEDBACK_MASTER_SS).getParents();
    if (parents.hasNext()) parent = parents.next();
  } catch (e) { /* root へフォールバック */ }
  var folders = parent.getFoldersByName(_FEEDBACK_IMAGE_FOLDER);
  return folders.hasNext() ? folders.next() : parent.createFolder(_FEEDBACK_IMAGE_FOLDER);
}

/**
 * パネル(シート)に貼られた画像を拾う。
 *
 * 実測 (2026-08-21): Apps Script の OverGridImage には getBlob() が存在しない
 * (`getBlob is not a function`)。つまり **シートに Ctrl+V で貼った画像は
 * スクリプトから読み取れない**。将来 API が増えた場合に自動で拾えるよう呼び出しは残し、
 * 読めなかった枚数を unreadable として返す（呼び出し側が案内に使う）。
 * 画像つき報告はメニューの 🐛 ダイアログ (master bound script) が正式ルート。
 */
function _Feedback_collectPanelImages(p) {
  var images = p.getImages();
  var candidates = [];
  var unreadable = 0;
  for (var i = 0; i < images.length; i++) {
    try {
      var blob = images[i].getBlob();
      var name = blob.getName() || 'screenshot.png';
      candidates.push({ image: images[i], blob: blob, name: name, bytes: blob.getBytes().length });
    } catch (e) { unreadable++; }
  }
  var result = _Feedback_selectImages(candidates);
  result.unreadable = unreadable;
  return result;
}

/** 添付 POST。失敗時は本文だけを再送する。 */
function _Feedback_notifyDiscord(hook, content, blobs) {
  var fallback = false;
  var code = 0;
  try {
    var response = UrlFetchApp.fetch(hook, {
      method: 'post', payload: _Feedback_buildDiscordRequest(content, blobs), muteHttpExceptions: true
    });
    code = response.getResponseCode();
  } catch (e) { code = 0; }
  if (code < 200 || code >= 300) {
    fallback = true;
    UrlFetchApp.fetch(hook, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ content: content, flags: 4 }), muteHttpExceptions: true
    });
  }
  return { ok: true, notified: true, attached: blobs.length, fallback: fallback };
}

/** 実行パネルの入力欄を読んで「不具合要望」シートへ記録。▶チェックで呼ばれる。 */
function Feedback_submitFromPanel(panelName) {
  var ms = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
  // 本番は JobQueue のコンテキスト(=▶を押した案件パネル)。panelName は検証用の明示指定。
  var p = ms.getSheetByName(panelName || _JobQueue_currentPanel());
  if (!p) return { ok: false, error: 'panel not found' };
  var t = _Feedback_findSection(p);
  if (t < 0) return { ok: false, error: 'feedback section not found (Panel_rebuild を実行してください)' };

  // ラベル=B列、入力=C列 (Panel_rebuild と一致必須 / kim 2026-08-17)
  var kind = String(p.getRange(t + 1, 3).getValue() || '不具合').trim();
  var title = String(p.getRange(t + 2, 3).getValue() || '').trim();
  var body = String(p.getRange(t + 3, 3).getValue() || '').trim();
  var statusCell = p.getRange(t + 4, 3);
  if (!title && !body) {
    statusCell.setValue('⚠ タイトルか内容を入力してから ▶ をチェックしてください').setFontColor('#c62828');
    return { ok: false, error: 'empty' };
  }
  if (kind !== '要望') kind = '不具合';
  var imageResult = _Feedback_collectPanelImages(p);

  // ログシート（無ければ作成）
  var log = ms.getSheetByName(_FEEDBACK_LOG);
  if (!log) {
    log = ms.insertSheet(_FEEDBACK_LOG);
    log.getRange(1, 1, 1, 8).setValues([['日時', '種別', 'タイトル', '内容', '状態', '対応メモ', '画像', '送信元']])
      .setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
    log.setFrozenRows(1);
    log.setColumnWidth(1, 130); log.setColumnWidth(3, 240); log.setColumnWidth(4, 420);
  }
  _Feedback_migrateLogHeaders(log);
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var savedBlobs = [];
  var imageUrls = [];
  if (imageResult.selected.length) {
    var folder = _Feedback_getImageFolder();
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
    for (var i = 0; i < imageResult.selected.length; i++) {
      var item = imageResult.selected[i];
      var safeName = String(item.name || 'screenshot.png').replace(/[\\/]/g, '_');
      var blob = item.blob.copyBlob().setName('fb_' + stamp + '_' + (i + 1) + '_' + safeName);
      var file = folder.createFile(blob);
      imageUrls.push(file.getUrl());
      savedBlobs.push(blob);
    }
  }
  log.appendRow([now, kind, title, body, 'new', '', imageUrls.join('\n'), 'パネル']);

  // 通知は中継(kim の Discord DM)経由。中継未設定/失敗時は FeedbackRelay_submit が内部で
  // webhook へフォールバックするので、ここでは分岐しない（失敗しても記録は成功扱い）。
  try {
    if (typeof FeedbackRelay_submit === 'function') {
      FeedbackRelay_submit({
        kind: kind === '要望' ? 'request' : 'bug',
        title: title,
        body: body,
        sourceUrl: ms.getUrl(),
        imageBlobs: savedBlobs
      });
    } else {
      // FeedbackRelay.js 未ロードの環境向け後方互換フォールバック（本番は常にロードされる）
      var hook = PropertiesService.getScriptProperties().getProperty('DISCORD_FEEDBACK_WEBHOOK');
      if (hook) {
        var content = '🐛 **' + kind + '**（ブース制作アプリ / 実行パネル）: ' + (title || '(無題)') + '\n'
          + body.slice(0, 300) + '\n報告シート: master「' + _FEEDBACK_LOG + '」';
        _Feedback_notifyDiscord(hook, content, savedBlobs);
      }
    }
  } catch (e) { /* 通知は best-effort。失敗しても記録は成功扱い */ }

  // 入力欄クリア + 完了表示
  p.getRange(t + 2, 3).clearContent();
  p.getRange(t + 3, 3).clearContent();
  // 添付できた画像だけをシートから消す。上限超過・読めなかった画像を消すと
  // 貼り付けた本人の資料が黙って失われるので、シートに残す。
  for (var j = 0; j < imageResult.selected.length; j++) {
    try { imageResult.selected[j].image.remove(); } catch (e) { /* 個別削除失敗は送信成功扱い */ }
  }
  var imageMessage = savedBlobs.length ? ' 画像 ' + savedBlobs.length + ' 枚を添付しました。' : '';
  if (imageResult.dropped) {
    imageMessage += ' ⚠ ' + imageResult.dropped + ' 枚は上限超過で添付できませんでした（1枚10MB/合計25MB/5枚まで）。'
      + 'シートに残してあるので、分けて報告してください。';
  }
  if (imageResult.unreadable) {
    // シートに貼った画像は Google の制限でスクリプトから読めない。捨てずに案内する。
    imageMessage += ' ⚠ シートに貼った画像 ' + imageResult.unreadable + ' 枚は送れません。'
      + '画像つきで送るときはメニュー「ブース制作アプリ」→「🐛 不具合・要望を報告 (画像OK)」を使ってください。';
  }
  statusCell.setValue('✅ 送信しました（' + now + '）。' + imageMessage + '開発が master「' + _FEEDBACK_LOG + '」シートで確認し対応します。')
    .setFontColor('#2e7d32');
  return {
    ok: true, logged: true, images: savedBlobs.length, droppedImages: imageResult.dropped,
    unreadableImages: imageResult.unreadable, imageUrls: imageUrls
  };
}

/**
 * master ダイアログで記録済みの報告を通知する。
 * 中継(kim の Discord DM)経由。FeedbackRelay.js 未ロードの環境（旧テスト等）では
 * 従来どおり Script Property DISCORD_FEEDBACK_WEBHOOK への直接通知にフォールバックする。
 */
function Feedback_notifyExternal(payload) {
  payload = payload || {};
  var blobs = [];
  var ids = payload.imageFileIds || [];
  for (var i = 0; i < ids.length; i++) {
    try { blobs.push(DriveApp.getFileById(ids[i]).getBlob()); } catch (e) { /* best-effort */ }
  }
  if (typeof FeedbackRelay_submit === 'function') {
    return FeedbackRelay_submit({
      kind: (payload.kind || '不具合') === '要望' ? 'request' : 'bug',
      title: payload.title || '',
      body: payload.body || '',
      sourceUrl: payload.sheetUrl || '',
      imageBlobs: blobs
    });
  }
  var hook = PropertiesService.getScriptProperties().getProperty('DISCORD_FEEDBACK_WEBHOOK');
  if (!hook) return { ok: true, skipped: 'no webhook' };
  var content = '🐛 **' + (payload.kind || '不具合') + '**（ブース制作アプリ / ' + (payload.source || '外部') + '）: '
    + (payload.title || '(無題)') + '\n' + String(payload.body || '').slice(0, 300)
    + (payload.at ? '\n日時: ' + payload.at : '')
    + (payload.sheetUrl ? '\n報告シート: ' + payload.sheetUrl : '');
  try {
    return _Feedback_notifyDiscord(hook, content, blobs);
  } catch (e) {
    return { ok: false, notified: false, attached: blobs.length, fallback: true };
  }
}

/** 保守用: 指定パネル上の over-grid 画像を全部削除する（検証で残った画像の掃除用）。 */
function _admin_clearPanelImages(panelName) {
  if (!panelName) return { ok: false, error: 'panelName は必須（誤って他パネルの画像を消さないため）' };
  var ms = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
  var p = ms.getSheetByName(panelName);
  if (!p) return { ok: false, error: 'panel not found: ' + panelName };
  var images = p.getImages();
  var removed = 0;
  for (var i = 0; i < images.length; i++) {
    try { images[i].remove(); removed++; } catch (e) { /* skip */ }
  }
  return { ok: true, panel: p.getName(), removed: removed, remaining: p.getImages().length };
}

/** 診断専用: パネル上の画像が読めるか(getBlob が使えるか)を1枚ずつ確かめる。 */
function _debug_feedbackPanelImages(panelName) {
  var ms = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
  var p = panelName ? ms.getSheetByName(panelName) : null;
  if (!p) {
    var sheets = ms.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (_Feedback_findSection(sheets[i]) > 0 && sheets[i].getImages().length) { p = sheets[i]; break; }
    }
  }
  if (!p) return { ok: false, error: '画像を持つパネルが見つかりません' };
  var images = p.getImages();
  var report = [];
  for (var k = 0; k < images.length; k++) {
    var entry = { index: k, hasGetBlob: typeof images[k].getBlob };
    try { entry.anchor = images[k].getAnchorCell().getA1Notation(); } catch (e) { entry.anchorError = String(e); }
    try {
      var b = images[k].getBlob();
      entry.blobName = b.getName();
      entry.contentType = b.getContentType();
      entry.bytes = b.getBytes().length;
    } catch (e2) { entry.blobError = String(e2); }
    report.push(entry);
  }
  return { ok: true, panel: p.getName(), count: images.length, images: report };
}

/**
 * 検証専用: パネルにテスト画像を貼った状態を再現して Feedback_submitFromPanel を実行し、
 * 記録行・Drive 保存・パネル画像の後始末まで read-back して返す。
 * テスト行と保存ファイルは自動で片付ける（Discord には「接続テスト」として1件だけ流れる）。
 */
function _test_feedbackPanelImage(panelName) {
  var ms = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
  var p = panelName ? ms.getSheetByName(panelName) : null;
  if (!p) {
    var sheets = ms.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (_Feedback_findSection(sheets[i]) > 0) { p = sheets[i]; break; }
    }
  }
  if (!p) return { ok: false, error: '🐛入力欄を持つパネルが見つかりません' };
  var t = _Feedback_findSection(p);
  if (t < 0) return { ok: false, error: 'feedback section not found on ' + p.getName() };

  var before = p.getImages().length;
  var png = Utilities.base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');
  var inserted = p.insertImage(Utilities.newBlob(png, 'image/png', 'verify.png'), 8, t);
  p.getRange(t + 1, 3).setValue('不具合');
  p.getRange(t + 2, 3).setValue('接続テスト(自動・無視してください)');
  p.getRange(t + 3, 3).setValue('画面キャプチャ添付の自動検証。テスト行は自動削除されます。');
  SpreadsheetApp.flush();

  var ret = Feedback_submitFromPanel(p.getName());
  var log = ms.getSheetByName(_FEEDBACK_LOG);
  if (!log) return { ok: false, error: '記録シートが作られていません', panel: p.getName(), submit: ret };
  var lastRow = log.getLastRow();
  var row = log.getRange(lastRow, 1, 1, 8).getValues()[0];
  var header = log.getRange(1, 1, 1, 8).getValues()[0];
  var imagesAfter = p.getImages().length;

  // 後片付け: 保存された検証用画像を trash し、テスト行を消す
  var trashed = 0;
  var urls = String(row[6] || '').split('\n');
  for (var j = 0; j < urls.length; j++) {
    var m = /\/d\/([-\w]{20,})/.exec(urls[j]);
    if (!m) continue;
    try { DriveApp.getFileById(m[1]).setTrashed(true); trashed++; } catch (e) { /* skip */ }
  }
  var isTestRow = String(row[2]).indexOf('接続テスト') === 0;
  if (isTestRow) log.deleteRow(lastRow);
  try { p.getRange(t + 4, 3).clearContent(); } catch (e) { /* skip */ }
  // 検証で入れた画像は必ず片付ける（読めない画像はシートに残る仕様なので明示削除）
  try { inserted.remove(); } catch (e) { /* skip */ }

  return {
    ok: true, panel: p.getName(), submit: ret, header: header, row: row,
    imagesBefore: before, imagesAfter: imagesAfter, trashedFiles: trashed, deletedTestRow: isTestRow
  };
}

/**
 * 診断専用(読み取りのみ): master「不具合要望」シートの末尾 N 行を型情報つきで返す。
 * ダイアログが「送信に失敗しました」と出た時に、行が実際に記録されているか /
 * A列が Date に化けていないか(= google.script.run が返せない型)を確かめる用途。
 */
function _debug_feedbackLog(limit) {
  var ms = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
  var sh = ms.getSheetByName(_FEEDBACK_LOG);
  if (!sh) return { ok: false, error: 'sheet not found: ' + _FEEDBACK_LOG };
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var n = Math.min(Math.max(Number(limit) || 10, 1), 30);
  var start = Math.max(2, lastRow - n + 1);
  var rows = [];
  if (lastRow >= 2) {
    var values = sh.getRange(start, 1, lastRow - start + 1, lastCol).getValues();
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      rows.push({
        row: start + i,
        colAIsDate: r[0] instanceof Date,
        colA: String(r[0]),
        kind: String(r[1] || ''),
        title: String(r[2] || ''),
        bodyLen: String(r[3] || '').length,
        bodyHead: String(r[3] || '').slice(0, 160),
        bodyFull: String(r[3] || ''),
        state: String(r[4] || ''),
        images: String(r[6] || ''),
        source: String(r[7] || '')
      });
    }
  }
  return {
    ok: true,
    lastRow: lastRow,
    lastCol: lastCol,
    header: sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String),
    rows: rows
  };
}
