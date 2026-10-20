/** 次回打合せを予定化し、前日9時(JST)以降に Gmail 下書きだけを作成する。 */
const _MEETING_HEADERS = ['次回打合せ日時', '顧客メール', '打合せイベントID', '前日下書き済'];

// キューが script lock を保持するため、案件一覧に対する document lock を共用する。
function _Meeting_locked(fn) {
  const lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(1000)) throw new Error('打合せ処理が実行中です。再実行してください');
  try { return fn(); } finally { lock.releaseLock(); }
}

function _Meeting_sheet() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!sheet) throw new Error('案件一覧シートが存在しません');
  return sheet;
}

function _Meeting_columns(sheet) {
  // 既存固定列を予約する。空の旧シートでも MasterSync/ClientContext の書込先を奪わない。
  const reserved = CASE_LIST_HEADERS.concat(_MASTER_SYNC_PROGRESS_HEADERS, ['顧客コンテキスト']);
  const width = Math.max(sheet.getLastColumn(), reserved.length);
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(String);
  reserved.forEach(function (name, i) {
    if (!headers[i]) { sheet.getRange(1, i + 1).setValue(name); headers[i] = name; }
  });
  _MEETING_HEADERS.forEach(function (name) {
    if (headers.indexOf(name) >= 0) return;
    headers.push(name);
    if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), 1);
    sheet.getRange(1, headers.length).setValue(name).setFontWeight('bold').setBackground('#cfe2f3');
  });
  const cols = {};
  headers.forEach(function (name, i) { if (name) cols[name] = i + 1; });
  return cols;
}

function Meeting_ensureColumns() {
  return _Meeting_locked(function () { return { ok: true, columns: _Meeting_columns(_Meeting_sheet()) }; });
}

/** timezone の無い入力は必ず JST。Date の日付のみセルは10時にする。 */
function _Meeting_parseDate(value, numberFormat) {
  if (value === '' || value == null) return null;
  let text;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) throw new Error('次回打合せ日時が不正です');
    text = Utilities.formatDate(value, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss");
    if (text.slice(11) === '00:00:00' && !/[hHsS]/.test(numberFormat || '')) text = text.slice(0, 10);
  } else { text = String(value).trim(); }
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!m) throw new Error('次回打合せ日時は年月日と時刻で入力してください');
  const y = +m[1], mo = +m[2], d = +m[3], h = m[4] === undefined ? 10 : +m[4], min = +(m[5] || 0), sec = +(m[6] || 0);
  const check = new Date(Date.UTC(y, mo - 1, d, h, min, sec));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || min > 59 || sec > 59) throw new Error('次回打合せ日時が不正です');
  return new Date(check.getTime() - 9 * 3600000);
}

function _Meeting_key(start) { return Utilities.formatDate(start, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss"); }
function _Meeting_due(start, now) {
  const day = _Meeting_key(start).slice(0, 10);
  const threshold = new Date(day + 'T09:00:00+09:00').getTime() - 86400000;
  return now.getTime() >= threshold && now.getTime() < start.getTime();
}

function _Meeting_clientEmail(context) {
  const candidates = String(context || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const external = candidates.filter(function (email) { return !/@(?:[^@]+\.)?orgiast\.jp$/i.test(email); });
  const unique = external.filter(function (email, i) { return external.map(function (e) { return e.toLowerCase(); }).indexOf(email.toLowerCase()) === i; });
  return unique.length === 1 ? unique[0] : '';
}

/** 件名・本文を差し替える場合はここだけを編集する。 */
function Meeting_draftTemplate(c, start, meetUrl, email) {
  const date = Utilities.formatDate(start, 'Asia/Tokyo', 'M月d日') + '(' + '日月火水木金土'[new Date(start.getTime() + 9 * 3600000).getUTCDay()] + ')';
  const time = Utilities.formatDate(start, 'Asia/Tokyo', 'HH:mm');
  const end = Utilities.formatDate(new Date(start.getTime() + 3600000), 'Asia/Tokyo', 'HH:mm');
  return {
    subject: (email ? '' : '【宛先未設定】') + '【ご確認】明日' + date + ' ' + time + '〜 お打合せの件（' + c.caseName + '）',
    body: c.clientName + '\nご担当者様\n\nいつもお世話になっております。\n株式会社オージャストでございます。\n\n明日' + date + ' ' + time + '〜のお打合せ、どうぞよろしくお願いいたします。\n下記のGoogle Meet URLよりご参加ください。\n\n■日時：' + Utilities.formatDate(start, 'Asia/Tokyo', 'yyyy年') + date + ' ' + time + '〜' + end + '\n■Google Meet：' + meetUrl + '\n\nご不明な点がございましたら、お気軽にご連絡ください。\n引き続きどうぞよろしくお願いいたします。'
  };
}

function _Meeting_processRow(sheet, cols, row, now, forceDraft) {
  const values = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  function value(name) { return values[cols[name] - 1]; }
  function write(name, v) { const cell = sheet.getRange(row, cols[name]); if (name === '前日下書き済') cell.setNumberFormat('@'); cell.setValue(v); values[cols[name] - 1] = v; SpreadsheetApp.flush(); }
  const c = { caseId: String(value('案件ID') || ''), clientName: String(value('クライアント名') || ''), caseName: String(value('案件名') || '') };
  if (!c.caseId) return { skipped: true };
  const start = _Meeting_parseDate(value('次回打合せ日時'), sheet.getRange(row, cols['次回打合せ日時']).getNumberFormat());
  if (!start || start.getTime() <= now.getTime()) return { caseId: c.caseId, skipped: true };
  const key = _Meeting_key(start);
  const calendarId = PropertiesService.getScriptProperties().getProperty('MEETING_CALENDAR_ID') || 'primary';
  let eventId = String(value('打合せイベントID') || '');
  const window = { start: { dateTime: start.toISOString(), timeZone: 'Asia/Tokyo' }, end: { dateTime: new Date(start.getTime() + 3600000).toISOString(), timeZone: 'Asia/Tokyo' } };
  let event;
  if (!eventId) {
    event = _CaseMeet_insertEvent({ summary: '【打合せ】' + c.clientName + ' ' + c.caseName, description: '案件ID: ' + c.caseId,
      start: window.start, end: window.end, reminders: { useDefault: false, overrides: [] } }, calendarId, 'meeting-' + Utilities.getUuid());
    eventId = event.id;
    // Meet の非同期発行より先に保存し、pending/失敗でも次の巡回で同じ予定を利用する。
    write('打合せイベントID', eventId);
    write('前日下書き済', '');
  } else {
    event = Calendar.Events.get(calendarId, eventId);
    if (event.status === 'cancelled') throw new Error('打合せ予定が削除されています。イベントIDを確認してください');
    if (new Date((event.start || {}).dateTime).getTime() !== start.getTime() || new Date((event.end || {}).dateTime).getTime() !== start.getTime() + 3600000) {
      // 更新失敗時も再試行でき、更新成功後のマーカー消去漏れも避ける。
      write('前日下書き済', '');
      event = Calendar.Events.patch(window, calendarId, eventId, { sendUpdates: 'none', conferenceDataVersion: 1 });
    }
  }
  let email = String(value('顧客メール') || '').trim();
  if (!email) {
    email = _Meeting_clientEmail(Case_loadClientContext(c));
    if (email) write('顧客メール', email);
  }
  const result = { caseId: c.caseId, eventId: eventId, drafted: false };
  if ((forceDraft || _Meeting_due(start, now)) && String(value('前日下書き済') || '') !== key) {
    const url = _CaseMeet_waitForUrl(calendarId, event);
    if (!url) throw new Error('Meet URL が未発行です。次回巡回で再試行します');
    const mail = Meeting_draftTemplate(c, start, url, email);
    const draft = GmailApp.createDraft(email, mail.subject, mail.body);
    write('前日下書き済', key);
    result.drafted = true;
    result.draftId = draft.getId();
  }
  return result;
}

function _Meeting_run(sheet, cols, caseId, forceDraft) {
  const now = new Date(), results = [], errors = [];
  const ids = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, cols['案件ID'], sheet.getLastRow() - 1, 1).getValues();
  ids.forEach(function (id, i) {
    if (!id[0] || (caseId && String(id[0]) !== String(caseId))) return;
    try { results.push(_Meeting_processRow(sheet, cols, i + 2, now, forceDraft)); }
    catch (e) {
      const error = { caseId: String(id[0]), error: String(e.message || e) };
      console.error('Meeting_sweep: ' + JSON.stringify(error));
      errors.push(error);
    }
  });
  if (caseId && !results.length && !errors.length) throw new Error('案件が見つかりません: ' + caseId);
  return { ok: !errors.length, results: results, errors: errors };
}

function Meeting_sweep() {
  const result = _Meeting_locked(function () { const s = _Meeting_sheet(); return _Meeting_run(s, _Meeting_columns(s)); });
  try { MailApproval_poll(); MailApproval_renotify(); } catch (e) { console.warn('MailApproval sweep: ' + (e.message || e)); }
  try { MeetingSeries_retryPendingSweep(); } catch (e) { console.warn('MeetingSeries retry sweep: ' + (e.message || e)); }
  return result;
}

function Meeting_testDraftForCase(caseId) {
  if (!caseId) throw new Error('案件IDが必要です');
  return _Meeting_locked(function () { const s = _Meeting_sheet(); return _Meeting_run(s, _Meeting_columns(s), caseId, true); });
}

function Meeting_saveForCase(caseId, payload) {
  payload = payload || {};
  const start = _Meeting_parseDate(payload.nextMeetingAt);
  return _Meeting_locked(function () {
    const s = _Meeting_sheet(), cols = _Meeting_columns(s);
    const ids = s.getRange(2, cols['案件ID'], Math.max(1, s.getLastRow() - 1), 1).getValues();
    const index = ids.findIndex(function (r) { return String(r[0]) === String(caseId); });
    if (!caseId || index < 0) throw new Error('案件が見つかりません: ' + caseId);
    s.getRange(index + 2, cols['次回打合せ日時']).setNumberFormat('yyyy/MM/dd HH:mm').setValue(start || '');
    s.getRange(index + 2, cols['顧客メール']).setValue(String(payload.clientEmail || '').trim());
    SpreadsheetApp.flush();
    return _Meeting_run(s, cols, caseId);
  });
}

function Meeting_getForCase(caseId) {
  const s = _Meeting_sheet(), data = s.getDataRange().getValues(), headers = data[0].map(String);
  const row = data.slice(1).filter(function (r) { return String(r[headers.indexOf('案件ID')]) === String(caseId); })[0];
  if (!row) throw new Error('案件が見つかりません: ' + caseId);
  const col = headers.indexOf('次回打合せ日時');
  const start = col < 0 ? null : _Meeting_parseDate(row[col], s.getRange(data.indexOf(row) + 1, col + 1).getNumberFormat());
  return { nextMeetingAt: start ? _Meeting_key(start).slice(0, 16) : '', clientEmail: String(row[headers.indexOf('顧客メール')] || '') };
}

function Meeting_installTrigger() {
  return _Meeting_locked(function () {
    _Meeting_columns(_Meeting_sheet());
    const existing = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'Meeting_sweep'; });
    existing.slice(1).forEach(function (t) { ScriptApp.deleteTrigger(t); });
    if (!existing.length) ScriptApp.newTrigger('Meeting_sweep').timeBased().everyMinutes(15).create();
    return { ok: true, created: existing.length ? 0 : 1, removed: Math.max(0, existing.length - 1) };
  });
}
