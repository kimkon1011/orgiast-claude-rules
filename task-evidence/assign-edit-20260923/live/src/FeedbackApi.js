/** master「不具合要望」シートを外部ジョブから読み書きする WebApp API。 */
var FEEDBACK_API_MASTER_SS_ID = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
var FEEDBACK_API_SHEET_NAME = '不具合要望';
var FEEDBACK_API_SHEET_URL = 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/'
  + FEEDBACK_API_MASTER_SS_ID + '/edit';

function _FeedbackApi_isOpen(statusValue) {
  var status = String(statusValue == null ? '' : statusValue)
    .trim().toLowerCase().replace(/　/g, '');
  var closed = {
    done: true, '完了': true, '対応済': true, '対応済み': true,
    rejected: true, '却下': true, wontfix: true, '見送り': true
  };
  return !closed[status];
}

function _FeedbackApi_validDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  var parsed = new Date(value.trim());
  return isNaN(parsed.getTime()) ? null : parsed;
}

function _FeedbackApi_formatTs(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  }
  return String(value == null ? '' : value).trim();
}

function _FeedbackApi_rowKey(row, rowNumber) {
  var receiptId = String(row[8] == null ? '' : row[8]);
  if (receiptId.trim()) return receiptId;
  var date = _FeedbackApi_validDate(row[0]);
  var stamp = date ? Utilities.formatDate(date, 'Asia/Tokyo', 'yyyyMMddHHmm') : 'nots';
  return 'row' + rowNumber + '-' + stamp;
}

function FeedbackApi_list(params) {
  params = params || {};
  var sheet = SpreadsheetApp.openById(FEEDBACK_API_MASTER_SS_ID).getSheetByName(FEEDBACK_API_SHEET_NAME);
  var rows = sheet && sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues()
    : [];
  var includeAll = String(params.status || '').toLowerCase() === 'all';
  var openCount = 0;
  var items = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var isOpen = _FeedbackApi_isOpen(row[4]);
    if (isOpen) openCount++;
    if (!includeAll && !isOpen) continue;

    var body = String(row[3] == null ? '' : row[3]);
    if (body.length > 2000) body = body.slice(0, 2000) + '…';
    var images = String(row[6] == null ? '' : row[6]).split(/\r?\n/)
      .map(function (value) { return value.trim(); })
      .filter(function (value) { return value !== ''; });
    items.push({
      key: _FeedbackApi_rowKey(row, i + 2),
      rowNumber: i + 2,
      ts: _FeedbackApi_formatTs(row[0]),
      kind: String(row[1] == null ? '' : row[1]),
      title: String(row[2] == null ? '' : row[2]),
      body: body,
      status: String(row[4] == null ? '' : row[4]),
      note: String(row[5] == null ? '' : row[5]),
      source: String(row[7] == null ? '' : row[7]),
      images: images
    });
  }

  return {
    ok: true,
    sheetUrl: FEEDBACK_API_SHEET_URL,
    counts: { open: openCount, total: rows.length },
    items: items
  };
}

function FeedbackApi_resolve(payload) {
  payload = payload || {};
  var key = String(payload.key == null ? '' : payload.key);
  var status = payload.status == null ? 'done' : String(payload.status);
  var note = String(payload.note == null ? '' : payload.note);
  var lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    var sheet = SpreadsheetApp.openById(FEEDBACK_API_MASTER_SS_ID).getSheetByName(FEEDBACK_API_SHEET_NAME);
    var lastRow = sheet ? sheet.getLastRow() : 0;
    var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 9).getValues() : [];
    for (var i = 0; i < rows.length; i++) {
      var rowNumber = i + 2;
      if (_FeedbackApi_rowKey(rows[i], rowNumber) !== key) continue;
      var previousStatus = String(rows[i][4] == null ? '' : rows[i][4]);
      var previousNote = String(rows[i][5] == null ? '' : rows[i][5]);
      var datedNote = '[' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd') + '] ' + note;
      sheet.getRange(rowNumber, 5).setValue(status);
      sheet.getRange(rowNumber, 6).setValue(previousNote ? previousNote + '\n' + datedNote : datedNote);
      return { ok: true, rowNumber: rowNumber, previousStatus: previousStatus };
    }
    return { ok: false, error: 'feedback not found' };
  } finally {
    lock.releaseLock();
  }
}

/** master bound ダイアログの承認失敗時に、Web アプリ権限で報告を記録する。 */
function FeedbackApi_submitFromDialog(payload) {
  payload = payload || {};
  var appendedRow = 0;
  var appendSucceeded = false;
  try {
    if (!_FeedbackRelay_checkRateLimit()) {
      return { ok: false, error: 'しばらく時間をおいて再度お試しください' };
    }

    var title = String(payload.title || '').trim().slice(0, 200);
    var body = String(payload.body || '').trim().slice(0, 4000);
    var kind = String(payload.kind || '') === '要望' ? '要望' : '不具合';
    var place = String(payload.place || '').trim();
    var sheetName = String(payload.sheetName || '').trim();
    var submitId = String(payload.submitId || '').trim();
    var reporter = String(payload.reporter || '').trim();
    if (!title && !body) return { ok: false, error: 'タイトルか内容を入力してください' };
    if (place && body.indexOf('発生場所: ' + place) === -1) {
      body += (body ? '\n\n' : '') + '発生場所: ' + place;
    }

    var candidates = _FeedbackRelay_decodeImages(payload.images);
    var totalBytes = 0;
    if (candidates.length > _FEEDBACK_MAX_IMAGES) {
      return { ok: false, error: '画像は5枚まで添付できます' };
    }
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].bytes > _FEEDBACK_MAX_IMAGE_BYTES) {
        return { ok: false, error: '画像は1枚10MBまで添付できます' };
      }
      totalBytes += candidates[i].bytes;
    }
    if (totalBytes > _FEEDBACK_MAX_TOTAL_BYTES) {
      return { ok: false, error: '画像は合計25MBまで添付できます' };
    }

    var ms = SpreadsheetApp.openById(_FEEDBACK_MASTER_SS);
    var log = _FeedbackRelay_ensureLogSheet(ms);
    var lastRow = log.getLastRow();
    if (submitId && lastRow > 1) {
      var startRow = Math.max(2, lastRow - 29);
      var ids = log.getRange(startRow, 9, lastRow - startRow + 1, 1).getValues();
      for (var j = 0; j < ids.length; j++) {
        if (String(ids[j][0] || '').trim() === submitId) {
          return {
            ok: true, row: startRow + j, dedup: true, logSheetUrl: FEEDBACK_API_SHEET_URL,
            images: 0, notified: false, via: 'webapp'
          };
        }
      }
    }

    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
    var savedBlobs = [];
    var imageUrls = [];
    if (candidates.length) {
      var folder = _Feedback_getImageFolder();
      for (var k = 0; k < candidates.length; k++) {
        var blob = candidates[k].blob.copyBlob().setName(
          'fb_' + stamp + '_' + (k + 1) + '_' + candidates[k].name
        );
        imageUrls.push(folder.createFile(blob).getUrl());
        savedBlobs.push(blob);
      }
    }

    appendedRow = log.getLastRow() + 1;
    log.appendRow([
      now, kind, title, body, 'new', '', imageUrls.join('\n'),
      'ダイアログ(' + sheetName + ') / webapp', submitId, reporter
    ]);
    appendSucceeded = true;
    SpreadsheetApp.flush();
    appendedRow = log.getLastRow();
    if (String(log.getRange(appendedRow, 3).getValue() || '') !== title) {
      return {
        ok: false,
        error: '記録の読み戻しに失敗しました（行 ' + appendedRow + ' への記録は済んでいます）'
      };
    }

    var notify = { via: 'none' };
    try {
      notify = FeedbackRelay_submit({
        appName: 'ブース制作アプリ', kind: kind === '要望' ? 'request' : 'bug',
        title: title, body: body, submitter: reporter, pagePath: sheetName,
        sourceUrl: FEEDBACK_API_SHEET_URL, imageBlobs: savedBlobs
      }) || notify;
    } catch (notifyError) { /* 通知は best-effort */ }
    return {
      ok: true, row: appendedRow, dedup: false, logSheetUrl: FEEDBACK_API_SHEET_URL,
      images: savedBlobs.length, notified: notify.via !== 'none', via: 'webapp'
    };
  } catch (err) {
    console.error(err);
    var message = String(err && err.message ? err.message : err);
    return {
      ok: false,
      error: '記録に失敗しました: ' + message
        + (appendSucceeded ? '（行 ' + appendedRow + ' への記録は済んでいます）' : '')
    };
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    // gigafile callback は type を query parameter で渡せる。本文が JSON でない場合も
    // parameter を payload として認証・処理し、既存 API だけ従来どおり bad json にする。
    var queryAction = String(e && e.parameter && e.parameter.action || '');
    if (String(e && e.parameter && e.parameter.type || '') !== 'gigafile' && queryAction !== 'rushList' && queryAction !== 'rushUpdate') {
      return _CaseApi_json({ ok: false, error: 'bad json' });
    }
    body = e.parameter || {};
  }
  var requestType = String(e && e.parameter && e.parameter.type || body.type || '');
  if (requestType === 'gigafile') {
    return _CaseApi_json(TransferLinks_handleCallback(body));
  }
  var action = String(body.action || e && e.parameter && e.parameter.action || '');
  if (action === 'rushList' || action === 'rushUpdate') {
    var params = {};
    var query = e && e.parameter ? e.parameter : {};
    Object.keys(query).forEach(function (key) { params[key] = query[key]; });
    Object.keys(body).forEach(function (key) { params[key] = body[key]; });
    return _CaseApi_dispatch({ parameter: params });
  }
  if (action === 'submitFeedbackDialog') {
    return _CaseApi_json(FeedbackApi_submitFromDialog(body));
  }
  if (String(body.token || '') !== _CaseApi_expectedToken()) {
    return _CaseApi_json({ ok: false, error: 'unauthorized' });
  }
  if (String(body.action || '') === 'resolveFeedback') {
    return _CaseApi_json(FeedbackApi_resolve(body));
  }
  return _CaseApi_json({ ok: false, error: 'unknown action' });
}
