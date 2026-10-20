/**
 * Phase_ScheduleProposal.js - 面談候補の生成とカレンダー確定登録
 * (TASK_ID: REBOOTH-T4-schedule-proposal)
 *
 * 澤山の空き枠と顧客の希望から候補を3つ生成し、返信案に差し込んで承認キューへ送る。
 * 確定した候補だけを seisaku-team@ カレンダーへ Meet 付きで登録する。
 */

var _SCHEDULE_SHEET_NAME = 'Claude_日程調整';
var _SCHEDULE_DEFAULT_SLOTS = 'WED 11:00-12:00';
var _SCHEDULE_LOOKAHEAD_DAYS = 30;

var _SCHEDULE_DOW_MAP = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

// "WED 11:00-12:00, FRI 15:00-16:00" を解析する
function _Schedule_parseSlots_(spec) {
  var out = [];
  String(spec || '').split(',').forEach(function (raw) {
    var s = String(raw || '').trim();
    if (!s) return;
    var m = s.match(/^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/i);
    if (!m) return;
    out.push({
      dow: _SCHEDULE_DOW_MAP[m[1].toUpperCase()],
      startH: Number(m[2]), startM: Number(m[3]), endH: Number(m[4]), endM: Number(m[5])
    });
  });
  return out;
}

// 曜日パターンから、今日から days 日先までの実スロットを展開する
function _Schedule_expandSlots_(patterns, today, days) {
  var slots = [];
  var base = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
  for (var d = 0; d <= days; d++) {
    var day = new Date(base.getTime() + d * 86400000);
    patterns.forEach(function (p) {
      if (day.getDay() !== p.dow) return;
      slots.push({
        start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), p.startH, p.startM, 0, 0),
        end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), p.endH, p.endM, 0, 0)
      });
    });
  }
  return slots;
}

// シートの日付・時刻セルを Date に寄せる（"2026-10-15" / Date / "11:00" いずれも許容）
function _Schedule_toDate_(dateVal, timeVal) {
  try {
    var base;
    if (dateVal instanceof Date) {
      base = new Date(dateVal.getFullYear(), dateVal.getMonth(), dateVal.getDate(), 0, 0, 0, 0);
    } else {
      var ds = String(dateVal || '').trim();
      var dm = ds.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (!dm) return null;
      base = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0, 0);
    }
    var h = 0, mi = 0;
    if (timeVal instanceof Date) { h = timeVal.getHours(); mi = timeVal.getMinutes(); }
    else {
      var tm = String(timeVal || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!tm) return null;
      h = Number(tm[1]); mi = Number(tm[2]);
    }
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, 0, 0);
  } catch (e) { return null; }
}

// 澤山の空き枠（Script Property SAWAYAMA_AVAILABILITY_SHEET_ID → SAWAYAMA_FIXED_SLOTS → 既定）
function _Schedule_readAvailabilitySlots_() {
  var props = PropertiesService.getScriptProperties();
  var today = new Date();
  var sheetId = props.getProperty('SAWAYAMA_AVAILABILITY_SHEET_ID') || '';
  if (sheetId) {
    try {
      var ss = SpreadsheetApp.openById(sheetId);
      var values = ss.getSheets()[0].getDataRange().getValues();
      var slots = [];
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0]) continue;
        var start = _Schedule_toDate_(row[0], row[1]);
        var end = _Schedule_toDate_(row[0], row[2]);
        if (start && end) slots.push({ start: start, end: end });
      }
      if (slots.length) return slots;
    } catch (e) {
      console.warn('Phase_ScheduleProposal availability read failed: ' + (e.message || e));
    }
  }
  var spec = props.getProperty('SAWAYAMA_FIXED_SLOTS') || _SCHEDULE_DEFAULT_SLOTS;
  return _Schedule_expandSlots_(_Schedule_parseSlots_(spec), today, _SCHEDULE_LOOKAHEAD_DAYS);
}

// 面談カレンダーの既存予定（busy）を直近 days 日分だけ取る。読めなければ [] にフォールバック
function _Schedule_readBusy_(calendarId, today, days) {
  if (!calendarId) return [];
  try {
    var cal = CalendarApp.getCalendarById(calendarId);
    var start = new Date(today.getTime());
    var end = new Date(today.getTime() + days * 86400000);
    return cal.getEvents(start, end).map(function (ev) {
      return { start: ev.getStartTime(), end: ev.getEndTime() };
    });
  } catch (e) {
    console.warn('Phase_ScheduleProposal busy read failed: ' + (e.message || e));
    return [];
  }
}

// 顧客の希望表現（午前/午後）を顧客コンテキストから拾う。無ければ空
function _Schedule_detectPrefer_(context) {
  var text = String(context || '');
  if (text.indexOf('午後') >= 0) return 'pm';
  if (text.indexOf('午前') >= 0) return 'am';
  return '';
}

// 「Claude_メール対応」シートの返信文案（件名・本文）を探す
function _Schedule_findReplyDraft_(zissiSs) {
  var sheet = zissiSs.getSheetByName('Claude_メール対応');
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return null;
  var values = sheet.getRange(1, 1, lastRow, 2).getValues();
  var subject = '', body = '';
  for (var i = 0; i < values.length; i++) {
    var label = String(values[i][0] || '').trim();
    if (label === '件名' && !subject) subject = String(values[i][1] || '');
    if (label === '本文' && !body) body = String(values[i][1] || '');
  }
  if (!subject && !body) return null;
  return { subject: subject, body: body };
}

function _Schedule_ensureSheet_(zissiSs) {
  var sheet = zissiSs.getSheetByName(_SCHEDULE_SHEET_NAME);
  if (!sheet) sheet = zissiSs.insertSheet(_SCHEDULE_SHEET_NAME);
  else sheet.clear();
  return sheet;
}

/**
 * 面談候補を3つ出して返信案に差し込み、承認キューへ送る
 */
function Phase_ScheduleProposal_generate(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var zissiSs = _Zissi_open(c);
  var today = new Date();

  var props = PropertiesService.getScriptProperties();
  var calendarId = props.getProperty('MEETING_CALENDAR_ID') || props.getProperty('MEETING_SERIES_CALENDAR_ID') || '';

  var slots = _Schedule_readAvailabilitySlots_();
  var busy = _Schedule_readBusy_(calendarId, today, _SCHEDULE_LOOKAHEAD_DAYS);

  var context = null;
  try { context = Case_loadClientContext(c); } catch (e) { context = null; }
  var prefer = _Schedule_detectPrefer_(context);

  var picked = ScheduleProposal_pickCandidates({ slots: slots, busy: busy, prefer: prefer, today: today, count: 3 });

  var sheet = _Schedule_ensureSheet_(zissiSs);
  sheet.getRange('A1').setValue('🗓 面談候補').setFontWeight('bold');
  sheet.getRange('B1').setValue(Utilities.formatDate(today, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  sheet.getRange(3, 1, 1, 3).setValues([['#', '候補日時', '状態']]).setFontWeight('bold').setBackground('#cfe2f3');

  var labels = ScheduleProposal_formatCandidates(picked.candidates || []);
  if (labels.length > 0) {
    var rows = labels.map(function (label, i) { return [i + 1, label, '候補']; });
    sheet.getRange(4, 1, rows.length, 3).setValues(rows);
  } else {
    sheet.getRange(4, 1).setValue('空き枠が見つかりませんでした (' + (picked.reason || 'NO_SLOT') + ')。SAWAYAMA_FIXED_SLOTS / MEETING_CALENDAR_ID を確認してください');
  }
  var sheetUrl = PanelLinks_sheetUrl(zissiSs, sheet);

  // 返信案に候補を差し込む
  var draft = _Schedule_findReplyDraft_(zissiSs);
  var body = draft ? draft.body : '';
  var subject = draft ? draft.subject : '';
  var applied = { body: body, applied: false };
  if (body) {
    applied = ScheduleProposal_applyToReply(body, picked.candidates || []);
    if (applied.applied) {
      var sheetMb = zissiSs.getSheetByName('Claude_メール対応');
      if (sheetMb) {
        var lr = sheetMb.getLastRow();
        if (lr >= 1) {
          var vals = sheetMb.getRange(1, 1, lr, 2).getValues();
          for (var k = 0; k < vals.length; k++) {
            if (String(vals[k][0] || '').trim() === '本文' && !sheetMb.getRange(k + 1, 2).getValue()) {
              sheetMb.getRange(k + 1, 2).setValue(applied.body);
              break;
            }
          }
        }
      }
    }
  }
  if (!subject) {
    subject = '【reブース提案】' + (c.clientName || '') + ' 様 面談日程のご相談';
  }
  if (!applied.body) {
    applied.body = 'お世話になっております。株式会社オージャストです。\n下記のいずれかでお打ち合わせの日程をいただけますでしょうか。';
  }

  var proposeResult = null;
  try {
    proposeResult = MailApproval_propose(caseId, { subject: subject, body: applied.body, source: 'schedule_proposal' });
  } catch (e) {
    console.warn('Phase_ScheduleProposal MailApproval_propose failed: ' + (e.message || e));
    proposeResult = { ok: false, error: String(e.message || e) };
  }

  try {
    TaskLedger_upsert(caseId, [{
      source: '日程調整',
      taskName: '面談日程の確定',
      detail: '顧客の返信後に候補を確定しカレンダー登録 (候補' + labels.length + '件)',
      evidence: '面談候補 ' + labels.join(' / '),
      due: '',
      owner: 'オージャスト',
      aiFeature: '🗓 面談を確定して登録',
      sourceStatus: 'open'
    }]);
  } catch (e) { console.warn('Phase_ScheduleProposal ledger failed: ' + (e.message || e)); }

  CaseList_touchUpdatedAt(caseId);
  try { MasterWriteBack_recordArtifact(caseId, '日程調整', '面談候補' + labels.length + '件', sheetUrl); } catch (e) {}

  return {
    ok: true,
    candidateCount: labels.length,
    candidates: labels,
    prefer: prefer,
    appliedToReply: applied.applied,
    proposeResult: proposeResult,
    sheetUrl: sheetUrl
  };
}

/**
 * 選ばれた候補でカレンダーに Meet 付き予定を登録する
 */
function Phase_ScheduleProposal_confirm(caseId, index) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var idx = Number(index);
  if (!idx || idx < 1) idx = 1;

  var zissiSs = _Zissi_open(c);
  var sheet = zissiSs.getSheetByName(_SCHEDULE_SHEET_NAME);
  if (!sheet) throw new Error('先に「🗓 面談候補を3つ出す」を実行してください');

  var rows = sheet.getRange(3, 1, Math.max(sheet.getLastRow() - 2, 1), 3).getValues();
  var target = null;
  for (var i = 0; i < rows.length; i++) {
    if (Number(rows[i][0]) === idx) { target = rows[i]; break; }
  }
  if (!target) throw new Error('候補 ' + idx + ' が見つかりません');
  if (String(target[2]) === '確定') {
    return { ok: true, alreadyConfirmed: true, label: String(target[1]) };
  }

  var label = String(target[1] || '');
  // ラベル "10/15(水) 11:00〜12:00" をパース
  var m = label.match(/(\d{2})\/(\d{2})\(.\)\s+(\d{1,2}):(\d{2})\s*[〜~]\s*(\d{1,2}):(\d{2})/);
  if (!m) throw new Error('候補の日時を読み取れません: ' + label);

  var year = new Date().getFullYear();
  var month = Number(m[1]) - 1, day = Number(m[2]);
  var start = new Date(year, month, day, Number(m[3]), Number(m[4]), 0, 0);
  var end = new Date(year, month, day, Number(m[5]), Number(m[6]), 0, 0);
  if (start.getTime() < new Date().getTime() - 86400000) start.setFullYear(year + 1), end.setFullYear(year + 1);

  var props = PropertiesService.getScriptProperties();
  var calendarId = props.getProperty('MEETING_CALENDAR_ID') || props.getProperty('MEETING_SERIES_CALENDAR_ID') || '';

  var result = { ok: false, status: 'ERROR', eventId: '', meetUrl: '' };
  try {
    var attendees = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
    var resource = {
      summary: '【reブース提案】' + (c.clientName || ''),
      description: '案件: ' + (c.caseName || '') + '\n面談候補から確定 (' + label + ')',
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Tokyo' },
      end: { dateTime: end.toISOString(), timeZone: 'Asia/Tokyo' },
      attendees: attendees.map(function (e) { return { email: e }; }),
      conferenceData: {
        createRequest: {
          requestId: 'sched-' + caseId + '-' + Utilities.getUuid(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    };
    var created = Calendar.Events.insert(resource, calendarId, { conferenceDataVersion: 1, sendUpdates: 'all' });
    result.ok = true;
    result.status = 'CREATED';
    result.eventId = created.id;
    result.meetUrl = created.hangoutLink || '';
  } catch (e) {
    var msg = String(e.message || e);
    result.status = /permission|access|denied|forbidden|403/i.test(msg) ? 'PENDING_CALENDAR_ACCESS' : 'ERROR';
    result.error = msg;
    console.warn('Phase_ScheduleProposal confirm failed: ' + msg);
  }

  // シートの状態を更新（成功時のみ確定。失敗時は理由を残す）
  for (var r = 0; r < rows.length; r++) {
    if (Number(rows[r][0]) === idx) {
      sheet.getRange(3 + 1 + r, 3).setValue(result.ok ? '確定' : result.status);
      break;
    }
  }
  CaseList_touchUpdatedAt(caseId);
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Phase_ScheduleProposal_generate: Phase_ScheduleProposal_generate,
    Phase_ScheduleProposal_confirm: Phase_ScheduleProposal_confirm,
    _Schedule_parseSlots_: _Schedule_parseSlots_,
    _Schedule_expandSlots_: _Schedule_expandSlots_,
    _Schedule_detectPrefer_: _Schedule_detectPrefer_
  };
}
