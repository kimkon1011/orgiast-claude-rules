/**
 * 打合せ系列・ネガチェックの一括カレンダー登録および進捗管理（GAS）。
 *
 * 設計書 docs/REBOOTH-OPS-DESIGN-2026-10-12.md §4 #8、付録 C-c に基づく。
 */

const _MEETING_SERIES_SHEET_NAME = 'Claude_打合せ系列';
const _MEETING_SERIES_HEADERS = ['kind', 'index', 'eventId', 'start', 'end', 'status', 'warning', 'meetUrl', 'summary'];
const _MEETING_SERIES_HOLIDAY_CAL = 'ja.japanese#holiday@group.v.calendar.google.com';
const _MEETING_SERIES_DEFAULT_CAL = 'seisaku-team@orgiast.jp';

/** 日本の祝日を取得（開始日〜終了日） */
function _MeetingSeries_fetchHolidays(startDateStr, endDateStr) {
  var holidays = [];
  try {
    var cal = CalendarApp.getCalendarById(_MEETING_SERIES_HOLIDAY_CAL);
    if (cal) {
      var s = new Date(startDateStr + 'T00:00:00+09:00');
      var e = new Date(endDateStr + 'T23:59:59+09:00');
      var events = cal.getEvents(s, e);
      events.forEach(function (ev) {
        holidays.push(Utilities.formatDate(ev.getStartTime(), 'Asia/Tokyo', 'yyyy-MM-dd'));
      });
    }
  } catch (e) {
    console.warn('祝日カレンダーの取得に失敗: ' + (e.message || e));
  }
  return holidays;
}

/** 実施計画書 Spreadsheet を取得 */
function _MeetingSeries_openZissi(c) {
  if (c && c.zissiId) {
    try {
      return SpreadsheetApp.openById(c.zissiId);
    } catch (e) {}
  }
  if (typeof _Zissi_open === 'function') {
    return _Zissi_open(c);
  }
  return null;
}

/** 案件シート Claude_打合せ系列 を準備（なければ作成） */
function _MeetingSeries_ensureSheet(ss) {
  var sheet = ss.getSheetByName(_MEETING_SERIES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(_MEETING_SERIES_SHEET_NAME);
    sheet.getRange(1, 1, 1, _MEETING_SERIES_HEADERS.length)
      .setValues([_MEETING_SERIES_HEADERS])
      .setFontWeight('bold')
      .setBackground('#cfe2f3');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 既存の登録状況を読み込む */
function _MeetingSeries_readExisting(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, _MEETING_SERIES_HEADERS.length).getValues();
  return values.map(function (row, idx) {
    var obj = { rowIndex: idx + 2 };
    _MEETING_SERIES_HEADERS.forEach(function (h, i) {
      obj[h] = row[i] instanceof Date ? Utilities.formatDate(row[i], 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss+09:00") : String(row[i] == null ? '' : row[i]);
    });
    return obj;
  });
}

/**
 * 案件情報からディレクターメール、顧客メール、案件コードなどを収集
 */
function _MeetingSeries_resolveCaseInfo(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var clientEmail = '';
  var directorEmail = '';
  var projectCode = '';
  var clientName = c.clientName || '';
  var showName = c.caseName || '';

  // 1. 顧客メール
  try {
    var mInfo = Meeting_getForCase(caseId);
    if (mInfo && mInfo.clientEmail) clientEmail = mInfo.clientEmail;
  } catch (e) {}
  if (!clientEmail) {
    try {
      clientEmail = _Meeting_clientEmail(Case_loadClientContext(c));
    } catch (e) {}
  }

  // 2. ディレクターメール
  // ChecklistCaseConfig または ChecklistCaseContext から取得
  try {
    if (typeof Checklist_getCaseConfig === 'function') {
      var cfg = Checklist_getCaseConfig(caseId);
      if (cfg && cfg.directorEmail) directorEmail = cfg.directorEmail;
    }
  } catch (e) {}
  if (!directorEmail) {
    try {
      if (typeof Checklist_getCaseContext === 'function') {
        var ctx = Checklist_getCaseContext(caseId);
        if (ctx && ctx.contacts) {
          var d = ctx.contacts.filter(function (ct) { return ct.role === 'ディレクター' && ct.email; })[0];
          if (d) directorEmail = d.email;
        }
      }
    } catch (e) {}
  }

  // 3. 案件コード
  // 実施計画書名やタスク進捗管理表・アサイン依頼から解決
  try {
    if (c.startDate && typeof _AssignSheet_projectCode === 'function') {
      var codeRes = _AssignSheet_projectCode(c.startDate, c.startDate, c.clientName);
      if (codeRes && codeRes.code) projectCode = codeRes.code;
    }
  } catch (e) {}
  if (!projectCode) {
    var mMatch = showName.match(/(\d{6}[A-Za-z]{2,5})/);
    if (mMatch) projectCode = mMatch[1];
  }
  if (!projectCode && c.startDate) {
    var dMatch = String(c.startDate).replace(/[^\d]/g, '').slice(2, 8);
    projectCode = (dMatch || '000000') + 'XXX';
  }

  return {
    c: c,
    clientName: clientName,
    showName: showName,
    projectCode: projectCode,
    clientEmail: clientEmail,
    directorEmail: directorEmail,
    startDate: c.startDate,
    endDate: c.endDate || c.startDate
  };
}

/**
 * 制作アプリの打合せ系列作成（GAS メイン関数）
 *
 * @param {string} caseId
 * @param {string|Date} [kickoffDate] 省略時は本日またはstartDateの60日前等
 */
function MeetingSeries_create(caseId, kickoffDate) {
  if (!caseId) throw new Error('案件IDが必要です');
  var info = _MeetingSeries_resolveCaseInfo(caseId);
  var c = info.c;

  var zissiSs = _MeetingSeries_openZissi(c);
  if (!zissiSs) throw new Error('実施計画書が見つかりません: ' + caseId);

  var sheet = _MeetingSeries_ensureSheet(zissiSs);
  var existingRows = _MeetingSeries_readExisting(sheet);

  // キックオフ日: 未指定なら本日
  var kDate = kickoffDate || new Date();
  var holidays = _MeetingSeries_fetchHolidays(_MeetingSeries_toDateStr(kDate), _MeetingSeries_addDays(_MeetingSeries_toDateStr(info.endDate), 14));

  var plan = MeetingSeries_planDates({
    kickoff: kDate,
    showStart: info.startDate,
    showEnd: info.endDate,
    holidays: holidays,
    now: new Date()
  });

  // カレンダー ID
  var props = PropertiesService.getScriptProperties();
  var calendarId = props.getProperty('MEETING_SERIES_CALENDAR_ID') ||
    props.getProperty('MEETING_CALENDAR_ID') ||
    _MEETING_SERIES_DEFAULT_CAL;

  // カレンダー書き込み権限の事前チェック（または直接登録の例外キャッチ）
  var canWrite = true;
  var calAccessError = '';
  try {
    // 試行またはカレンダー確認
    CalendarApp.getCalendarById(calendarId);
  } catch (e) {
    canWrite = false;
    calAccessError = String(e.message || e);
  }

  // 予定一覧をフラット化
  var allItems = [];
  plan.meetings.forEach(function (m) { allItems.push(m); });
  plan.negas.forEach(function (n) { allItems.push(n); });
  if (plan.afterMeeting) allItems.push(plan.afterMeeting);

  // 招待者の組み立て: 顧客メール, ディレクターメール, kim@orgiast.jp, seisaku-team@orgiast.jp
  var baseAttendees = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
  if (info.directorEmail && baseAttendees.indexOf(info.directorEmail) < 0) {
    baseAttendees.push(info.directorEmail);
  }

  var updatedRecords = [];
  var nearestMeetingStart = null;
  var nowMs = Date.now();

  allItems.forEach(function (item) {
    var isNega = (item.kind === 'N');
    var summary = MeetingSeries_eventName(item.kind, item.index, info.projectCode, info.clientName, info.showName);

    // ネガの説明文
    var description = isNega
      ? '【MTG日変更などでMTG4日前にネガが開催できない場合は必ず事前に社長、担当プロデューサーに相談報告し了承をいただく】\ncaseId: ' + caseId
      : '【顧客打合せ】' + summary + '\ncaseId: ' + caseId;

    var attendees = baseAttendees.slice();
    if (!isNega && info.clientEmail && attendees.indexOf(info.clientEmail) < 0) {
      attendees.push(info.clientEmail);
    }

    // 既存行を探す (kind, index 一致)
    var existing = existingRows.filter(function (r) {
      return r.kind === item.kind && String(r.index) === String(item.index);
    })[0];

    var eventId = existing ? existing.eventId : '';
    var status = 'CREATED';
    var warning = '';
    var meetUrl = existing ? existing.meetUrl : '';

    if (!canWrite) {
      status = 'PENDING_CALENDAR_ACCESS';
      warning = calAccessError || 'カレンダー書き込み権限がありません';
    } else {
      try {
        var startDt = new Date(item.start);
        var endDt = new Date(item.end);

        if (!eventId) {
          // 新規登録 (Meet 付き)
          var resource = {
            summary: summary,
            description: description,
            start: { dateTime: startDt.toISOString(), timeZone: 'Asia/Tokyo' },
            end: { dateTime: endDt.toISOString(), timeZone: 'Asia/Tokyo' },
            attendees: attendees.map(function (email) { return { email: email }; }),
            conferenceData: {
              createRequest: { requestId: 'series-' + caseId + '-' + item.kind + item.index + '-' + Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } }
            }
          };
          var created = Calendar.Events.insert(resource, calendarId, { conferenceDataVersion: 1, sendUpdates: 'all' });
          eventId = created.id;
          meetUrl = _CaseMeet_waitForUrl ? _CaseMeet_waitForUrl(calendarId, created) : (created.hangoutLink || '');
        } else {
          // 既存更新（冪等）
          try {
            var patchResource = {
              summary: summary,
              description: description,
              start: { dateTime: startDt.toISOString(), timeZone: 'Asia/Tokyo' },
              end: { dateTime: endDt.toISOString(), timeZone: 'Asia/Tokyo' }
            };
            var patched = Calendar.Events.patch(patchResource, calendarId, eventId, { conferenceDataVersion: 1, sendUpdates: 'all' });
            if (!meetUrl) {
              meetUrl = patched.hangoutLink || '';
            }
          } catch (patchErr) {
            if (/404|not found/i.test(String(patchErr.message || patchErr))) {
              // 削除されていたら再作成
              var newCreated = Calendar.Events.insert({
                summary: summary,
                description: description,
                start: { dateTime: startDt.toISOString(), timeZone: 'Asia/Tokyo' },
                end: { dateTime: endDt.toISOString(), timeZone: 'Asia/Tokyo' },
                attendees: attendees.map(function (email) { return { email: email }; }),
                conferenceData: {
                  createRequest: { requestId: 'series-' + caseId + '-' + item.kind + item.index + '-' + Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } }
                }
              }, calendarId, { conferenceDataVersion: 1, sendUpdates: 'all' });
              eventId = newCreated.id;
              meetUrl = _CaseMeet_waitForUrl ? _CaseMeet_waitForUrl(calendarId, newCreated) : (newCreated.hangoutLink || '');
            } else {
              throw patchErr;
            }
          }
        }
      } catch (calErr) {
        var errMsg = String(calErr.message || calErr);
        if (/permission|access|denied|forbidden|403/i.test(errMsg)) {
          status = 'PENDING_CALENDAR_ACCESS';
          warning = errMsg;
        } else {
          status = 'ERROR';
          warning = errMsg;
        }
      }
    }

    updatedRecords.push({
      kind: item.kind,
      index: item.index,
      eventId: eventId,
      start: item.start,
      end: item.end,
      status: status,
      warning: warning,
      meetUrl: meetUrl,
      summary: summary
    });

    // 直近の M（現在日時より後で一番近い M）を探索
    if (item.kind === 'M') {
      var sMs = new Date(item.start).getTime();
      if (sMs > nowMs) {
        if (!nearestMeetingStart || sMs < nearestMeetingStart.getTime()) {
          nearestMeetingStart = new Date(item.start);
        }
      }
    }
  });

  // シートへ全件書き込み（全クリアしてヘッダー＋最新系列行を書き込み）
  sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), _MEETING_SERIES_HEADERS.length).clearContent();
  var outRows = updatedRecords.map(function (rec) {
    return _MEETING_SERIES_HEADERS.map(function (h) {
      return rec[h] || '';
    });
  });
  if (outRows.length > 0) {
    sheet.getRange(2, 1, outRows.length, _MEETING_SERIES_HEADERS.length).setValues(outRows);
  }
  SpreadsheetApp.flush();

  // 案件一覧の「次回打合せ日時」を直近の M に更新
  if (nearestMeetingStart) {
    try {
      _Meeting_locked(function () {
        var caseSheet = _Meeting_sheet();
        var cols = _Meeting_columns(caseSheet);
        var ids = caseSheet.getRange(2, cols['案件ID'], Math.max(1, caseSheet.getLastRow() - 1), 1).getValues();
        var rIdx = ids.findIndex(function (r) { return String(r[0]) === String(caseId); });
        if (rIdx >= 0) {
          caseSheet.getRange(rIdx + 2, cols['次回打合せ日時'])
            .setNumberFormat('yyyy/MM/dd HH:mm')
            .setValue(nearestMeetingStart);
          if (info.clientEmail) {
            caseSheet.getRange(rIdx + 2, cols['顧客メール']).setValue(info.clientEmail);
          }
        }
      });
    } catch (updateErr) {
      console.warn('次回打合せ日時の更新失敗: ' + (updateErr.message || updateErr));
    }
  }

  return {
    ok: true,
    caseId: caseId,
    records: updatedRecords,
    warnings: plan.warnings,
    pendingAccess: updatedRecords.some(function (r) { return r.status === 'PENDING_CALENDAR_ACCESS'; })
  };
}

/**
 * 案件の打合せ系列の状況と警告を取得
 */
function MeetingSeries_status(caseId) {
  if (!caseId) throw new Error('案件IDが必要です');
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var zissiSs = _MeetingSeries_openZissi(c);
  if (!zissiSs) return { ok: false, caseId: caseId, reason: '実施計画書が見つかりません' };

  var sheet = zissiSs.getSheetByName(_MEETING_SERIES_SHEET_NAME);
  if (!sheet) return { ok: true, caseId: caseId, exists: false, records: [] };

  var rows = _MeetingSeries_readExisting(sheet);
  var pending = rows.some(function (r) { return r.status === 'PENDING_CALENDAR_ACCESS'; });
  var warnings = [];
  rows.forEach(function (r) {
    if (r.warning) warnings.push('[' + r.kind + r.index + '] ' + r.warning);
  });

  return {
    ok: true,
    caseId: caseId,
    exists: true,
    records: rows,
    pendingAccess: pending,
    warnings: warnings
  };
}

/**
 * PENDING_CALENDAR_ACCESS が残る案件を1日1回再試行する
 * Meeting_sweep から呼び出される
 */
function MeetingSeries_retryPendingSweep() {
  var props = PropertiesService.getScriptProperties();
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var lastSweepDate = props.getProperty('MEETING_SERIES_LAST_RETRY_DATE');
  if (lastSweepDate === todayStr) {
    return { skipped: 'already_run_today' };
  }

  var cases = CaseList_listAll();
  var retried = 0;
  var errors = [];

  cases.forEach(function (c) {
    try {
      var st = MeetingSeries_status(c.caseId);
      if (st.ok && st.pendingAccess) {
        MeetingSeries_create(c.caseId);
        retried++;
      }
    } catch (e) {
      errors.push({ caseId: c.caseId, error: String(e.message || e) });
    }
  });

  props.setProperty('MEETING_SERIES_LAST_RETRY_DATE', todayStr);
  return { ok: true, retried: retried, errors: errors };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _MEETING_SERIES_SHEET_NAME: _MEETING_SERIES_SHEET_NAME,
    _MEETING_SERIES_HEADERS: _MEETING_SERIES_HEADERS,
    MeetingSeries_create: MeetingSeries_create,
    MeetingSeries_status: MeetingSeries_status,
    MeetingSeries_retryPendingSweep: MeetingSeries_retryPendingSweep
  };
}
