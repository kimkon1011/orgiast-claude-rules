/** 業者見積受付。公開入口はフォームと submit のみ。永続状態は既存の Sheet/Drive。 */
var ESTIMATE_INTAKE_HEADERS = ['受付ID','受付日時','caseId','案件表示名','業者名','担当者','メール','ファイルURL','メモ','ステータス','結果URL','チェック日時','エラー内容','指摘件数(高/中/低)'];
var ESTIMATE_CHECK_HEADERS = ['チェックID','受付ID','業者','ファイル','重要度','カテゴリ','指摘','見積側根拠','案件側根拠','業者への確認文','対応状況','ノウハウ化','チェックポイントID','起票日時'];
var ESTIMATE_CP_HEADERS = ['ID','カテゴリ','チェックポイント','判定ルール','根拠・事例','有効','出典','登録日時','的中回数','誤検知回数','既定重要度'];
function _EstimateIntake_locked(fn) {
  var lock = LockService.getScriptLock(), owned = lock.hasLock();
  if (!owned) lock.waitLock(30000);
  try { return fn(); } finally { if (!owned) lock.releaseLock(); }
}
function _EstimateIntake_sheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (!sheet.getLastRow()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}
function EstimateIntake_ensureIntakeSheet() {
  var sheet = _EstimateIntake_sheet(SpreadsheetApp.getActive(), '業者見積受付', ESTIMATE_INTAKE_HEADERS);
  sheet.getRange(1, 14, sheet.getMaxRows(), 1).setNumberFormat('@');
  return sheet;
}
function _EstimateIntake_log() { return EstimateIntake_ensureIntakeSheet(); }
function EstimateIntake_formBaseUrl() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var configured = Checklist_resolveBaseUrl({ CHECKLIST_WEBAPP_URL: props.ESTIMATE_FORM_URL }, '');
  return configured || Checklist_resolveBaseUrl(props, '') || Checklist_resolveBaseUrl({}, ScriptApp.getService().getUrl());
}
function Admin_setEstimateFormUrl(url) {
  var normalized = Checklist_resolveBaseUrl({ CHECKLIST_WEBAPP_URL: url }, '');
  if (!/^https:\/\/script\.google\.com\/(?:a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(normalized)) throw new Error('Webアプリの /exec URL を指定してください');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ESTIMATE_FORM_URL', normalized);
  var saved = props.getProperty('ESTIMATE_FORM_URL');
  if (saved !== normalized) throw new Error('ESTIMATE_FORM_URL の読み戻し不一致');
  return { ok: true, url: saved };
}
function _EstimateIntake_safe(v) { return typeof v === 'string' && /^[=+@-]/.test(v) ? "'" + v : v; }
function _EstimateIntake_write(sheet, row, values) {
  if (row + values.length - 1 > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), row + values.length - 1 - sheet.getMaxRows());
  sheet.getRange(row, 1, values.length, values[0].length).setValues(values.map(function (r) { return r.map(_EstimateIntake_safe); }));
}
function _EstimateIntake_dm(text) {
  try { var config = _FeedbackRelay_config(); if (config.botToken && config.dmUserId) return _FeedbackRelay_postDm(config.botToken, config.dmUserId, text, []); } catch (e) { console.warn('見積 DM: ' + e.message); }
  return false;
}
function EstimateIntake_serveForm(params) {
  var template = HtmlService.createTemplateFromFile('ui/EstimateUploadForm');
  template.cases = CaseList_listAll();
  template.caseId = String((params || {}).caseId || '');
  return template.evaluate().setTitle('業者見積アップロード').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
/** Azukari と同じ制作ルート探索を再利用。預かり素材には保存しない。 */
function _EstimateIntake_estimateFolder(c, create) {
  var root = Case_resolveProjectRoot(c);
  if (!root) throw new Error('制作フォルダが見つかりません');
  var work = Azukari_findWorkRoot(root);
  var parent = DriveApp.getFolderById(work ? work.id : root);
  var marker = AZUKARI_WORKROOT_MARKERS.filter(function (x) { return x === '見積り'; })[0];
  var children = parent.getFolders(), matches = [];
  while (children.hasNext()) { var f = children.next(); if (_Azukari_normalizeName(f.getName()).indexOf(marker) >= 0) matches.push(f); }
  matches.sort(function (a, b) { return a.getDateCreated().getTime() - b.getDateCreated().getTime(); });
  return matches[0] || (create ? parent.createFolder(marker) : null);
}
function _EstimateIntake_decodeFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 30) throw new Error('見積ファイルを1〜30件選択してください');
  var total = 0, types = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  return files.map(function (f) {
    var name = EstimateCheck_sanitizeFilename(f.name), ext = name.split('.').pop().toLowerCase(), b64 = String(f.base64 || '');
    if (!types[ext] || !b64 || b64.length > Math.ceil(10 * 1024 * 1024 / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new Error('ファイル形式またはサイズが不正です: ' + name);
    var bytes = Utilities.base64Decode(b64); total += bytes.length;
    if (!bytes.length || bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('1ファイル10MB・合計20MB以下にしてください');
    return Utilities.newBlob(bytes, types[ext], name);
  });
}
function EstimateIntake_submit(payload) {
  payload = payload || {};
  var vendor = String(payload.vendor || '').trim(), contact = String(payload.contact || '').trim();
  if (!vendor || !contact || vendor.length > 200 || contact.length > 200) throw new Error('業者名・担当者名を200字以内で入力してください');
  var email = String(payload.email || '').trim(), memo = String(payload.memo || '');
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || memo.length > 4000) throw new Error('メール形式またはメモ（4000字以内）を確認してください');
  var c = CaseList_getById(String(payload.caseId || ''));
  if (!c) throw new Error('案件を選択してください');
  if (!_EstimateIntake_locked(function () { return _FeedbackRelay_checkRateLimit(); })) throw new Error('送信上限です。10分後に再試行してください');
  var blobs = _EstimateIntake_decodeFiles(payload.files);
  var result = _EstimateIntake_locked(function () {
    var sheet = _EstimateIntake_log(), id = EstimateCheck_nextId(sheet.getDataRange().getValues().map(function (r) { return r[0]; }), 'V');
    var folder = _EstimateIntake_estimateFolder(c, true), sub = folder.getFoldersByName('業者見積');
    folder = sub.hasNext() ? sub.next() : folder.createFolder('業者見積');
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm'), saved = [], committed = false;
    try {
      blobs.forEach(function (blob) { saved.push(folder.createFile(blob.setName(stamp + '_' + EstimateCheck_sanitizeFilename(vendor) + '_' + blob.getName()))); });
      _EstimateIntake_write(sheet, sheet.getLastRow() + 1, [[id, new Date(), c.caseId, c.clientName + ' / ' + c.caseName, vendor, contact, email, saved.map(function (f) { return f.getUrl(); }).join('\n'), memo, '未チェック', '', '', '', '']]);
      SpreadsheetApp.flush(); committed = true;
      return { ok: true, receiptId: id };
    } finally { if (!committed) saved.forEach(function (f) { f.setTrashed(true); }); }
  });
  _EstimateIntake_dm('[業者見積受付] ' + result.receiptId + ' ' + c.clientName + ' / ' + c.caseName + ' / ' + vendor + '\n' + EstimateIntake_formBaseUrl() + '?form=estimate&caseId=' + encodeURIComponent(c.caseId));
  return result;
}
function EstimateIntake_ensureCheckpointSheet() {
  return _EstimateIntake_locked(function () {
    var ss = SpreadsheetApp.getActive(), existing = ss.getSheetByName('見積チェックポイント');
    var seed = !existing || !existing.getLastRow();
    if (existing && existing.getMaxColumns() < 11) existing.insertColumnsAfter(existing.getMaxColumns(), 11 - existing.getMaxColumns());
    var sh = _EstimateIntake_sheet(ss, '見積チェックポイント', ESTIMATE_CP_HEADERS);
    if (seed) {
      var points = [
        ['車両','車両×ドライバー','車両台数 < ドライバー/運転手人数 なら該当。運転手込みの車両単価に追加の運転手が計上されている場合も該当。実施計画の搬入出計画・車両台数と照合し、交代運転等の根拠は note に記載する'],
        ['金額','単価・数量・税・合計','単価×数量、小計、消費税10%、合計を実際に検算。丸め方も確認'],
        ['日程','作業日数・人工・車両日数','搬入日・設営日・会期・撤去日と作業日数/人工/車両日数を照合'],
        ['人員','時間外割増','早朝・深夜・残業が日程上必要なのに無い、または不要なのに計上されていないか'],
        ['数量','小間サイズと資材数量','小間サイズ・壁面長さに対する壁面・床材・什器の数量過不足を確認'],
        ['会場ルール','会場指定費用','養生・搬入経路・駐車・電気容量に対応する項目の漏れを確認'],
        ['車両','運送費の範囲','往復・片道、高速代・駐車場代・燃料の有無と二重計上を照合'],
        ['項目漏れ','撤去後費用','廃棄・返却・倉庫戻しの費用の有無を確認'],
        ['その他','保険・保証・キャンセル','保険・保証・キャンセル条件の記載有無を確認'],
        ['その他','見積条件','見積有効期限・支払条件・宛名（弊社名）の記載を確認']
      ];
      _EstimateIntake_write(sh, 2, points.map(function (p, i) { return ['CP-' + String(i + 1).padStart(4, '0'), p[0], p[1], p[2], '', true, 'seed', new Date(), 0, 0, i >= 6 ? '中' : '高']; }));
      sh.getRange(2, 6, points.length, 1).insertCheckboxes();
      sh.getRange(2, 6, points.length, 1).setValues(points.map(function () { return [true]; }));
    }
    if (!sh.getRange(1, 11).getValue()) sh.getRange(1, 11).setValue('既定重要度');
    var count = sh.getLastRow() - 1;
    if (count > 0) {
      var defaults = sh.getRange(2, 11, count, 1).getValues();
      defaults.forEach(function (r, i) { if (!String(r[0] || '').trim()) sh.getRange(i + 2, 11).setValue('高'); });
      sh.getRange(2, 11, count, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['高','中','低'], true).setAllowInvalid(false).build());
    }
    return { ok: true, seeded: seed, count: count };
  });
}
function EstimateIntake_appendKnowhowCheckpoints() {
  EstimateIntake_ensureCheckpointSheet();
  return _EstimateIntake_locked(function () {
    var sh = SpreadsheetApp.getActive().getSheetByName('見積チェックポイント');
    var existing = sh.getDataRange().getValues().slice(1);
    var texts = existing.map(function (r) { return String(r[2] || '').trim(); });
    var ids = existing.map(function (r) { return r[0]; });
    var points = [
      ['数量', '数量・単位・税区分・除外項目の照合', '見積の数量、単位、税区分、見積対象外・別請求の記載を原資料と照合する', '高'],
      ['金額', '仕入先見積と日付の照合', '仕入先見積の日付を確認し、同一品名でも日付により単価が違う場合は最新の正式見積と照合する', '高'],
      ['項目漏れ', '図面⇔見積の双方向照合', '図面から見積、見積から図面の両方向で照合し、図面にしかない項目の計上漏れを確認する', '高'],
      ['その他', '品名の誤字', '品名の誤字・変換誤りを原資料と照合する', '中'],
      ['金額', '原価が空欄の行', '原価欄が空の明細を検出する', '高'],
      ['金額', '#REF!・#N/A の数式エラー', '#REF! または #N/A の数式エラーを検出する', '高']
    ];
    var additions = [];
    points.forEach(function (p) {
      if (texts.indexOf(p[1]) >= 0) return;
      var id = EstimateCheck_nextId(ids, 'CP'); ids.push(id); texts.push(p[1]);
      additions.push([id, p[0], p[1], p[2], '', true, '百瀬ノウハウ', new Date(), 0, 0, p[3]]);
    });
    if (additions.length) {
      var start = sh.getLastRow() + 1;
      _EstimateIntake_write(sh, start, additions);
      sh.getRange(start, 6, additions.length, 1).insertCheckboxes();
      sh.getRange(start, 6, additions.length, 1).setValues(additions.map(function () { return [true]; }));
      sh.getRange(start, 11, additions.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['高','中','低'], true).setAllowInvalid(false).build());
    }
    return { ok: true, added: additions.length, count: sh.getLastRow() - 1, ids: additions.map(function (r) { return r[0]; }) };
  });
}
function _EstimateIntake_tsv(ss) {
  // 各シート名を含める。各シートの採取も制限し巨大表のメモリ消費を抑える。
  return ss.getSheets().map(function (sheet) {
    var lines = [], chars = 0, cols = sheet.getLastColumn();
    if (!cols) return 'シート: ' + sheet.getName();
    for (var start = 1; start <= sheet.getLastRow() && chars <= 30000; start += 100) {
      var values = sheet.getRange(start, 1, Math.min(100, sheet.getLastRow() - start + 1), cols).getDisplayValues();
      values.forEach(function (row, i) { var line = (start + i) + '\t' + row.join('\t'); lines.push(line); chars += line.length + 1; });
    }
    return 'シート: ' + sheet.getName() + '\n' + lines.join('\n');
  }).join('\n\n');
}
function _EstimateIntake_addFile(file, inputs, temporary, internal) {
  var mime = file.getMimeType(), name = (internal ? '[社内見積] ' : '[業者見積] ') + file.getName();
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    if (internal) {
      var pdf = DriveApp.createFile(file.getAs('application/pdf').setName(file.getName() + '.pdf'));
      temporary.push(pdf.getId());
      inputs.documents.push({ driveFileId: pdf.getId(), label: name, mimeType: 'application/pdf' });
    } else inputs.tabular.push({ name: name, text: _EstimateIntake_tsv(SpreadsheetApp.openById(file.getId())) });
  } else if (/\.(xlsx|xls)$/i.test(file.getName())) {
    var converted = Drive.Files.create({ name: '一時_見積チェック_' + file.getName(), mimeType: 'application/vnd.google-apps.spreadsheet' }, file.getBlob(), { fields: 'id' });
    temporary.push(converted.id);
    inputs.tabular.push({ name: name, text: _EstimateIntake_tsv(SpreadsheetApp.openById(converted.id)) });
  } else if (mime === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(mime)) {
    inputs.documents.push({ driveFileId: file.getId(), label: name, mimeType: mime });
  } else throw new Error('未対応の添付形式: ' + file.getName());
}
function _EstimateIntake_analyze(row) {
  var c = CaseList_getById(row[2]);
  if (!c) throw new Error('案件が見つかりません');
  EstimateIntake_ensureCheckpointSheet();
  var checkpoints = SpreadsheetApp.getActive().getSheetByName('見積チェックポイント').getDataRange().getValues().slice(1).filter(function (r) { return r[5] === true || r[5] === 'TRUE'; });
  var inputs = { documents: [], tabular: [] }, temporary = [];
  try {
    String(row[7]).split('\n').filter(Boolean).forEach(function (url) {
      var match = url.match(/\/d\/([\w-]+)/) || url.match(/[?&]id=([\w-]+)/);
      if (!match) throw new Error('添付URLが不正');
      _EstimateIntake_addFile(DriveApp.getFileById(match[1]), inputs, temporary, false);
    });
    if (!inputs.documents.length && !inputs.tabular.length) throw new Error('見積ファイルなし');
    var folder = _EstimateIntake_estimateFolder(c, false), prior = [];
    if (folder) {
      var files = folder.getFiles();
      while (files.hasNext()) { var f = files.next(); if (['application/pdf','application/vnd.google-apps.spreadsheet'].indexOf(f.getMimeType()) >= 0) prior.push(f); }
      prior.sort(function (a, b) { return b.getLastUpdated().getTime() - a.getLastUpdated().getTime(); });
      if (prior.length) _EstimateIntake_addFile(prior[0], inputs, temporary, true);
    }
    var master = SpreadsheetApp.openById(CASE_API_MASTER_SS_ID);
    var prompt = EstimateCheck_buildPrompt({ caseContext: _CaseApi_buildCaseContext(c, master.getSheetByName('task'), 0), checkpoints: checkpoints, tabular: inputs.tabular, vendor: row[4], memo: row[8] });
    prompt.model = CLAUDE_MODEL_HQ; prompt.maxTokens = 8000; prompt.documents = inputs.documents; prompt.requireAllDocuments = true; prompt.documentBase64Limit = 28 * 1024 * 1024;
    var result = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      result = EstimateCheck_parseResult(ClaudeClient_call(prompt).text);
      if (result && _EstimateIntake_validCoverage(result, checkpoints)) break;
      result = null;
      prompt.userMessage += '\n前回はJSON形式またはチェックポイント全件の回答に不備がありました。指定スキーマのJSONのみで出し直してください。全チェックポイントIDを1回ずつ返してください。';
    }
    if (!result) throw new Error('JSON解析またはチェックポイント全件照合に2回失敗');
    result.findings = EstimateCheck_applyCheckpointSeverity(result.findings, checkpoints);
    return result;
  } finally {
    var cleanupErrors = [];
    temporary.forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { cleanupErrors.push(id + ': ' + e.message); } });
    if (cleanupErrors.length) throw new Error('一時ファイルの破棄に失敗: ' + cleanupErrors.join('; '));
  }
}
function _EstimateIntake_validCoverage(result, checkpoints) {
  var expected = checkpoints.map(function (r) { return r[0]; }), actual = result.checkpointResults.map(function (r) { return r.checkpointId; });
  return expected.length === actual.length && expected.every(function (id) { return actual.filter(function (x) { return x === id; }).length === 1; }) && result.findings.every(function (f) { return !f.checkpointId || expected.indexOf(f.checkpointId) >= 0; });
}
function _EstimateIntake_record(row, result) {
  var c = CaseList_getById(row[2]), ss = _ConfirmationSheet_open(c.folderId, c);
  var sh = _EstimateIntake_sheet(ss, '見積チェック', ESTIMATE_CHECK_HEADERS), now = new Date();
  // 途中失敗からの再処理時には既存結果を二重起票しない。
  var existing = sh.getDataRange().getValues(), found = existing.some(function (r) { return r[1] === row[0]; });
  if (!found) {
    var ids = existing.map(function (r) { return r[0]; });
    var findings = EstimateCheck_sortFindings(result.findings).concat(result.newCheckpointCandidates.map(function (p) { return { severity: '低', category: '候補', point: p.point, evidence: '候補カテゴリ: ' + p.category, caseEvidence: '', suggestion: p.rule, checkpointId: '' }; }));
    var summary = '── ' + row[0] + ' ' + row[4] + ' ' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') + ' 要約: ' + result.summary + ' ──';
    var values = [[summary, row[0], row[4], row[7], '', '', '', '', '', '', '', '', '', now]];
    findings.forEach(function (f) { var id = EstimateCheck_nextId(ids, 'EC'); ids.push(id); values.push([id, row[0], row[4], row[7], f.severity, f.category, f.point, f.evidence, f.caseEvidence, f.suggestion, '未対応', false, f.checkpointId, now]); });
    var start = sh.getLastRow() + 1;
    _EstimateIntake_write(sh, start, values);
    sh.getRange(start, 1).setNote(JSON.stringify({ checkpointResults: result.checkpointResults }));
    if (findings.length) {
      sh.getRange(start + 1, 11, findings.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['未対応','業者へ確認中','解決','誤検知'], true).setAllowInvalid(false).build());
      sh.getRange(start + 1, 12, findings.length, 1).insertCheckboxes();
    }
  }
  // 高だけを転記。receipt と文面の一致で部分失敗後も重複を防ぐ。
  var confirm = ss.getSheetByName('確認事項'), prior = confirm ? confirm.getDataRange().getValues().map(function (r) { return r[3]; }) : [];
  var high = result.findings.filter(function (f) { return f.severity === '高'; }).map(function (f) { return { category: '見積チェック/' + f.category, content: '[' + row[0] + ' ' + row[4] + '] ' + f.point + ' → ' + f.suggestion }; }).filter(function (item) { return prior.indexOf(item.content) < 0; });
  if (high.length) ConfirmationSheet_appendItems(row[2], high, '見積チェック');
  return PanelLinks_sheetUrl(ss, sh);
}
function EstimateIntake_pollPending() { return EstimateIntake_runPending({ max: 2 }); }
function EstimateIntake_runPending(opts) {
  var max = Math.max(1, Math.min(5, Math.floor(Number((opts || {}).max) || 2))), results = [], started = Date.now();
  for (var n = 0; n < max && Date.now() - started < 240000; n++) {
    var claimed = _EstimateIntake_locked(function () {
      var sh = _EstimateIntake_log(), data = sh.getDataRange().getValues(), now = new Date();
      data.slice(1).forEach(function (r, i) {
        if (r[9] === 'チェック中' && (!r[11] || now.getTime() - new Date(r[11]).getTime() >= 1800000)) { sh.getRange(i + 2, 10).setValue('未チェック'); r[9] = '未チェック'; }
      });
      var pending = data.map(function (r, i) { return { row: r, index: i + 1 }; }).filter(function (x) { return x.row[9] === '未チェック'; }).sort(function (a, b) { return new Date(a.row[1]) - new Date(b.row[1]); });
      if (!pending.length) return null;
      var p = pending[0]; sh.getRange(p.index, 10).setValue('チェック中'); sh.getRange(p.index, 12).setValue(now); SpreadsheetApp.flush(); return p;
    });
    if (!claimed) break;
    try {
      var result = _EstimateIntake_analyze(claimed.row);
      var url = _EstimateIntake_locked(function () {
        var sharingReport = [];
        var link = CaseSharing_withReport(sharingReport, function () { return _EstimateIntake_record(claimed.row, result); });
        var counts = ['高','中','低'].map(function (s) { return result.findings.filter(function (f) { return f.severity === s; }).length; });
        var log = _EstimateIntake_log();
        var messages = sharingReport.map(function (r) { return '共有設定失敗: ' + r.reason; });
        var error = [String(log.getRange(claimed.index, 13).getValue() || '')].concat(messages).filter(function (message, i, all) { return message && all.indexOf(message) === i; }).join('\n');
        log.getRange(claimed.index, 14).setNumberFormat('@');
        log.getRange(claimed.index, 10, 1, 5).setValues([['チェック済', link, new Date(), _EstimateIntake_safe(error), counts.join('/')]]); SpreadsheetApp.flush(); return link;
      });
      var counts = ['高','中','低'].map(function (s) { return s + result.findings.filter(function (f) { return f.severity === s; }).length; }).join(' ');
      _EstimateIntake_dm('[見積チェック] ' + claimed.row[3] + ' / ' + claimed.row[4] + ' ' + counts + '\n' + result.summary.slice(0, 200) + '\n' + url);
      results.push({ receiptId: claimed.row[0], ok: true, url: url });
    } catch (e) {
      _EstimateIntake_locked(function () { _EstimateIntake_log().getRange(claimed.index, 10, 1, 4).setValues([['エラー', '', new Date(), _EstimateIntake_safe(String(e.message || e).slice(0, 2000))]]); });
      results.push({ receiptId: claimed.row[0], ok: false, error: String(e.message || e) });
    }
  }
  return { ok: results.every(function (r) { return r.ok; }), processed: results.length, results: results };
}
function EstimateIntake_harvestCheckpoints() {
  EstimateIntake_ensureCheckpointSheet();
  return _EstimateIntake_locked(function () {
    var rows = [], locations = [], errors = [];
    CaseList_listAll().forEach(function (item) {
      try {
        var c = CaseList_getById(item.caseId), it = DriveApp.getFolderById(c.folderId).getFilesByName('確認シート');
        if (!it.hasNext()) return;
        var sh = SpreadsheetApp.openById(it.next().getId()).getSheetByName('見積チェック');
        if (!sh) return;
        sh.getDataRange().getValues().slice(1).forEach(function (r, i) { rows.push(r); locations.push({ sheet: sh, row: i + 2 }); });
      } catch (e) { errors.push(item.caseId + ': ' + e.message); }
    });
    // 不完全な走査で累積値を減らしたり誤無効化したりしない。
    if (errors.length) return { ok: false, errors: errors };
    var cp = SpreadsheetApp.getActive().getSheetByName('見積チェックポイント'), current = cp.getDataRange().getValues().slice(1);
    // M 書込前の中断で作られた CP は「出典+チェックID」の note から回復。
    var notes = cp.getDataRange().getNotes();
    rows.forEach(function (r, i) { if (r[12] || !r[0]) return; var key = r[1] + ':' + r[0]; for (var j = 1; j < notes.length; j++) { if (notes[j][0] === key) { r[12] = current[j - 1][0]; locations[i].sheet.getRange(locations[i].row, 13).setValue(r[12]); break; } } });
    var plan = EstimateCheck_harvestPlan(rows, current);
    plan.additions.forEach(function (a) {
      a.row[7] = new Date(); var index = cp.getLastRow() + 1;
      _EstimateIntake_write(cp, index, [a.row]); cp.getRange(index, 1).setNote(rows[a.index][1] + ':' + rows[a.index][0]); SpreadsheetApp.flush();
      locations[a.index].sheet.getRange(locations[a.index].row, 13).setValue(a.id);
    });
    var disabled = [];
    cp.getDataRange().getValues().slice(1).forEach(function (r, i) {
      var count = plan.counts[r[0]] || { hit: 0, falsePositive: 0 };
      cp.getRange(i + 2, 9, 1, 2).setValues([[count.hit, count.falsePositive]]);
      if (plan.disabled.indexOf(r[0]) >= 0 && (r[5] === true || r[5] === 'TRUE')) { cp.getRange(i + 2, 6).setValue(false); disabled.push(r[0]); }
    });
    SpreadsheetApp.flush();
    if (disabled.length) _EstimateIntake_dm('[見積チェック] 誤検知が的中+3以上のため無効化: ' + disabled.join(', '));
    return { ok: true, added: plan.additions.length, disabled: disabled, scanned: rows.length };
  });
}
function _debug_estimateIntake(limit) {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName('業者見積受付'), cp = ss.getSheetByName('見積チェックポイント');
  return { ok: true, formUrl: EstimateIntake_formBaseUrl() + '?form=estimate', checkpoints: cp ? cp.getLastRow() - 1 : 0, receipts: sh ? sh.getDataRange().getValues().slice(1).slice(-Math.max(1, Math.min(100, Number(limit) || 10))).map(function (r) { return { id: r[0], caseId: r[2], status: r[9], resultUrl: r[10], checkedAt: String(r[11]), error: r[12], counts: r[13] }; }) : [], triggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).filter(function (n) { return /^EstimateIntake_/.test(n); }) };
}
function EstimateIntake_showFormUrl() {
  var url = EstimateIntake_formBaseUrl() + '?form=estimate', ss = SpreadsheetApp.getActive(), sh = ss.getActiveSheet();
  var row = sh.getActiveCell().getRow(), id = sh.getName() === CASE_LIST_SHEET_NAME && row > 1 ? sh.getRange(row, 1).getValue() : '';
  SpreadsheetApp.getUi().alert('業者見積フォームURL\n' + url + (id ? '\n\n選択案件\n' + url + '&caseId=' + encodeURIComponent(id) : ''));
}
function EstimateIntake_menuRun() { SpreadsheetApp.getUi().alert(JSON.stringify(EstimateIntake_runPending({ max: 5 }))); }
