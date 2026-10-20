
// 2026-10-19: N列「デザインデータ」の実値検証用（row40 の最終確認）。
// ヘッドレス（Drive メタデータしか読めない）でも確認できるよう、指定案件の行の N列を
// 目印ファイルの description に JSON で書き出す。値・数式・セル内リンクを併記する。
// 使い方: _admin_printChecklistNDump(['C0034','C0036']) ／ 第2引数 true で先にビルドする。
function _admin_printChecklistNDump(caseIds, rebuild) {
  const started = Date.now();
  let ids = caseIds;
  if (typeof ids === 'string') ids = ids.split(/[,、\s]+/).filter(Boolean);
  if (!Array.isArray(ids) || !ids.length) ids = ['C0034', 'C0036'];
  ids = ids.map(function (s) { return String(s).trim(); }).filter(Boolean);
  const out = { caseIds: ids, rebuilt: null, errors: [], cases: {} };
  if (rebuild === true || String(rebuild) === 'true') {
    try { out.rebuilt = PrintChecklist_build({ caseIds: ids }); }
    catch (e) { out.errors.push('build: ' + String(e && e.message ? e.message : e)); }
  }
  try {
    const id = PropertiesService.getScriptProperties().getProperty(PRINT_CHECKLIST_SS_ID_KEY);
    if (!id) throw new Error('PRINT_CHECKLIST_SS_ID 未設定');
    const ss = SpreadsheetApp.openById(id);
    const sheet = ss.getSheetByName(PRINT_CHECKLIST_MAIN_SHEET);
    if (!sheet) throw new Error('シートなし: ' + PRINT_CHECKLIST_MAIN_SHEET);
    const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    if (lastRow < 2) throw new Error('行なし');
    const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const displays = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    let headerRow = -1;
    for (let r = 0; r < Math.min(10, values.length); r++) {
      if (values[r].some(function (v) { return String(v).trim() === '印刷ID'; })) { headerRow = r; break; }
    }
    if (headerRow < 0) throw new Error('ヘッダー行(印刷ID)なし');
    const headers = values[headerRow].map(function (v) { return String(v || '').trim(); });
    const colOf = function (name) { return headers.indexOf(name); };
    const cId = colOf('印刷ID'), cCase = colOf('案件ID'), cName = colOf('品名'), cStatus = colOf('状態'),
      cN = colOf('デザインデータ'), cHas = colOf('データ有無');
    if (cN < 0) throw new Error('N列「デザインデータ」がヘッダーに無い');
    const nRange = sheet.getRange(headerRow + 2, cN + 1, lastRow - headerRow - 1, 1);
    const nFormulas = nRange.getFormulas();
    let nRich = null;
    try { nRich = nRange.getRichTextValues(); } catch (e) { nRich = null; }
    ids.forEach(function (caseId) { out.cases[caseId] = { rows: 0, rowsWithN: 0, nValues: [], samples: [] }; });
    for (let r = headerRow + 1; r < values.length; r++) {
      const v = values[r];
      const caseId = String(v[cCase] || '').trim();
      const bucket = out.cases[caseId];
      if (!bucket) continue;
      bucket.rows++;
      const nText = String(displays[r][cN] || '');
      const nFormula = String((nFormulas[r - headerRow - 1] || [''])[0] || '');
      let nLink = '';
      try {
        const cell = nRich && nRich[r - headerRow - 1] && nRich[r - headerRow - 1][0];
        if (cell && cell.getLinkUrl) nLink = cell.getLinkUrl() || '';
      } catch (e) { /* リンク無し */ }
      if (nText || nFormula || nLink) bucket.rowsWithN++;
      bucket.samples.push({ row: r + 1, printId: String(v[cId] || ''), name: String(v[cName] || '').slice(0, 80),
        status: String(v[cStatus] || ''), data: String(v[cHas] || ''),
        n: nText.slice(0, 300), formula: nFormula.slice(0, 300), link: nLink.slice(0, 300) });
    }
    Object.keys(out.cases).forEach(function (caseId) {
      const b = out.cases[caseId];
      // N列に値がある行を先に残す。description の上限(8000字)に収めるため20行まで。
      b.samples.sort(function (a, c) { return (c.n ? 1 : 0) - (a.n ? 1 : 0); });
      b.samples = b.samples.slice(0, 20);
      b.samplesWithN = b.samples.filter(function (s) { return Boolean(s.n || s.formula || s.link); }).length;
    });
  } catch (e) {
    out.errors.push('read: ' + String(e && e.message ? e.message : e));
  }
  out.elapsedMs = Date.now() - started;
  const hits = Object.keys(out.cases).reduce(function (n, k) { return n + (out.cases[k].rowsWithN || 0); }, 0);
  let stamp = '';
  try { stamp = Utilities.formatDate(new Date(), PRINT_CHECKLIST_TZ, 'yyyyMMdd_HHmmss'); } catch (e) { stamp = String(Date.now()); }
  const name = 'ncol_' + ids.join('_') + '_r' + hits + '_' + (out.errors.length ? 'err' : 'ok') + '_' + stamp + '.txt';
  let fileId = '';
  try {
    const text = JSON.stringify(out);
    const f = DriveApp.getFolderById(CMD_FOLDER_ID).createFile(name, text, MimeType.PLAIN_TEXT);
    fileId = f.getId();
    try { f.setDescription(text.slice(0, 8000)); } catch (e2) { /* description は best-effort */ }
  } catch (e3) { out.errors.push('marker: ' + String(e3 && e3.message ? e3.message : e3)); }
  out.markerFile = name;
  return { ok: out.errors.length === 0, markerFile: name, markerFileId: fileId, result: out };
}
