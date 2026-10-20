/**
 * Phase6_Aftercare.js - 本番終了後のアフターケアを一式立ち上げる
 * (TASK_ID: REBOOTH-T6-aftercare)
 *
 * 反省会の登録 → 御礼+アンケートの承認申請 → 報告書生成 → 3ヶ月後フォローの台帳登録 →
 * 次回提案レコードの生成、を 1 機能にまとめる。送信はしない (承認 DM 経由のみ)。
 * 純ロジックは src/AftercareCore.js。既存の Phase6_* 生成ロジックは呼ぶだけで変更しない。
 */

var _AFTERCARE_SHEET_NAME = 'Claude_アフターケア';
var _AFTERCARE_PROPOSAL_SHEET_NAME = 'Claude_次回提案';

/**
 * アフターケア一式を立ち上げる (二重実行してもカレンダー・台帳が重複しない)。
 * @param {string} caseId
 * @returns {Object} 実行サマリ
 */
function Phase6_Aftercare_run(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var zissiSs = _Zissi_open(c);
  if (!zissiSs) throw new Error('実施計画書が見つかりません: ' + caseId);

  var schedule = Aftercare_schedule(c, c.endDate);
  if (!schedule.ok) {
    throw new Error('本番終了日(endDate)が未設定のため、アフターケアの日付を決められません。案件の出展期間を登録してから再実行してください。');
  }

  var sheet = _Aftercare_ensureSheet(zissiSs);
  var state = _Aftercare_readState(sheet);

  var result = {
    ok: true,
    schedule: schedule,
    reviewRegistered: false,
    reviewAlreadyRegistered: false,
    thankYouProposed: false,
    thankYouApprovalId: '',
    report: null,
    ledger: null,
    nextProposal: null,
    nextProposalPosted: false,
    nextProposalSheetUrl: ''
  };

  // a. 反省会を MeetingSeries と同じカレンダーレーンへ 1 件だけ登録 (既存なら二重登録しない)
  if (state.reviewRegistered) {
    result.reviewAlreadyRegistered = true;
    result.reviewRegistered = true;
  } else {
    try {
      var reg = _Aftercare_registerReview(c, schedule.reviewDate);
      result.reviewRegistered = !!reg.ok;
      result.reviewEventId = reg.eventId || '';
      if (!reg.ok) result.reviewError = reg.error || '';
    } catch (e) {
      result.reviewRegistered = false;
      result.reviewError = String((e && e.message) || e);
    }
  }

  // b. 御礼+アンケートを承認キューへ (送信はしない)
  var thankYou = Aftercare_buildThankYou(c);
  if (thankYou.ok && !state.thankYouProposed) {
    try {
      var proposed = MailApproval_propose(caseId, {
        to: String(c.clientEmail || '').trim(),
        subject: thankYou.subject,
        body: thankYou.body,
        source: 'aftercare_thankyou'
      });
      result.thankYouApprovalId = (proposed && (proposed.id || proposed.approvalId)) || '';
      result.thankYouProposed = true;
    } catch (e) {
      result.thankYouError = String((e && e.message) || e);
    }
  } else if (state.thankYouProposed) {
    result.thankYouProposed = true;
    result.thankYouAlreadyProposed = true;
  } else {
    result.thankYouMissing = thankYou.missing;
  }

  // c. 報告書を生成 (既存 Phase6_PostReport_generate を呼ぶだけ)
  if (!state.reportGenerated) {
    try {
      result.report = Phase6_PostReport_generate(caseId);
    } catch (e) {
      result.report = { ok: false, error: String((e && e.message) || e) };
    }
  } else {
    result.report = { ok: true, skipped: true };
  }

  // d. 台帳へ「3ヶ月後フォロー」を期限付きで登録
  try {
    result.ledger = TaskLedger_upsert(caseId, [{
      source: 'アフターケア',
      taskName: '3ヶ月後フォロー',
      detail: '前回出展から3ヶ月。リピート出展の再アポ (印刷面同一なら最大半額) を提案する',
      evidence: 'アフターケア自動起動 (' + schedule.followUpDate + ')',
      due: schedule.followUpDate,
      owner: 'オージャスト',
      aiFeature: '🎉 アフターケアを一式立ち上げる (反省会/御礼/報告書/次回提案)',
      sourceStatus: 'open'
    }]);
  } catch (e) {
    console.warn('Phase6_Aftercare TaskLedger_upsert error: ' + ((e && e.message) || e));
    result.ledger = { error: String((e && e.message) || e) };
  }

  // e. 次回提案レコードを SALES_APP_WEBHOOK_URL があれば POST、無ければ Claude_次回提案 シートへ
  var prediction = _Aftercare_loadPrediction(c);
  var record = Aftercare_nextProposalRecord(c, prediction);
  var validation = Aftercare_validate(record);
  result.nextProposal = { record: record, validation: validation };

  if (validation.ok) {
    var webhookUrl = PropertiesService.getScriptProperties().getProperty('SALES_APP_WEBHOOK_URL') || '';
    if (webhookUrl) {
      try {
        var resp = UrlFetchApp.fetch(webhookUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(record),
          muteHttpExceptions: true
        });
        var code = resp.getResponseCode();
        result.nextProposalPosted = (code >= 200 && code < 300);
        if (!result.nextProposalPosted) {
          console.warn('Phase6_Aftercare webhook failed: ' + code + ' ' + resp.getContentText());
        }
      } catch (e) {
        console.warn('Phase6_Aftercare webhook error: ' + ((e && e.message) || e));
        result.nextProposalPosted = false;
      }
    }
    // webhook 未設定・失敗時は必ずシートへフォールバック (no-op にしない)
    if (!result.nextProposalPosted) {
      try {
        result.nextProposalSheetUrl = _Aftercare_writeProposalSheet(zissiSs, record);
      } catch (e) {
        console.warn('Phase6_Aftercare proposal sheet error: ' + ((e && e.message) || e));
      }
    }
  }

  // f. 結果サマリを Claude_アフターケア に書く
  _Aftercare_writeState(sheet, result);

  // g. 白川さん (納品物最終確認) / 金さん (次回提案の送信可否) の判断を確認シートへ
  try {
    ConfirmationSheet_appendItems(caseId, [{
      category: '[アフターケア] 報告書・次回提案の確認',
      content: '反省会 ' + schedule.reviewDate + ' / 3ヶ月後フォロー ' + schedule.followUpDate +
        ' を登録しました。報告書と次回提案 (次回提案日 ' + record.nextProposalDate + ') の内容確認と、送信可否の判断をお願いします。'
    }], 2);
  } catch (e) {
    console.warn('Phase6_Aftercare ConfirmationSheet error: ' + ((e && e.message) || e));
  }

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, 'アフターケア',
    '反省会/御礼/報告書/次回提案 (' + schedule.followUpDate + ')',
    PanelLinks_sheetUrl(zissiSs, sheet));

  return result;
}

/** Claude_アフターケア シートを取得 (無ければ作成)。 */
function _Aftercare_ensureSheet(zissiSs) {
  var sheet = zissiSs.getSheetByName(_AFTERCARE_SHEET_NAME);
  if (!sheet) sheet = zissiSs.insertSheet(_AFTERCARE_SHEET_NAME);
  return sheet;
}

/** 既存の実行状態を読む (二重実行の防止)。 */
function _Aftercare_readState(sheet) {
  var state = { reviewRegistered: false, thankYouProposed: false, reportGenerated: false };
  try {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return state;
    for (var r = 2; r <= lastRow; r++) {
      var key = String(sheet.getRange(r, 1).getValue() || '').trim();
      var val = String(sheet.getRange(r, 4).getValue() || '').trim();
      var done = val.indexOf('✅') === 0 || val.indexOf('済') === 0;
      if (key === '反省会登録' && done) state.reviewRegistered = true;
      if (key === '御礼アンケート' && done) state.thankYouProposed = true;
      if (key === '報告書生成' && done) state.reportGenerated = true;
    }
  } catch (e) { /* 読めなければ未実行扱い */ }
  return state;
}

/** 実行結果サマリをシートへ書く (既存の内容は残し追記)。 */
function _Aftercare_writeState(sheet, result) {
  var nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 4).setValues([['項目', '日付/詳細', '更新', '状態']]).setFontWeight('bold').setBackground('#e6f4ea');
  }
  var rows = [
    ['反省会登録', result.schedule.reviewDate, nowStr, result.reviewRegistered ? '✅ 済' : '⚠ 未'],
    ['御礼アンケート', result.schedule.thankYouDate, nowStr, result.thankYouProposed ? '✅ 送信承認待ち' : '⚠ 未'],
    ['報告書生成', '', nowStr, (result.report && result.report.ok) ? '✅ 済' : '⚠ 未'],
    ['3ヶ月後フォロー', result.schedule.followUpDate, nowStr, '✅ 台帳登録'],
    ['次回提案', result.nextProposal && result.nextProposal.record ? result.nextProposal.record.nextProposalDate : '', nowStr,
      result.nextProposalPosted ? '✅ 営業アプリ送信' : (result.nextProposalSheetUrl ? '✅ シート記録' : '⚠ 未')]
  ];
  sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 360);
}

/** 反省会をカレンダーへ 1 件登録する (MeetingSeries と同じカレンダーレーン)。 */
function _Aftercare_registerReview(c, reviewDateStr) {
  var props = PropertiesService.getScriptProperties();
  var calendarId = props.getProperty('MEETING_CALENDAR_ID') ||
    props.getProperty('MEETING_SERIES_CALENDAR_ID') || '';
  if (!calendarId) return { ok: false, error: 'MEETING_CALENDAR_ID 未設定' };

  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(reviewDateStr || ''));
  if (!m) return { ok: false, error: '反省会日付が不正: ' + reviewDateStr };

  var start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 10, 0, 0);
  var end = new Date(start.getTime() + 60 * 60 * 1000);

  var cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) return { ok: false, error: 'カレンダーが見つかりません: ' + calendarId };

  // 同一案件・同日の既存予定があれば二重登録しない
  var existing = cal.getEventsForDay(start);
  var title = '【反省会】' + (c.caseName || c.clientName || '');
  for (var i = 0; i < existing.length; i++) {
    if (String(existing[i].getTitle()).indexOf('反省会') >= 0 &&
        String(existing[i].getTitle()).indexOf(c.caseName || c.clientName || '') >= 0) {
      return { ok: true, eventId: existing[i].getId(), alreadyExists: true };
    }
  }

  var opts = {};
  var attendees = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
  if (c.clientEmail && attendees.indexOf(String(c.clientEmail)) < 0) attendees.push(String(c.clientEmail));
  try { opts.guests = attendees.join(','); } catch (e) {}
  try { opts.sendInvites = false; } catch (e) {}

  var ev = cal.createEvent(title, start, end, opts);
  try { ev.setDescription('本番終了後の反省会。ご要望をヒアリングし、御礼+アンケートと次回提案へ繋げる。'); } catch (e) {}

  return { ok: true, eventId: ev.getId() };
}

/** 出展予測を案件から引く (無ければ null)。 */
function _Aftercare_loadPrediction(c) {
  var p = c && c.nextProposalPrediction;
  if (p && typeof p === 'object') return p;
  return null;
}

/** 次回提案レコードを実施計画書の Claude_次回提案 シートへ書く (webhook 未設定時のフォールバック)。 */
function _Aftercare_writeProposalSheet(zissiSs, record) {
  var sheet = zissiSs.getSheetByName(_AFTERCARE_PROPOSAL_SHEET_NAME);
  if (!sheet) sheet = zissiSs.insertSheet(_AFTERCARE_PROPOSAL_SHEET_NAME);
  sheet.clear();
  sheet.getRange('A1').setValue('🔁 次回提案レコード (営業アプリ連携)').setFontWeight('bold');
  sheet.getRange('B1').setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  var rows = [
    ['product_type', record.product_type],
    ['caseName', record.caseName],
    ['clientName', record.clientName],
    ['prevEndDate', record.prevEndDate],
    ['nextProposalDate', record.nextProposalDate],
    ['reason', record.reason]
  ];
  sheet.getRange(3, 1, rows.length, 2).setValues(rows);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 480);
  return PanelLinks_sheetUrl(zissiSs, sheet);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Phase6_Aftercare_run: Phase6_Aftercare_run
  };
}
