/** Two-step assignment: generate never registers requests or sends notifications. */
function Phase_AssignRequest_generate(caseId, opts) {
  var c = CaseList_getById(caseId);
  if (!c || !c.zissiId) throw new Error('案件の実施計画書が必要です: ' + caseId);
  var ss = SpreadsheetApp.openById(c.zissiId);
  var sheet = ss.getSheetByName('アサイン依頼(下書き)');
  if (sheet) return { draftUrl: PanelLinks_sheetUrl(ss, sheet), panelStatus: '下書きは作成済みです。不要な役職にチェックし、内容を編集後「▶ 下書きの内容で送信」を実行してください' };
  var candidate = _AssignRequest_generateCandidate(caseId, { dryRun: true });
  var vehicle;
  try { vehicle = Phase2_VolumeCalc_estimateTrucks(caseId).vehicleClassification; }
  catch (e) { vehicle = { value: '要確認', reason: '容積未取得: ' + String(e.message || e) }; }
  vehicle = vehicle || { value: '要確認', reason: '容積の判定結果がありません' };
  sheet = ss.insertSheet('アサイン依頼(下書き)');
  sheet.getRange(1, 1, 6, 2).setValues([
    ['アサイン依頼(下書き)', c.caseId],
    ['依頼本文（編集可）', candidate.draftBody || (c.clientName || '') + ' / ' + (c.caseName || '') + 'のアサインをお願いします。役職ごとの依頼内容は下表を参照してください。'],
    ['車両区分（編集可）', vehicle.value], ['判定根拠（編集可）', vehicle.reason],
    ['送信状態（変更不可）', '未送信'], ['生成時の参考依頼書', candidate.docUrl]
  ]);
  var rows = _AssignDraft_rows(candidate.plannedRows || [], c, candidate.draftEventNotes);
  sheet.getRange(7, 1, 1, 9).setValues([['不要', '役職', '勤務日時', '仕事内容 / トラス', '人数 / 人員構成', '単価 / 費用', '備考', '種別', '登録用元データ（変更不可）']]);
  if (rows.length) {
    sheet.getRange(8, 1, rows.length, 1).insertCheckboxes();
    sheet.getRange(8, 1, rows.length, 9).setValues(rows);
  }
  sheet.hideColumns(9);
  sheet.setFrozenRows(7);
  sheet.getRange(1, 1, Math.max(7, rows.length + 7), 8).setWrap(true);
  sheet.setColumnWidth(2, 340);
  SpreadsheetApp.flush();
  return { draftUrl: PanelLinks_sheetUrl(ss, sheet), vehicleType: vehicle.value,
    panelStatus: '下書きを作成しました。不要な役職にチェックし、編集後「▶ 下書きの内容で送信」を実行してください' };
}

function _AssignDraft_rows(planned, caseInfo, eventNotes) {
  var result = [];
  planned.forEach(function (entry) {
    var v = entry.values;
    if (entry.type === 'construction') {
      result.push([false, '施工スタッフ', v[54], [v[55], v[56]].filter(Boolean).join('\n'), v[57], v[58], v[59], '施工スタッフ', JSON.stringify(v)]);
    } else {
      [16, 19].forEach(function (offset) {
        if (v[offset]) result.push([false, v[offset], '', '', v[offset + 2], v[offset + 1], eventNotes || '', v[15] || '制作スタッフ', JSON.stringify(v)]);
      });
    }
  });
  /* Always offer explicit designer/driver selection, even if the model omitted them. */
  ['デザイナー', 'ドライバー'].forEach(function (role) {
    if (!result.some(function (r) { return String(r[1]).indexOf(role) >= 0; })) {
      var base = planned.length ? planned[0].values : _AssignSheet_emptyRow();
      var v = _AssignSheet_emptyRow();
      v[1] = base[1] || 'ブース制作アプリ(制作P要確認)';
      v[11] = base[11] || base[50] || (caseInfo && caseInfo.clientName) || '';
      v[12] = base[12] || base[49] || (caseInfo && caseInfo.caseName) || '';
      v[13] = base[13] || base[51]; v[14] = base[14] || base[64];
      result.push([true, role, '', '', 1, '', '必要なら不要チェックを外し、単価・勤務日時を入力', '制作スタッフ', JSON.stringify(v)]);
    }
  });
  return result;
}

/** Pure conversion of the CURRENT editable cells to requests and document text. */
function _AssignDraft_prepare(values) {
  var text = function (r, c) { return String(values[r] && values[r][c] != null ? values[r][c] : ''); };
  var body = text(1, 1), vehicle = text(2, 1), reason = text(3, 1);
  var rows = [], descriptions = [];
  values.slice(7).forEach(function (cells) {
    if (!cells[1] || cells[0] === true || String(cells[0]).toUpperCase() === 'TRUE') return;
    var v;
    try { v = JSON.parse(cells[8]); } catch (e) { throw new Error('下書きの登録用元データが壊れています'); }
    if (!Array.isArray(v) || v.length !== 66) throw new Error('下書きの登録用元データの列数が不正です');
    var type = cells[7] === '施工スタッフ' ? 'construction' : 'event';
    if (type === 'construction') {
      v[2] = '施工スタッフ'; v[54] = cells[2]; v[55] = cells[3]; v[56] = '';
      v[57] = cells[4]; v[58] = cells[5]; v[59] = cells[6] + '\n車両区分: ' + vehicle + '\n根拠: ' + reason;
    } else {
      if (!(Number(cells[4]) > 0) || !(Number(cells[5]) > 0)) throw new Error(cells[1] + 'の人数と単価は1以上で入力してください');
      v[2] = 'イベント関連'; v[15] = cells[7] || '制作スタッフ';
      v[16] = cells[1]; v[17] = Number(cells[5]); v[18] = Number(cells[4]);
      v[19] = ''; v[20] = ''; v[21] = '';
    }
    rows.push({ type: type, values: v });
    descriptions.push('【' + cells[1] + '】\n勤務日時: ' + cells[2] + '\n仕事内容: ' + cells[3] + '\n人数 / 人員構成: ' + cells[4] + '\n単価 / 費用: ' + cells[5] + '\n備考: ' + cells[6]);
  });
  if (!rows.length) throw new Error('送信対象の役職がありません（すべて不要）');
  return { rows: rows, vehicleType: vehicle, body: body + '\n車両区分: ' + vehicle + '\n判定根拠: ' + reason + '\n\n' + descriptions.join('\n\n') };
}

function _AssignDraft_open(caseId) {
  var c = CaseList_getById(caseId);
  if (!c || !c.zissiId) throw new Error('実施計画書がありません');
  var ss = SpreadsheetApp.openById(c.zissiId), sheet = ss.getSheetByName('アサイン依頼(下書き)');
  if (!sheet || String(sheet.getRange(1, 2).getValue()) !== String(caseId)) throw new Error('この案件の下書きがありません');
  return { c: c, ss: ss, sheet: sheet };
}

function Phase_AssignRequest_sendDraft(caseId) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var draft = _AssignDraft_open(caseId), sheet = draft.sheet;
    var status = String(sheet.getRange(5, 2).getValue());
    var receipt = {};
    if (status === '送信済') return { draftUrl: PanelLinks_sheetUrl(draft.ss, sheet), panelStatus: '送信済です（重複送信なし）' };
    if (status === '登録中') throw new Error('前回の登録結果を確認してください。二重登録を防ぐため再登録を停止しました');
    if (status === '登録済・通知待ち') {
      receipt = JSON.parse(sheet.getRange(1, 10).getValue());
    } else {
      if (status !== '未送信') throw new Error('下書きの送信状態が不正です');
      var prepared = _AssignDraft_prepare(sheet.getDataRange().getValues());
      var doc = DocumentApp.create(caseId + '_' + draft.c.caseName + '_アサイン依頼(送信版)');
      doc.getBody().appendParagraph(prepared.body); doc.saveAndClose();
      var docUrl = 'https://docs.google.com/a/orgiast.jp/document/d/' + doc.getId() + '/edit';
      prepared.rows.forEach(function (row) { row.values[0] = new Date(); row.values[65] = docUrl; });
      _AssignSheet_ensureDocUrlHeader();
      sheet.getRange(5, 2).setValue('登録中'); SpreadsheetApp.flush();
      var inserted = _AssignSheet_insertRowsTop(prepared.rows.map(function (r) { return r.values; }));
      var appended = prepared.rows.map(function (r, i) { return {type:r.type, row:inserted[i]}; });
      var v = prepared.rows[0].values;
      var notify = _AssignSheet_buildNotifyText({ roleId: PropertiesService.getScriptProperties().getProperty('DISCORD_ASSIGN_ROLE_ID') || _ASSIGN_ROLE_ID_DEFAULT,
        requesterName: v[1], requestTypes: prepared.rows.map(function (r) { return r.values[2]; }),
        clientName: draft.c.clientName, caseName: draft.c.caseName, projectCode: v[13] || v[51], rows: appended, docUrl: docUrl,
        timestampText: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') });
      receipt = {docUrl:docUrl, assignSheetUrl:_AssignSheet_masterUrl(inserted[0]), text:notify, rows:appended};
      sheet.getRange(1, 10).setValue(JSON.stringify(receipt)); sheet.hideColumns(10);
      sheet.getRange(5, 2).setValue('登録済・通知待ち'); SpreadsheetApp.flush();
    }
    var sent = _AssignSheet_notifyDiscord(receipt.text);
    if (sent.sent) sheet.getRange(5, 2).setValue('送信済');
    return { docUrl:receipt.docUrl, assignSheetUrl:receipt.assignSheetUrl, discordSent:sent.sent,
      panelStatus: sent.sent ? '✅ 編集済み下書きで登録・通知しました' : '⚠ 登録済み・通知失敗。再実行で通知のみ再試行: ' + sent.reason };
  } finally { lock.releaseLock(); }
}

function _debug_assignDraft(caseId) {
  var draft = _AssignDraft_open(caseId);
  var values = draft.sheet.getDataRange().getValues();
  var prepared = _AssignDraft_prepare(values);
  return JSON.parse(JSON.stringify({ caseId:caseId, status:values[4][1], draftUrl:PanelLinks_sheetUrl(draft.ss,draft.sheet),
    vehicleType:prepared.vehicleType, body:prepared.body, rows:prepared.rows }));
}
