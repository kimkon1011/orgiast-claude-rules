/**
 * 案件専用 Google Meet を作成し、実施計画書の Task!D2 に記録する。
 */

const _CASE_MEET_TASK_SHEET_NAMES = ['Task', 'task', 'タスク'];
const _CASE_MEET_CELL = 'D2';
const _CASE_MEET_PROP_CALENDAR = 'CASE_MEET_CALENDAR_ID';
const _CASE_MEET_CALENDAR_SUMMARY = '🎥 案件専用Meet（予定ではありません）';
const _CASE_MEET_SHARE_DOMAIN = 'orgiast.jp';

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
  const created = _CaseMeet_insertEvent({
    summary: _CaseMeet_eventTitle(c.clientName, c.caseName),
    description: '案件専用の常設 Meet です（予定ではありません）\n実施計画書: ' + zissiUrl + '\ncaseId: ' + caseId,
    start: { dateTime: window.startIso, timeZone: 'Asia/Tokyo' },
    end: { dateTime: window.endIso, timeZone: 'Asia/Tokyo' },
    transparency: 'transparent',
    reminders: { useDefault: false, overrides: [] },
  }, calendarId, 'case-' + caseId + '-' + Date.now());

  const meetUrl = _CaseMeet_waitForUrl(calendarId, created);
  if (!meetUrl) {
    Calendar.Events.remove(calendarId, created.id, { sendUpdates: 'none' });
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

/** 実際の予定を移動しないため、3 条件すべてを要求する。 */
function _CaseMeet_isCaseMeetEvent(event) {
  return !!event && typeof event.summary === 'string' && event.summary.endsWith(' 専用Meet') &&
    typeof event.description === 'string' && event.description.indexOf('caseId:') >= 0 &&
    typeof event.hangoutLink === 'string' && /^https:\/\/meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+(?:[?#][^\s]*)?$/i.test(event.hangoutLink);
}

function _CaseMeet_extractCaseId(description) {
  const match = String(description || '').match(/\bcaseId:[ \t]*(C\d+)\b/);
  return match ? match[1] : '';
}

/** 専用カレンダーを再利用または作成し、新規 Meet の保存先に設定する。 */
function CaseMeet_setupCalendar(opts) {
  opts = opts || {};
  const props = PropertiesService.getScriptProperties();
  let calendarId = props.getProperty(_CASE_MEET_PROP_CALENDAR);
  if (calendarId) {
    try {
      Calendar.Calendars.get(calendarId);
      return { ok: true, calendarId: calendarId, created: false };
    } catch (e) {
      // 無効な保存先は一覧から復旧する。
    }
  }
  calendarId = '';
  let pageToken;
  do {
    const page = Calendar.CalendarList.list(pageToken ? { pageToken: pageToken } : {});
    const found = (page.items || []).filter(function (c) { return c.summary === _CASE_MEET_CALENDAR_SUMMARY; })[0];
    if (found) calendarId = found.id;
    pageToken = page.nextPageToken;
  } while (!calendarId && pageToken);

  if (opts.dryRun) {
    return { ok: true, dryRun: true, calendarId: calendarId, created: false, wouldCreate: !calendarId };
  }
  const created = !calendarId;
  if (!calendarId) {
    calendarId = Calendar.Calendars.insert({
      summary: _CASE_MEET_CALENDAR_SUMMARY,
      timeZone: 'Asia/Tokyo',
      description: 'ブース制作アプリが自動作成する案件専用 Meet の置き場。予定ではありません。'
    }).id;
  }
  try {
    Calendar.Acl.insert({ role: 'writer', scope: { type: 'domain', value: _CASE_MEET_SHARE_DOMAIN } }, calendarId);
  } catch (e) {
    // 重複以外（権限不足等）の失敗は保存前に通知し、再実行可能にする。
    if (!/\b409\b|already exists|duplicate/i.test(String(e && e.message || e))) throw e;
  }
  try {
    Calendar.CalendarList.patch({ selected: false }, calendarId);
  } catch (e) {
    console.warn('専用Meet カレンダーの非表示に失敗: ' + String(e && e.message || e));
  }
  props.setProperty(_CASE_MEET_PROP_CALENDAR, calendarId);
  if (props.getProperty(_CASE_MEET_PROP_CALENDAR) !== calendarId) {
    throw new Error('CASE_MEET_CALENDAR_ID の read-back verify に失敗しました');
  }
  return { ok: true, calendarId: calendarId, created: created };
}

/** Meet URL を read-back で確認しながら既存イベントを移動する。 */
function CaseMeet_migrateToCalendar(opts) {
  opts = opts || {};
  const source = opts.source || 'primary';
  const dest = opts.dest || PropertiesService.getScriptProperties().getProperty(_CASE_MEET_PROP_CALENDAR);
  if (!dest) return { ok: false, reason: 'CASE_MEET_CALENDAR_ID 未設定' };
  if (source === dest) return { ok: false, reason: '移動元と移動先が同じです' };
  const candidates = [];
  let pageToken;
  do {
    const params = { q: '専用Meet', singleEvents: true, maxResults: 250 };
    if (pageToken) params.pageToken = pageToken;
    const page = Calendar.Events.list(source, params);
    (page.items || []).forEach(function (event) {
      if (_CaseMeet_isCaseMeetEvent(event)) candidates.push({
        eventId: event.id, caseId: _CaseMeet_extractCaseId(event.description),
        summary: event.summary, start: event.start, hangoutLink: event.hangoutLink
      });
    });
    pageToken = page.nextPageToken;
  } while (pageToken);
  if (opts.dryRun) return { ok: true, dryRun: true, total: candidates.length, candidates: candidates };

  // 再開時にも同じ順序に揃える（Calendar のデフォルト順序には依存しない）。
  candidates.sort(function (a, b) { return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0; });
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const limit = Math.max(1, Math.floor(Number(opts.limit) || 30));
  const targets = candidates.slice(offset, offset + limit);
  const result = { ok: true, total: candidates.length, moved: [], failed: [], remaining: 0, nextOffset: null };
  let removed = 0;
  targets.forEach(function (event) {
    const before = event.hangoutLink;
    let movedId = '';
    let failure;
    try {
      const moved = Calendar.Events.move(source, event.eventId, dest);
      movedId = moved.id;
      const after = Calendar.Events.get(dest, movedId).hangoutLink;
      if (after === before) {
        result.moved.push({ caseId: event.caseId, eventId: movedId, hangoutLink: after });
        removed++;
        return;
      }
      failure = { caseId: event.caseId, eventId: event.eventId, reason: 'Meet URL が変わった', before: before, after: after };
    } catch (e) {
      failure = { caseId: event.caseId, eventId: event.eventId, reason: String(e && e.message || e) };
    }
    // read-back 自体の失敗でも、検証できていない移動は元へ戻す。
    if (movedId) {
      try {
        Calendar.Events.move(dest, movedId, source);
      } catch (e) {
        failure.rollbackError = String(e && e.message || e);
        removed++;
      }
    }
    result.failed.push(failure);
  });
  result.remaining = Math.max(0, candidates.length - offset - targets.length);
  // 成功分は元一覧から消える。単純な offset + limit では未処理分を飛ばす。
  if (result.remaining) result.nextOffset = offset + targets.length - removed;
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _CaseMeet_isMeetUrl: _CaseMeet_isMeetUrl,
    _CaseMeet_isCaseMeetEvent: _CaseMeet_isCaseMeetEvent,
    _CaseMeet_extractCaseId: _CaseMeet_extractCaseId,
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

/** 共通の Meet 付き予定作成。招待・更新通知は送らない。 */
function _CaseMeet_insertEvent(resource, calendarId, requestId) {
  resource.conferenceData = {
    createRequest: { requestId: requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } }
  };
  return Calendar.Events.insert(resource, calendarId, { conferenceDataVersion: 1, sendUpdates: 'none' });
}

function _CaseMeet_waitForUrl(calendarId, event) {
  function urlOf(e) {
    if (e.hangoutLink) return String(e.hangoutLink);
    const entries = (e.conferenceData || {}).entryPoints || [];
    const video = entries.filter(function (p) { return p.entryPointType === 'video'; })[0];
    return video ? String(video.uri || '') : '';
  }
  let url = urlOf(event);
  for (let attempt = 0; !url && attempt < 3; attempt++) {
    Utilities.sleep(2000);
    url = urlOf(Calendar.Events.get(calendarId, event.id));
  }
  return url;
}
