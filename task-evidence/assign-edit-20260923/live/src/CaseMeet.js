/**
 * 案件専用 Google Meet を作成し、実施計画書の Task!D2 に記録する。
 */

const _CASE_MEET_TASK_SHEET_NAMES = ['Task', 'task', 'タスク'];
const _CASE_MEET_CELL = 'D2';
const _CASE_MEET_PROP_CALENDAR = 'CASE_MEET_CALENDAR_ID';

/** 値に Google Meet URL が含まれるか。 */
function _CaseMeet_isMeetUrl(value) {
  return String(value == null ? '' : value).indexOf('meet.google.com/') >= 0;
}

function _CaseMeet_extractUrl(value) {
  const match = String(value == null ? '' : value).match(/https?:\/\/meet\.google\.com\/[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*/i);
  return match ? match[0] : '';
}

/**
 * Task!D2 の現在値から、書き込み可否を決める。
 *
 * D2 は運用上「■GoogleMeetURL」等のラベル（社内マニュアルへのハイパーリンク付き）が
 * 入っている前提で、そこを案件専用 Meet URL で置き換える（kim 2026-09-18 指示）。
 * ただし**既に完全な Meet URL が入っている場合だけは上書きしない** — 共有済みの部屋を殺さないため。
 */
function _CaseMeet_decideWrite(currentValue, currentFormula) {
  const value = String(currentValue == null ? '' : currentValue);
  const formula = String(currentFormula == null ? '' : currentFormula);
  const url = _CaseMeet_extractUrl(value) || _CaseMeet_extractUrl(formula);
  if (url) return { action: 'reuse', url: url };
  return { action: 'write', previous: (value || formula).slice(0, 80) };
}

/** Calendar に表示する案件専用 Meet の名前。 */
function _CaseMeet_eventTitle(clientName, caseName) {
  return ('🎥 ' + String(clientName || '') + ' / ' + String(caseName || '') + ' 専用Meet').slice(0, 200);
}

function _CaseMeet_dateParts(startDate) {
  if (startDate instanceof Date && !isNaN(startDate.getTime())) {
    const jst = new Date(startDate.getTime() + 9 * 60 * 60 * 1000);
    return [jst.getUTCFullYear(), jst.getUTCMonth() + 1, jst.getUTCDate()];
  }
  const match = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(String(startDate == null ? '' : startDate).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() + 1 !== month || checked.getUTCDate() !== day) return null;
  return [year, month, day];
}

/** 指定日（不正なら本日）の 09:00–09:30 JST を RFC3339 で返す。 */
function _CaseMeet_eventWindow(startDate) {
  let parts = _CaseMeet_dateParts(startDate);
  if (!parts) {
    const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    parts = [nowJst.getUTCFullYear(), nowJst.getUTCMonth() + 1, nowJst.getUTCDate()];
  }
  const date = String(parts[0]).padStart(4, '0') + '-' + String(parts[1]).padStart(2, '0') + '-' + String(parts[2]).padStart(2, '0');
  return {
    startIso: date + 'T09:00:00+09:00',
    endIso: date + 'T09:30:00+09:00'
  };
}

/** 案件専用 Meet URL を確保し、実施計画書 Task!D2 に書き込む。 */
function CaseMeet_ensure(caseId, opts) {
  opts = opts || {};
  const c = CaseList_getById(caseId);
  if (!c) return { ok: false, caseId: caseId, reason: '案件が見つかりません' };
  if (!c.zissiId) return { ok: false, caseId: caseId, reason: '実施計画書が未設定' };

  const ss = SpreadsheetApp.openById(c.zissiId);
  let taskSheet = null;
  for (let i = 0; i < _CASE_MEET_TASK_SHEET_NAMES.length; i++) {
    taskSheet = ss.getSheetByName(_CASE_MEET_TASK_SHEET_NAMES[i]);
    if (taskSheet) break;
  }
  if (!taskSheet) return { ok: false, caseId: caseId, reason: 'Task シートが見つかりません' };

  const range = taskSheet.getRange(_CASE_MEET_CELL);
  const decision = _CaseMeet_decideWrite(range.getValue(), range.getFormula());
  if (decision.action === 'reuse') {
    return { ok: true, caseId: caseId, meetUrl: decision.url, reused: true };
  }
  if (decision.action === 'skip') {
    return { ok: false, caseId: caseId, reason: decision.reason, current: decision.current };
  }
  if (opts.dryRun) return { ok: true, caseId: caseId, dryRun: true, action: 'write', reused: false, previous: decision.previous };

  const calendarId = PropertiesService.getScriptProperties().getProperty(_CASE_MEET_PROP_CALENDAR) || 'primary';
  const window = _CaseMeet_eventWindow(c.startDate);
  const zissiUrl = 'https://docs.google.com/spreadsheets/d/' + c.zissiId + '/edit';
  const created = Calendar.Events.insert({
    summary: _CaseMeet_eventTitle(c.clientName, c.caseName),
    description: '案件専用の常設 Meet です（予定ではありません）\n実施計画書: ' + zissiUrl + '\ncaseId: ' + caseId,
    start: { dateTime: window.startIso, timeZone: 'Asia/Tokyo' },
    end: { dateTime: window.endIso, timeZone: 'Asia/Tokyo' },
    transparency: 'transparent',
    reminders: { useDefault: false, overrides: [] },
    conferenceData: {
      createRequest: {
        requestId: 'case-' + caseId + '-' + Date.now(),
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  }, calendarId, { conferenceDataVersion: 1 });

  let meetUrl = String(created.hangoutLink || '');
  for (let attempt = 0; !meetUrl && attempt < 3; attempt++) {
    Utilities.sleep(2000);
    meetUrl = String(Calendar.Events.get(calendarId, created.id).hangoutLink || '');
  }
  if (!meetUrl) {
    Calendar.Events.remove(calendarId, created.id);
    return { ok: false, caseId: caseId, reason: 'Meet URL を取得できませんでした' };
  }

  range.setValue(meetUrl);
  SpreadsheetApp.flush();
  if (String(taskSheet.getRange(_CASE_MEET_CELL).getValue()) !== meetUrl) {
    throw new Error('Task!D2 の read-back verify に失敗しました');
  }
  try { MasterWriteBack_recordArtifact(caseId, '案件Meet', '案件専用Meet', meetUrl); } catch (e) {}
  return { ok: true, caseId: caseId, meetUrl: meetUrl, eventId: created.id, calendarId: calendarId, reused: false, previous: decision.previous };
}

/** 案件一覧を上から指定件数ずつ処理する。 */
function CaseMeet_backfillAll(opts) {
  opts = opts || {};
  const allCases = CaseList_listAll();
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Number(opts.limit) || 30);
  const targets = allCases.slice(offset, offset + limit);
  const result = { ok: true, total: targets.length, created: 0, reused: 0, replaced: [], skipped: [], failed: [] };
  targets.forEach(function (c) {
    const caseId = String(c.caseId || '');
    try {
      const one = CaseMeet_ensure(caseId, { dryRun: opts.dryRun === true });
      if (!one.ok) result.skipped.push({ caseId: caseId, reason: one.reason, current: String(one.current == null ? '' : one.current).slice(0, 80) });
      else if (one.reused) result.reused++;
      else {
        if (!opts.dryRun) result.created++;
        if (one.previous) result.replaced.push({ caseId: caseId, previous: one.previous });
      }
    } catch (e) {
      result.failed.push({ caseId: caseId, error: String(e && e.message || e) });
    }
  });
  result.remaining = Math.max(0, allCases.length - offset - targets.length);
  if (result.remaining) result.nextOffset = offset + targets.length;
  if (opts.dryRun) result.dryRun = true;
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _CaseMeet_isMeetUrl: _CaseMeet_isMeetUrl,
    _CaseMeet_decideWrite: _CaseMeet_decideWrite,
    _CaseMeet_eventTitle: _CaseMeet_eventTitle,
    _CaseMeet_eventWindow: _CaseMeet_eventWindow
  };
}

/**
 * Calendar スコープを1回だけ承認させるためのメニュー用関数。
 * 実処理はしない。承認ダイアログを出すことだけが目的。
 */
function CaseMeet_authorizeOnce() {
  const ui = SpreadsheetApp.getUi();
  try {
    Calendar.CalendarList.get('primary');
    ui.alert('Google Meet の連携', '承認が完了しました。\n\nこの後の案件登録から、実施計画書の Task!D2 に案件専用の Meet URL が自動で入ります。\nこのウィンドウは閉じて大丈夫です。', ui.ButtonSet.OK);
    return { ok: true };
  } catch (e) {
    ui.alert('Google Meet の連携', '承認できませんでした:\n' + String(e && e.message || e), ui.ButtonSet.OK);
    return { ok: false, error: String(e && e.message || e) };
  }
}
