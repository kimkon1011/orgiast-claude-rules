/**
 * 新規案件の登録（master task シートへの手入力を無くす）。
 *
 * 現状はまだ調査用の読み取り専用プローブのみ。実装は codex-task-new-case-register.md 参照。
 */

const _NCR_MASTER_SS = '1t6eMvbPIu17m7hbv6foJcvd-fXrJkZqrePb8P6njxGI';
const _NCR_TASK_SHEET = 'task';
const _NCR_FORM_SHEET = '➕新規案件登録';
const _NCR_INDEX_SHEET = '🚀実行パネル';

/**
 * master に新規案件登録フォームを作成し、既存なら入力値を残して表示だけを直す。
 */
function NewCaseForm_build() {
  const master = SpreadsheetApp.openById(_NCR_MASTER_SS);
  let sheet = master.getSheetByName(_NCR_FORM_SHEET);
  const created = !sheet;

  if (!sheet) {
    const indexSheet = master.getSheetByName(_NCR_INDEX_SHEET);
    if (!indexSheet) throw new Error('sheet not found: ' + _NCR_INDEX_SHEET);
    // getIndex() は1始まり、insertSheet の位置は0始まりなので、実行パネルの直後になる。
    sheet = master.insertSheet(_NCR_FORM_SHEET, indexSheet.getIndex());
  }

  const description = 'このシートに書くだけで OK です。task シートに手で列を作る必要はありません。※ の付いた 2 つだけ必須です。分かるものだけ埋めてチェックを入れてください。';
  const labels = [
    ['クライアント名 *'], ['展示会名 *'], ['地域'], ['会場'], ['設営日'], ['開催日程'],
    ['実施計画書URL（あれば）'], ['見積URL（あれば）'], ['展示会HP（あれば）'],
    ['制作P'], ['制作D'], ['小間サイズ']
  ];
  const notes = {
    6: '例: 関東（千葉）',
    7: '例: 幕張メッセ',
    8: '例: 2026/10/06',
    9: '例: 2026/10/7~10/9',
    13: '例: P百瀬かなう',
    15: '例: 3m × 3m / 2小間'
  };

  sheet.getRange('A1:F2').breakApart();
  sheet.getRange('A1:F1').merge()
    .setValue('➕ 新規案件を登録')
    .setFontSize(16).setFontWeight('bold').setBackground('#d9ead3')
    .setVerticalAlignment('middle');
  sheet.getRange('A2:F2').merge()
    .setValue(description)
    .setBackground('#f3f6f4').setWrap(true).setVerticalAlignment('middle');
  sheet.setRowHeight(1, 36);
  sheet.setRowHeight(2, 54);

  sheet.getRange(4, 1, labels.length, 1).setValues(labels).setFontWeight('bold');
  sheet.getRange('B4:B15').setBackground('#ffffff');
  sheet.getRange('B4:B5').setBackground('#fff2cc');
  sheet.getRange('B4:B15').clearNote();
  Object.keys(notes).forEach(function (row) {
    sheet.getRange(Number(row), 2).setNote(notes[row]);
  });

  const checkbox = sheet.getRange('A17');
  const validation = checkbox.getDataValidation();
  const isCheckbox = validation && validation.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX;
  if (!isCheckbox) checkbox.insertCheckboxes();
  sheet.getRange('B17').setValue('▶ 登録する：チェックを入れると 1〜2 分で登録されます').setFontWeight('bold');
  sheet.getRange('A18').setValue('結果').setFontWeight('bold');

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 420);
  for (let col = 3; col <= 6; col++) sheet.setColumnWidth(col, 140);
  sheet.setFrozenRows(2);

  SpreadsheetApp.flush();
  const readBack = sheet.getRangeList(['A4', 'A17']).getRanges();
  const labelReadBack = String(readBack[0].getValue() || '');
  const checkboxValidation = readBack[1].getDataValidation();
  const checkboxVerified = checkboxValidation && checkboxValidation.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX;
  if (labelReadBack !== labels[0][0] || !checkboxVerified) {
    throw new Error('新規案件登録フォームの read-back verify に失敗しました');
  }

  return {
    ok: true,
    created: created,
    sheetName: sheet.getName(),
    gid: sheet.getSheetId(),
    position: sheet.getIndex()
  };
}

function _NewCase_validate(payload) {
  payload = payload || {};
  const errors = [];
  if (!String(payload.clientName || '').trim()) errors.push('clientName');
  if (!String(payload.eventName || '').trim()) errors.push('eventName');
  return { ok: errors.length === 0, errors: errors };
}

function _NewCase_nextBlockStart(blockStarts) {
  if (!blockStarts || !blockStarts.length) return 13;
  return Math.max.apply(null, blockStarts.map(Number)) + 3;
}

function _NewCase_normalizeLabel(clientName, eventName) {
  const client = String(clientName || '').replace(/\s+/g, ' ').trim();
  const event = String(eventName || '').replace(/\s+/g, ' ').trim();
  return (client ? client + ' / ' : '') + event.slice(0, 40);
}

function _NewCase_caseName(eventName, area) {
  const event = String(eventName || '').trim();
  const place = String(area || '').trim();
  return event + (place ? ' / ' + place : '');
}

function _NewCase_isTestCase(clientName) {
  return String(clientName || '').indexOf('__TEST__') === 0;
}

function _NewCase_rewriteImportrange(formula, newUrl) {
  if (!newUrl) return '';
  const source = String(formula || '');
  return source.replace(/(IMPORTRANGE\s*\(\s*)(["'])([^"']*)(\2)/i,
    function (_, prefix, quote, oldUrl, closingQuote) {
      return prefix + quote + String(newUrl) + closingQuote;
    });
}

function _NewCase_headValues(payload) {
  payload = payload || {};
  function value(key) { return payload[key] == null ? '' : String(payload[key]); }
  return [
    [value('clientName'), '', ''],
    [value('eventName'), '', ''],
    [value('area'), value('venue'), ''],
    [value('setupDate'), '', ''],
    [value('period'), '', ''],
    [value('zissiUrl'), value('estimateUrl'), ''],
    [value('eventHpUrl'), '', ''],
    [value('producer'), value('designer'), '']
  ];
}

function _NewCase_normalizeDateCell(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const jst = new Date(value.getTime() + 9 * 60 * 60 * 1000);
    const year = jst.getUTCFullYear();
    const month = jst.getUTCMonth() + 1;
    const day = jst.getUTCDate();
    return year + '/' + String(month).padStart(2, '0') + '/' + String(day).padStart(2, '0');
  }

  const match = /^(\d{4})([\/-])(\d{1,2})\2(\d{1,2})$/.exec(String(value == null ? '' : value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null;
  return year + '/' + String(month).padStart(2, '0') + '/' + String(day).padStart(2, '0');
}

function _NewCase_sameCell(actual, expected) {
  const normalizedActual = _NewCase_normalizeDateCell(actual);
  const normalizedExpected = _NewCase_normalizeDateCell(expected);
  if (normalizedActual !== null && normalizedExpected !== null) return normalizedActual === normalizedExpected;
  return String(actual == null ? '' : actual) === String(expected == null ? '' : expected);
}

function _NewCase_verifyHead(readBack, payload) {
  const expected = _NewCase_headValues(payload);
  const mismatches = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 3; c++) {
      const actual = readBack && readBack[r] ? readBack[r][c] : '';
      if (!_NewCase_sameCell(actual, expected[r][c])) {
        mismatches.push({ row: r + 1, colOffset: c, expected: expected[r][c], actual: String(actual == null ? '' : actual) });
      }
    }
  }
  return mismatches;
}

function _NewCase_columnA1(col) {
  let out = '';
  for (let n = Number(col); n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}

function _NewCase_errorWithBlock(error, blockStart) {
  const err = error instanceof Error ? error : new Error(String(error));
  err.blockStart = Number(blockStart) || 0;
  if (err.blockStart && err.message.indexOf('blockStart=') < 0) err.message += ' (blockStart=' + err.blockStart + ')';
  return err;
}

/**
 * フォーム入力から master task の3列ブロック、案件一覧、案件パネルを一括作成する。
 */
function NewCase_register(payload, opts) {
  payload = payload || {};
  opts = opts || {};
  const validation = _NewCase_validate(payload);
  if (!validation.ok) throw new Error('クライアント名と展示会名は必須です');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let blockStart = 0;
  try {
    const master = SpreadsheetApp.openById(_NCR_MASTER_SS);
    const sheet = master.getSheetByName(_NCR_TASK_SHEET);
    if (!sheet) throw new Error('sheet not found: ' + _NCR_TASK_SHEET);

    const lastCol = sheet.getLastColumn();
    const blockStarts = [];
    for (let bs = 13; bs + 2 <= lastCol; bs += 3) blockStarts.push(bs);
    const label = _NewCase_normalizeLabel(payload.clientName, payload.eventName);
    const caseName = _NewCase_caseName(payload.eventName, payload.area);
    let reused = false;
    if (blockStarts.length) {
      const heads = sheet.getRange(1, 13, 2, blockStarts[blockStarts.length - 1] - 13 + 1).getValues();
      for (let i = 0; i < blockStarts.length; i++) {
        const idx = blockStarts[i] - 13;
        if (_NewCase_normalizeLabel(heads[0][idx], heads[1][idx]) === label) {
          blockStart = blockStarts[i];
          reused = true;
          break;
        }
      }
    }

    const nextStart = _NewCase_nextBlockStart(blockStarts);
    if (nextStart % 3 !== 13 % 3) throw new Error('ブロック列の位置が不正です: ' + nextStart);
    const templateStart = Number(opts.templateBlockStart) || (blockStarts.length ? blockStarts[blockStarts.length - 1] : 0);
    if (opts.dryRun) {
      return { dryRun: true, wouldWriteBlockStart: reused ? blockStart : nextStart, templateStart: templateStart, label: label, caseName: caseName, reused: reused };
    }

    if (!reused) {
      blockStart = nextStart;
      if (!templateStart) throw new Error('コピー元ブロックがありません');
      const requiredLastCol = blockStart + 2;
      if (sheet.getMaxColumns() < requiredLastCol) {
        sheet.insertColumnsAfter(sheet.getMaxColumns(), 3);
      }
      sheet.getRange(1, templateStart, 234, 3).copyTo(
        sheet.getRange(1, blockStart, 234, 3), SpreadsheetApp.CopyPasteType.PASTE_NORMAL, false);
      for (let i = 0; i < 3; i++) sheet.setColumnWidth(blockStart + i, sheet.getColumnWidth(templateStart + i));

      const nextMeetingFormula = sheet.getRange(9, blockStart).getFormula();
      sheet.getRange(13, blockStart, 222, 3).clearContent();
      sheet.getRange(1, blockStart, 8, 3).clearContent();
      const rewritten = _NewCase_rewriteImportrange(nextMeetingFormula, payload.zissiUrl);
      const meetingRange = sheet.getRange(9, blockStart, 1, 3);
      meetingRange.clearContent();
      if (rewritten && /IMPORTRANGE\s*\(/i.test(rewritten)) sheet.getRange(9, blockStart).setFormula(rewritten);
      sheet.getRange(10, blockStart, 1, 3).clearContent();
      sheet.getRange(1, blockStart, 8, 3).setValues(_NewCase_headValues(payload));
    }

    SpreadsheetApp.flush();
    const mismatches = reused ? [] : _NewCase_verifyHead(sheet.getRange(1, blockStart, 8, 3).getValues(), payload);
    const parsed = _Bulk_parsePeriod(payload.period);
    const startDate = parsed.start || String(payload.setupDate || '');
    const endDate = parsed.end || '';

    let caseResult = _Bulk_findCaseByMasterCol(_NCR_MASTER_SS, blockStart);
    if (!caseResult) {
      if (payload.zissiUrl) {
        caseResult = CaseList_importFromZissiUrl(payload.zissiUrl, {
          clientName: String(payload.clientName), caseName: caseName,
          startDate: startDate, endDate: endDate, boothSize: String(payload.boothSize || ''),
          phase: 2, masterSsId: _NCR_MASTER_SS, masterCol: blockStart
        });
      } else {
        caseResult = CaseList_create({
          clientName: String(payload.clientName), caseName: caseName,
          startDate: startDate, endDate: endDate, boothSize: String(payload.boothSize || '')
        });
        const created = CaseList_getById(caseResult.caseId);
        caseResult.rowIndex = created ? created.rowIndex : 0;
      }
    }

    // import の duplicate return を含め、案件一覧と今回の master ブロックの対応を固定する。
    const caseSheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
    const caseRow = Number(caseResult.rowIndex || 0);
    if (!caseSheet || !caseRow) throw new Error('案件一覧の登録行を特定できません');
    caseSheet.getRange(caseRow, CASE_COL_MASTER_SS).setValue(_NCR_MASTER_SS);
    caseSheet.getRange(caseRow, CASE_COL_MASTER_COL).setValue(blockStart);
    SpreadsheetApp.flush();
    const masterReadBack = caseSheet.getRange(caseRow, CASE_COL_MASTER_SS, 1, 2).getValues()[0];
    if (String(masterReadBack[0]) !== _NCR_MASTER_SS || Number(masterReadBack[1]) !== blockStart) {
      throw new Error('案件一覧 M/N 列の read-back verify に失敗しました');
    }

    const caseId = String(caseResult.caseId || '');
    const caseListRow = caseRow;
    const panel = Panel_ensureCasePanel(label);
    Panel_rebuildIndex();
    let meet = null;
    try { meet = CaseMeet_ensure(caseId); }
    catch (e) { meet = { ok: false, caseId: caseId, reason: String(e && e.message || e) }; }
    return {
      ok: true, caseId: caseId, blockStart: blockStart, blockStartA1: _NewCase_columnA1(blockStart), reused: reused,
      panelSheetName: panel.sheetName,
      panelUrl: 'https://docs.google.com/a/orgiast.jp/spreadsheets/d/' + _NCR_MASTER_SS + '/edit#gid=' + panel.gid,
      label: label, mismatches: mismatches, caseListRow: caseListRow,
      meetUrl: (meet && meet.ok) ? meet.meetUrl : '', meet: meet
    };
  } catch (e) {
    throw _NewCase_errorWithBlock(e, blockStart);
  } finally {
    lock.releaseLock();
  }
}

function NewCase_removeBlock(blockStart, expectClientName, opts) {
  opts = opts || {};
  const start = Number(blockStart);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const master = SpreadsheetApp.openById(_NCR_MASTER_SS);
    const sheet = master.getSheetByName(_NCR_TASK_SHEET);
    if (!sheet) return { ok: false, reason: 'sheet not found' };
    const blocks = [];
    for (let bs = 13; bs + 2 <= sheet.getLastColumn(); bs += 3) blocks.push(bs);
    const last = blocks.length ? blocks[blocks.length - 1] : 0;
    if (start !== last) return { ok: false, reason: '最終ブロックではありません', blockStart: start, lastBlockStart: last };
    const actualClientName = String(sheet.getRange(1, start).getValue() || '');
    if (actualClientName !== String(expectClientName || '')) {
      return { ok: false, reason: 'クライアント名が一致しません', blockStart: start, actualClientName: actualClientName };
    }
    if (opts.dryRun) return { ok: true, dryRun: true, blockStart: start, clientName: actualClientName };
    sheet.deleteColumns(start, 3);
    SpreadsheetApp.flush();
    return { ok: true, removed: true, blockStart: start, clientName: actualClientName };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 実機検証で作った案件を、関連リソースを含めて安全に撤去する。
 * opts.dryRun は明示的に false が渡された場合だけ解除される。
 */
function _admin_removeTestCase(caseId, opts) {
  opts = opts || {};
  const dryRun = opts.dryRun !== false;
  const needle = String(caseId || '').trim();
  const caseSheet = SpreadsheetApp.getActive().getSheetByName(CASE_LIST_SHEET_NAME);
  if (!caseSheet) return { ok: false, caseId: needle, dryRun: dryRun, reason: '案件一覧シートがありません' };

  const data = caseSheet.getDataRange().getValues();
  const matches = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0] || '').trim() === needle) matches.push({ rowIndex: i + 1, row: data[i] });
  }
  if (matches.length !== 1) {
    return {
      ok: false, caseId: needle, dryRun: dryRun,
      reason: matches.length ? '案件一覧に同じ caseId が複数あります' : '案件一覧に caseId がありません',
      matchCount: matches.length
    };
  }

  const found = matches[0];
  const clientName = String(found.row[1] || '');
  if (!_NewCase_isTestCase(clientName)) {
    return { ok: false, caseId: needle, dryRun: dryRun, reason: 'テスト案件ではありません', clientName: clientName };
  }

  const folderId = String(found.row[8] || '').trim();
  const masterCol = Number(found.row[CASE_COL_MASTER_COL - 1]) || 0;
  const ms = SpreadsheetApp.openById(_NCR_MASTER_SS);
  const task = ms.getSheetByName(_NCR_TASK_SHEET);
  let eventLabel = '';
  if (task && masterCol > 0) {
    eventLabel = _NewCase_normalizeLabel(task.getRange(1, masterCol).getValue(), task.getRange(2, masterCol).getValue());
  }

  const panelSheets = [];
  ms.getSheets().forEach(function (sheet) {
    try {
      const markerAndLabel = sheet.getRange('G1:G2').getValues();
      const marker = String(markerAndLabel[0][0] || '');
      const label = String(markerAndLabel[1][0] || '');
      if (marker !== 'BOOTH_PANEL_V2' && marker !== 'BOOTH_PANEL_V3') return;
      const panelCaseId = String(sheet.getRange('G4').getValue() || '').trim();
      if (panelCaseId === needle || (eventLabel && label === eventLabel)) {
        panelSheets.push({ sheet: sheet, name: sheet.getName(), label: label });
      }
    } catch (e) {}
  });

  let folderName = '';
  let folderLookupError = '';
  if (folderId) {
    try { folderName = DriveApp.getFolderById(folderId).getName(); }
    catch (e) { folderLookupError = String(e && e.message || e); }
  }
  const plan = {
    blockStart: masterCol,
    blockColumns: masterCol > 0 ? [masterCol, masterCol + 1, masterCol + 2] : [],
    caseRow: found.rowIndex,
    panelSheets: panelSheets.map(function (p) { return p.name; }),
    folder: { name: folderName, id: folderId }
  };
  if (dryRun) {
    return {
      ok: true, caseId: needle, dryRun: true, clientName: clientName,
      wouldRemove: plan,
      skipped: folderLookupError ? ['Drive フォルダを取得できません: ' + folderLookupError] : []
    };
  }

  const skipped = [];
  let blockRemoved = false;
  if (masterCol > 0) {
    const blockResult = NewCase_removeBlock(masterCol, clientName);
    blockRemoved = Boolean(blockResult && blockResult.ok && blockResult.removed);
    if (!blockRemoved) skipped.push('master block: ' + String(blockResult && blockResult.reason || '削除できませんでした'));
  } else {
    skipped.push('master block: masterCol がありません');
  }

  const panelSheetsDeleted = [];
  panelSheets.forEach(function (panel) {
    try { ms.deleteSheet(panel.sheet); panelSheetsDeleted.push(panel.name); }
    catch (e) { skipped.push('panel ' + panel.name + ': ' + String(e && e.message || e)); }
  });

  caseSheet.deleteRow(found.rowIndex);
  SpreadsheetApp.flush();

  let folderTrashed = '';
  if (!folderId) {
    skipped.push('Drive folder: フォルダ ID がありません');
  } else {
    try { DriveApp.getFolderById(folderId).setTrashed(true); folderTrashed = folderId; }
    catch (e) { skipped.push('Drive folder: ' + String(e && e.message || e)); }
  }

  try { Panel_rebuildIndex(); }
  catch (e) { skipped.push('panel index rebuild: ' + String(e && e.message || e)); }

  const remnants = [];
  if (CaseList_getById(needle)) remnants.push('caseList:' + needle);
  const gidMap = _Panel_gidMap(ms);
  panelSheets.forEach(function (panel) {
    if (panel.label && gidMap[panel.label]) remnants.push('panel:' + panel.label);
  });
  return {
    ok: remnants.length === 0,
    caseId: needle,
    dryRun: false,
    blockRemoved: blockRemoved,
    blockStart: masterCol,
    panelSheetsDeleted: panelSheetsDeleted,
    caseRowDeleted: found.rowIndex,
    folderTrashed: folderTrashed,
    skipped: skipped,
    remnants: remnants
  };
}

/**
 * task シートの案件ブロックの実形状を返す（読み取り専用）。
 * 新規ブロックを「既存と同じ形」で作るために、コピー元にする列の中身を実測する。
 *
 * @param {number} blockStart 調べたいブロックの先頭列（省略時は最右ブロック）
 */
function _debug_taskBlockShape(blockStart) {
  const ss = SpreadsheetApp.openById(_NCR_MASTER_SS);
  const sheet = ss.getSheetByName(_NCR_TASK_SHEET);
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  const maxRows = sheet.getMaxRows();
  const maxCols = sheet.getMaxColumns();

  const blocks = [];
  for (let bs = 13; bs + 2 <= lastCol; bs += 3) blocks.push(bs);
  const target = Number(blockStart) || blocks[blocks.length - 1];

  function a1(col) {
    let s = '';
    let n = col;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // 見出し行 1〜13 の値と数式（3列分）
  const headValues = sheet.getRange(1, target, 13, 3).getValues();
  const headFormulas = sheet.getRange(1, target, 13, 3).getFormulas();
  const head = headValues.map(function (row, i) {
    return {
      row: i + 1,
      values: row.map(function (v) { return v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd') : String(v || '').slice(0, 120); }),
      formulas: headFormulas[i].map(function (f) { return String(f || '').slice(0, 200); })
    };
  });

  // A〜F列（タスク定義側）の行数を D 列で数える（空3連で打ち切り = memory の実測ルール）
  const dCol = sheet.getRange(1, 4, Math.min(maxRows, 420), 1).getValues();
  let taskLastRow = 0;
  let blank = 0;
  for (let r = 12; r < dCol.length; r++) {
    const v = String(dCol[r][0] || '').trim();
    if (v) { blank = 0; taskLastRow = r + 1; } else { blank++; if (blank >= 3) break; }
  }

  // 案件列側の実データ最終行（3列のいずれかに値がある最後の行）
  const blockValues = sheet.getRange(1, target, Math.min(maxRows, 420), 3).getValues();
  let blockLastRow = 0;
  for (let r = 0; r < blockValues.length; r++) {
    if (blockValues[r].some(function (v) { return String(v || '').trim() !== ''; })) blockLastRow = r + 1;
  }

  // データ検証（進捗列 = ブロック3列目）のサンプル
  function validationAt(row, colOffset) {
    try {
      const dv = sheet.getRange(row, target + colOffset).getDataValidation();
      if (!dv) return null;
      return { type: String(dv.getCriteriaType()), values: dv.getCriteriaValues().map(function (v) { return Array.isArray(v) ? v : String(v); }) };
    } catch (e) { return { error: String(e) }; }
  }

  // 条件付き書式のうち、このブロックにかかっているルール数
  let cfCount = 0;
  try {
    sheet.getConditionalFormatRules().forEach(function (rule) {
      const hit = rule.getRanges().some(function (rg) {
        return rg.getColumn() <= target + 2 && rg.getLastColumn() >= target;
      });
      if (hit) cfCount++;
    });
  } catch (e) { cfCount = -1; }

  // 進捗行のサンプル（データがある行を 3 行）
  const samples = [];
  for (let r = 13; r <= Math.min(blockLastRow, taskLastRow) && samples.length < 3; r++) {
    const item = String(sheet.getRange(r, 4).getValue() || '').slice(0, 40);
    samples.push({
      row: r, item: item,
      block: sheet.getRange(r, target, 1, 3).getValues()[0].map(function (v) {
        return v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd') : String(v || '').slice(0, 40);
      }),
      validation3: validationAt(r, 2)
    });
  }

  return {
    lastCol: lastCol, lastColA1: a1(lastCol), maxCols: maxCols, lastRow: lastRow, maxRows: maxRows,
    blockCount: blocks.length,
    blockStarts: blocks.map(function (b) { return b + '(' + a1(b) + ')'; }),
    target: target, targetA1: a1(target),
    taskDefinitionLastRow: taskLastRow,
    blockLastRow: blockLastRow,
    head: head,
    samples: samples,
    columnWidths: [sheet.getColumnWidth(target), sheet.getColumnWidth(target + 1), sheet.getColumnWidth(target + 2)],
    conditionalFormatRulesTouchingBlock: cfCount,
    frozenRows: sheet.getFrozenRows(), frozenCols: sheet.getFrozenColumns()
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NewCaseForm_build: NewCaseForm_build,
    _NewCase_validate: _NewCase_validate,
    _NewCase_nextBlockStart: _NewCase_nextBlockStart,
    _NewCase_normalizeLabel: _NewCase_normalizeLabel,
    _NewCase_caseName: _NewCase_caseName,
    _NewCase_isTestCase: _NewCase_isTestCase,
    _NewCase_rewriteImportrange: _NewCase_rewriteImportrange,
    _NewCase_headValues: _NewCase_headValues,
    _NewCase_sameCell: _NewCase_sameCell,
    _NewCase_verifyHead: _NewCase_verifyHead
  };
}
