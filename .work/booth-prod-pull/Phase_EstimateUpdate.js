/** 見積本体を変更せず、明細シートの複製に更新案を作成する。 */
function _EstimateUpdate_number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[,￥¥円\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function EstimateUpdate_buildPlan(currentRows, llmRows) {
  if (!Array.isArray(llmRows)) throw new Error('detailRows が配列ではありません: typeof=' + typeof llmRows);
  const confirmations = [], rows = [];
  const currentByIndex = new Map(currentRows.map(function (r) { return [r.rowIndex, r]; }));
  const proposedByIndex = new Map(), additions = [];
  llmRows.forEach(function (r) {
    const index = r && r.rowIndex;
    if (typeof index !== 'number' || !Number.isFinite(index) || !currentByIndex.has(index)) {
      if (r && r.change === '新規') additions.push(r);
      else confirmations.push({ category: '見積更新', content: '対応する現行行が見つからないため無視: ' + (r && r.itemName || '項目') });
    } else if (proposedByIndex.has(index)) {
      confirmations.push({ category: '見積更新', content: 'rowIndex が重複したため最初の1件を採用: ' + index + ' / ' + (r.itemName || '項目') });
    } else proposedByIndex.set(index, r);
  });
  function normalize(proposed, current) {
    // 削除指示は行番号だけで現行値を補完する。変更行の金額欠落ガードは維持する。
    let row = Object.assign({}, current && proposed.change === '削除' ? current : {}, proposed);
    const before = current ? { unitPrice: current.unitPrice, qty: current.qty } : { unitPrice: 0, qty: 0 };
    before.amount = before.unitPrice * before.qty;
    const missing = _EstimateUpdate_number(row.unitPrice) === null || _EstimateUpdate_number(row.qty) === null;
    const different = !current || ['category', 'itemName', 'spec', 'note', 'unit'].some(function (k) { return String(row[k] || '') !== String(current[k] || ''); }) || Number(row.unitPrice) !== current.unitPrice || Number(row.qty) !== current.qty || row.change === '削除';
    if (missing || (different && !String(row.source || '').trim())) {
      confirmations.push({ category: '見積更新', content: (row.itemName || '項目') + ': 金額・数量または変更根拠が不明のため' + (current ? '現行値を据置' : '新規項目を保留') });
      if (!current) return;
      row = Object.assign({}, current, { reason: '', source: '', cost: row.cost });
    }
    row.unitPrice = _EstimateUpdate_number(row.unitPrice); row.qty = _EstimateUpdate_number(row.qty);
    row.sheetRow = current ? current.sheetRow : null;
    row.before = before;
    row.change = !current ? '新規' : row.change === '削除' ? '削除' :
      ['category', 'itemName', 'spec', 'note', 'unit', 'unitPrice', 'qty'].some(function (k) { return String(row[k] == null ? '' : row[k]) !== String(current[k] == null ? '' : current[k]); }) ? '変更' : '据置';
    row.amount = row.unitPrice * row.qty;
    row.cost = Object.assign({ amount: 0, source: '', confidence: 'low' }, row.cost || {});
    row.cost.amount = _EstimateUpdate_number(row.cost.amount) || 0;
    if (!row.cost.source) { row.cost.amount = 0; row.cost.confidence = 'low'; }
    rows.push(row);
  }
  currentRows.forEach(function (r) { normalize(proposedByIndex.get(r.rowIndex) || Object.assign({}, r, { change: '据置' }), r); });
  additions.forEach(function (r) { normalize(Object.assign({}, r, { rowIndex: null }), null); });
  const pasteRows = rows.filter(function (r) { return r.change !== '削除'; });
  const totalBefore = currentRows.reduce(function (s, r) { return s + r.amount; }, 0);
  const totalAfter = pasteRows.reduce(function (s, r) { return s + r.amount; }, 0);
  const costTotal = pasteRows.reduce(function (s, r) { return s + r.cost.amount; }, 0);
  return { pasteRows: pasteRows, deletedRows: rows.filter(function (r) { return r.change === '削除'; }),
    changes: rows.filter(function (r) { return r.change !== '据置'; }), confirmations: confirmations,
    totals: { totalBefore: totalBefore, totalAfter: totalAfter, diff: totalAfter - totalBefore, costTotal: costTotal, grossProfit: totalAfter - costTotal } };
}

function EstimateUpdate_guardCustomerText(text, forbiddenWords) {
  const confirmations = [];
  const result = String(text || '').split('\n').map(function (line) {
    if (/原価|粗利|仕入|発注先|利益|マージン|要確認|未読込|未確認|確認必要|社内/.test(line) || (forbiddenWords || []).some(function (word) { return word && line.indexOf(word) >= 0; })) {
      confirmations.push({ category: 'お客様説明文', content: '社内情報の可能性がある行を非表示: ' + line });
      return null;
    }
    return line;
  }).filter(function (line) { return line !== null; }).join('\n').replace(/\n[ \t\r]*\n(?:[ \t\r]*\n)+/g, '\n\n');
  return { text: result, confirmations: confirmations };
}

function EstimateUpdate_buildCustomerLetter(letter, changes, totals, taxRate) {
  letter = letter || {};
  function yen(n) { return Number(n).toLocaleString('ja-JP') + '円'; }
  const lines = [letter.greeting || '', '変更点'];
  changes.forEach(function (r) {
    lines.push('・' + r.itemName + ' / ' + yen(r.before.amount) + ' → ' + yen(r.change === '削除' ? 0 : r.amount) + '（' + r.change + '）' + (r.customerReason ? ' / ' + r.customerReason : ''));
  });
  if (!changes.length) lines.push('変更はありません。');
  lines.push('お見積合計', '税抜 ' + yen(totals.totalBefore) + ' → ' + yen(totals.totalAfter) + '（差額 ' + yen(totals.diff) + '）');
  if (typeof taxRate === 'number' && Number.isFinite(taxRate)) lines.push('税込 ' + yen(Math.round(totals.totalBefore * (1 + taxRate))) + ' → ' + yen(Math.round(totals.totalAfter * (1 + taxRate))));
  lines.push(letter.closing || '');
  return { subject: letter.subject || 'お見積更新のご案内', body: lines.join('\n') };
}

function _EstimateUpdate_selectFiles(files, decisions) {
  const eligible = _CostProfit_filterExcludedFiles(files, decisions).filter(_CostProfit_isSupplierCandidate).sort(function (a, b) {
    return (a.priority == null ? 2 : a.priority) - (b.priority == null ? 2 : b.priority) || (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });
  const attached = [], tabular = [], skipped = [];
  eligible.forEach(function (f) {
    if (_CostProfit_isTabularMime(f.mimeType)) {
      if (tabular.length < 2) tabular.push(f); else skipped.push(f);
    } else {
      const kind = CaseMaterials_kindForMimeType(f.mimeType);
      if (kind && attached.length < 3) attached.push(Object.assign({}, f, { kind: kind })); else skipped.push(f);
    }
  });
  return { attached: attached, tabular: tabular, skipped: skipped };
}

function _EstimateUpdate_prioritizeFiles(c, files) {
  const rootId = Case_resolveProjectRoot(c), priorities = {};
  // 既存スキャンで得た候補の祖先だけ確認し、制作/預かりを優先する。
  let azukari = '';
  try { azukari = Azukari_resolveFolderId(c, { create: false }); } catch (e) {}
  files.forEach(function (f) {
    let best = 2, visited = {};
    function parents(node, depth, underAzukari) {
      if (depth > 5) return;
      const it = node.getParents();
      while (it.hasNext()) {
        const p = it.next(), id = p.getId(), key = id + ':' + underAzukari;
        if (visited[key]) continue;
        visited[key] = true;
        const under = underAzukari || id === azukari || /預かり/.test(p.getName());
        if (id !== rootId && /制作/.test(p.getName())) best = Math.min(best, under ? 0 : 1);
        if (id !== rootId) parents(p, depth + 1, under);
      }
    }
    parents(DriveApp.getFileById(f.driveFileId), 0, false);
    priorities[f.driveFileId] = best;
  });
  return files.map(function (f) { return Object.assign({}, f, { priority: priorities[f.driveFileId] }); });
}

function _EstimateUpdate_readCurrent(sheet, headerRow, mgmt) {
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 13).getValues();
  const separateMgmt = sheet.getSheetId() !== mgmt.getSheetId();
  const fieldValues = separateMgmt ? mgmt.getRange(1, 1, mgmt.getLastRow(), 2).getValues() : values.slice(0, headerRow - 1);
  const fields = fieldValues.map(function (r, i) { return { label: String(r[0] || ''), value: String(r[1] == null ? '' : r[1]), row: i + 1 }; }).filter(function (f) { return f.label; });
  const rows = [];
  let endRow = headerRow;
  for (let i = headerRow; i < values.length; i++) {
    const r = values[i];
    if (r.slice(0, 4).some(function (v) { return /^(項目計|小計|合計|オプション)$/.test(String(v || '').trim()); })) break;
    if (!r.slice(0, 7).some(function (v) { return v !== ''; })) continue;
    const price = _EstimateUpdate_number(r[4]), qty = _EstimateUpdate_number(r[5]);
    // テンプレのガード行・カテゴリだけの行は明細として数えない。
    if (!r[1] || (price === null && qty === null)) continue;
    const amount = _EstimateUpdate_number(r[11]);
    if (price === null || qty === null || amount === null) throw new Error('現行明細の金額を読み取れません: ' + (i + 1) + '行');
    rows.push({ rowIndex: rows.length + 1, sheetRow: i + 1, category: String(r[0] || ''), itemName: String(r[1]), spec: String(r[2] || ''), note: String(r[3] || ''), unitPrice: price, qty: qty, unit: String(r[6] || ''), amount: amount });
    endRow = i + 1;
  }
  if (!rows.length) throw new Error('明細シートの現行明細がありません: ' + sheet.getName());
  return { fields: fields, rows: rows, header: headerRow, endRow: endRow, maxSheetRow: endRow, templateLastColumn: sheet.getLastColumn(),
    detailSheetName: sheet.getName(), mgmtSheetName: mgmt.getName(), separateMgmt: separateMgmt };
}

function _EstimateUpdate_cells(row) {
  return [row.category || '', row.itemName || '', row.spec || '', row.note || '', row.unitPrice, row.qty, row.unit || ''];
}
function _EstimateUpdate_safe(value) { return typeof value === 'string' && /^[=+@]/.test(value) ? "'" + value : value; }
function _EstimateUpdate_writeProposal(sheet, current, plan, fields) {
  const additions = plan.pasteRows.filter(function (r) { return r.change === '新規'; });
  const maxSheetRow = current.maxSheetRow || current.endRow;
  const first = current.header + 1, last = maxSheetRow + additions.length;
  if (additions.length) sheet.insertRowsAfter(maxSheetRow, additions.length);
  additions.forEach(function (r, i) {
    r.sheetRow = maxSheetRow + i + 1;
    sheet.getRange(maxSheetRow, 12, 1, 2).copyTo(sheet.getRange(r.sheetRow, 12, 1, 2));
  });
  // 削除一覧は集計・注記を含むテンプレ全体の末尾へ。明細の間には挿入しない。
  const deletedStart = Math.max(sheet.getLastRow(), last) + 3;
  const aux = Math.max(13, current.templateLastColumn) + 2;
  const needed = deletedStart + plan.deletedRows.length;
  if (needed > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  if (aux + 8 > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), aux + 8 - sheet.getMaxColumns());
  const fieldProposals = [];
  (fields || []).forEach(function (field) {
    const match = current.fields.find(function (f) { return f.label === field.label; });
    if (!match || field.value == null) return;
    if (current.separateMgmt) fieldProposals.push([match.label, match.value, String(field.value), '貼付先: ' + current.mgmtSheetName + '!B' + match.row].map(_EstimateUpdate_safe));
    else sheet.getRange(match.row, 2).setValue(_EstimateUpdate_safe(String(field.value)));
  });
  plan.pasteRows.forEach(function (r) {
    sheet.getRange(r.sheetRow, 1, 1, 7).setValues([_EstimateUpdate_cells(r).map(_EstimateUpdate_safe)]);
  });
  plan.deletedRows.forEach(function (r) { sheet.getRange(r.sheetRow, 1, 1, 7).clearContent(); });
  sheet.getRange(current.header, aux, 1, 9).setValues([['変更', '変更前単価', '変更前数量', '変更前金額', '根拠', '原価(最新)', '原価出典', '原価信頼度', '行粗利']]);
  plan.pasteRows.concat(plan.deletedRows).forEach(function (r) {
    sheet.getRange(r.sheetRow, aux, 1, 9).setValues([[r.change, r.before.unitPrice, r.before.qty, r.before.amount, r.source || '', r.cost.amount, r.cost.source, r.cost.confidence, (r.change === '削除' ? 0 : r.amount) - r.cost.amount].map(_EstimateUpdate_safe)]);
  });
  sheet.getRange(1, aux).setValue('貼付手順: A' + first + ':G' + last + ' をコピー → 「' + current.detailSheetName + '」の同じ位置に「値のみ貼り付け」（Ctrl+Shift+V）。空になった行は削除項目です');
  sheet.getRange(2, aux).setValue('合計 変更前 ' + plan.totals.totalBefore + ' → 変更後 ' + plan.totals.totalAfter + '（差額 ' + plan.totals.diff + '）');
  if (plan.deletedRows.length) {
    sheet.getRange(deletedStart, 1).setValue('── 削除した項目（貼付範囲外）──');
    sheet.getRange(deletedStart + 1, 1, plan.deletedRows.length, 7).setValues(plan.deletedRows.map(function (r) { return _EstimateUpdate_cells(r).map(_EstimateUpdate_safe); }));
  }
  if (fieldProposals.length) {
    const fieldStart = Math.max(current.endRow, last) + plan.deletedRows.length + 5;
    const fieldEnd = fieldStart + 1 + fieldProposals.length;
    if (fieldEnd > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), fieldEnd - sheet.getMaxRows());
    sheet.getRange(fieldStart, aux).setValue('上部フィールド更新案');
    sheet.getRange(fieldStart + 1, aux, 1, 4).setValues([['ラベル', '現在値', '更新案', '貼付先']]);
    sheet.getRange(fieldStart + 2, aux, fieldProposals.length, 4).setValues(fieldProposals);
  }
}

// 値の型・前後空白の差は吸収し、不一致は診断として返す。
function _EstimateUpdate_verify(sheet, ranges, confirmations, category) {
  const verify = { checked: 0, mismatches: [] };
  let mismatchCount = 0;
  ranges.forEach(function (entry) {
    const actual = sheet.getRange(entry.row, entry.col, entry.values.length, entry.values[0].length).getValues();
    entry.values.forEach(function (row, i) {
      row.forEach(function (value, j) {
        const expected = String(value == null ? '' : value).trim();
        const observed = String(actual[i][j] == null ? '' : actual[i][j]).trim();
        verify.checked++;
        if (expected === observed || (Number.isFinite(Number(expected)) && Number.isFinite(Number(observed)) && Number(expected) === Number(observed))) return;
        mismatchCount++;
        if (verify.mismatches.length < 20) verify.mismatches.push({ cell: String.fromCharCode(65 + entry.col - 1 + j) + (entry.row + i), expected: expected, actual: observed });
      });
    });
  });
  if (mismatchCount) {
    const first = verify.mismatches[0];
    confirmations.push({ category: category, content: '書込後検証で ' + mismatchCount + ' セル不一致（先頭: ' + first.cell + ' 期待=' + first.expected + ' 実際=' + first.actual + '）' });
  }
  return verify;
}

function Phase_EstimateUpdate_generate(caseId, pastedText) {
  const detail = { currentRows: 0, llmRows: 0 };
  try {
    const c = CaseList_getById(caseId);
    if (!c) throw new Error('案件が見つかりません: ' + caseId);
    const files = _CostProfit_scanFiles(c), own = _CostProfit_findLatestOwnEstimate(files, caseId);
    if (!own) throw new Error('見積書がまだありません。先に「見積書を作る」を実行してください');
    const ss = SpreadsheetApp.openById(own.driveFileId);
    const originals = ss.getSheets().filter(function (s) { return !/^Claude_/.test(s.getName()); });
    const mgmt = _Estimate_findMgmtSheet({ getSheets: function () { return originals; } });
    if (!mgmt) throw new Error('管理画面シートが見つかりません');
    const target = _Estimate_findDetailHeaderRow({ getSheets: function () { return originals; } });
    if (!target) throw new Error('明細見出し（カテゴリ/項目/単価）がどのシートにもありません: ' + originals.slice(0, 5).map(function (s) { return s.getName(); }).join('、'));
    const detailSheet = target.sheet;
    const current = _EstimateUpdate_readCurrent(detailSheet, target.row, mgmt), confirmations = [];
    detail.currentRows = current.rows.length;
    const cached = Case_loadClientContext(c);
    try { Case_refreshClientContext(caseId); } catch (e) { confirmations.push({ category: '資料', content: '議事録・メールの最新化に失敗。キャッシュを使用' }); }
    const context = Case_loadClientContext(c) || cached;
    if (!context) confirmations.push({ category: '資料', content: '議事録・メールを取得できませんでした' });
    let baseline = [], decisions = [];
    if (c.zissiId) {
      const zissi = SpreadsheetApp.openById(c.zissiId);
      const ledger = zissi.getSheetByName('Claude_原価粗利'), decision = zissi.getSheetByName('Claude_原価粗利_ファイル');
      if (ledger && ledger.getLastRow() >= 4) baseline = ledger.getRange(4, 1, ledger.getLastRow() - 3, 12).getDisplayValues().filter(function (r) { return r[1] === '原価'; });
      if (decision && decision.getLastRow() >= 2) decisions = decision.getRange(2, 1, decision.getLastRow() - 1, 2).getDisplayValues().map(function (r) { return { name: r[0], side: r[1] }; });
    }
    const selection = _EstimateUpdate_selectFiles(_EstimateUpdate_prioritizeFiles(c, _CostProfit_filterExcludedFiles(files, decisions).filter(_CostProfit_isSupplierCandidate)), decisions);
    const tabular = [];
    selection.tabular.forEach(function (f) { const text = _CostProfit_readTabularQuote(f); if (text) tabular.push(f.label + '\n' + text); else selection.skipped.push(f); });
    if (selection.skipped.length) confirmations.push({ category: '資料', content: '未読込の預かり見積あり: ' + selection.skipped.map(function (f) { return f.label; }).join('、') });
    if (files.scanTruncated) confirmations.push({ category: '資料', content: 'フォルダ走査上限に達したため未読込資料あり' });
    const res = ClaudeClient_call({
      system: '見積更新案を作る。捏造禁止。不明点はconfirmationsに記載する。税抜で統一。',
      cachedContext: [KNOWHOW_ESTIMATE_RULES, KNOWHOW_MAIL_RULES, context, String(_Estimate_loadPriceList()).slice(0, 12000), ManualLoader_findPages(['見積書に売値をいれる', '原価の反映']).map(function (p) { return p.title + '\n' + p.body; }).join('\n')],
      userMessage: [
        '現行見積: ' + JSON.stringify(current.rows), '上部フィールド: ' + JSON.stringify(current.fields),
        '原価台帳（更新日時/区分/仕入先/項目/仕様/数量/単位/単価/金額/出典/信頼度/メモ）: ' + (baseline.length ? JSON.stringify(baseline) : '台帳なし'),
        '預かり見積: ' + tabular.join('\n'), '未読込: ' + selection.skipped.map(function (f) { return f.label; }).join('、'), '追加指示: ' + String(pastedText || ''),
        'detailRowsの変更・削除する行は現行のrowIndexを必ず付けて返す。据置の行は返さなくてよい（返す場合もrowIndex付き）。新規行はrowIndex:nullとchange:新規を付ける。',
        '変更・新規・削除は議事録・メール・預かり見積・追加指示の根拠がある場合だけ。sourceに議事録の日付/メール件名/ファイル名を必ず書く。根拠のない変更は禁止。',
        '売価は価格表・現行見積が根拠。入力にない金額を作らない。読めない値は現行値を据え置きconfirmationsに理由を書く。costは預かり見積・原価台帳から最新だけを反映、重複計上しない。なければamount:0,confidence:low。cost.sourceには仕入先名と出典を記載。',
        'customerLetterは件名・挨拶・結びだけ。変更一覧・金額はコードで作る。原価・粗利・仕入先名・社内事情を書かない。',
        'reasonは社内向け（根拠・判断・未確認事項を率直に）。customerReasonはお客様にそのまま見せる一言（丁寧語・20字以内・社内事情や「要確認」等を含めない。顧客に説明不要なら空文字）。',
        'JSON単体、前後の説明文なし: {"mgmtFields":[{"label":"","value":""}],"detailRows":[{"rowIndex":null,"category":"","itemName":"","spec":"","note":"","unitPrice":0,"qty":1,"unit":"式","change":"新規|変更|据置|削除","before":{"unitPrice":0,"qty":0},"reason":"","customerReason":"","source":"","cost":{"amount":0,"source":"","confidence":"high|mid|low"}}],"customerLetter":{"subject":"","greeting":"","closing":""},"confirmations":[{"category":"","content":""}]}'
      ].join('\n'), documents: selection.attached, maxTokens: 12000
    });
    let parsed;
    try { parsed = _Phase1_parseJson(res.text); }
    catch (e) { detail.rawHead = String(res.text || '').slice(0, 300); throw e; }
    const llmRows = parsed && parsed.detailRows;
    detail.llmRows = Array.isArray(llmRows) ? llmRows.length : 0;
    const plan = EstimateUpdate_buildPlan(current.rows, llmRows);
    confirmations.push.apply(confirmations, plan.confirmations.concat(Array.isArray(parsed.confirmations) ? parsed.confirmations : []));
    let taxRate = null;
    current.fields.forEach(function (f) { if (/^(消費)?税率$/.test(f.label)) { const n = _EstimateUpdate_number(f.value.replace('%', '')); if (n !== null && n >= 0 && n <= 100) taxRate = /%/.test(f.value) || n > 1 ? n / 100 : n; } });
    const letter = EstimateUpdate_buildCustomerLetter(parsed.customerLetter, plan.changes, plan.totals, taxRate);
    const forbidden = baseline.map(function (r) { return r[2]; }).filter(Boolean);
    plan.pasteRows.concat(plan.deletedRows).forEach(function (r) { String(r.cost.source || '').split(/[\s_:：/、,（）()\[\]]+/).filter(Boolean).forEach(function (s) { forbidden.push(s); }); });
    const subject = EstimateUpdate_guardCustomerText(letter.subject, forbidden), body = EstimateUpdate_guardCustomerText(letter.body, forbidden);
    confirmations.push.apply(confirmations, subject.confirmations.concat(body.confirmations));
    const baseName = 'Claude_見積更新案_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MMdd_HHmm');
    let sheetName = baseName, suffix = 2;
    while (ss.getSheetByName(sheetName)) sheetName = baseName + '_' + suffix++;
    const proposal = detailSheet.copyTo(ss).setName(sheetName);
    _EstimateUpdate_writeProposal(proposal, current, plan, parsed.mgmtFields);
    const letterSheet = ss.getSheetByName('Claude_お客様説明文') || ss.insertSheet('Claude_お客様説明文');
    const paragraphs = body.text.split('\n');
    if (paragraphs.length + 3 > letterSheet.getMaxRows()) letterSheet.insertRowsAfter(letterSheet.getMaxRows(), paragraphs.length + 3 - letterSheet.getMaxRows());
    letterSheet.getRange(1, 1, Math.max(4, letterSheet.getLastRow()), 2).clearContent();
    letterSheet.getRange(1, 1, 1, 2).setValues([['件名', _EstimateUpdate_safe(subject.text)]]);
    letterSheet.getRange(3, 1).setValue('本文');
    letterSheet.getRange(4, 1, paragraphs.length, 1).setValues(paragraphs.map(function (p) { return [_EstimateUpdate_safe(p)]; }));
    SpreadsheetApp.flush();
    const verify = _EstimateUpdate_verify(proposal, plan.pasteRows.concat(plan.deletedRows).map(function (r) {
      return { row: r.sheetRow, col: 1, values: [r.change === '削除' ? ['', '', '', '', '', '', ''] : _EstimateUpdate_cells(r)] };
    }).sort(function (a, b) { return a.row - b.row; }), confirmations, '見積更新');
    const letterVerify = _EstimateUpdate_verify(letterSheet, [
      { row: 1, col: 2, values: [[subject.text]] },
      { row: 4, col: 1, values: paragraphs.map(function (p) { return [p]; }) }
    ], confirmations, 'お客様説明文');
    const estimateUrl = ss.getUrl(), estimateUpdateUrl = PanelLinks_sheetUrl(ss, proposal);
    // 成果物（更新案シート・説明文）は書けているので、以降の記録系は best-effort（2026-10-03 実測: ConfirmationSheet 等の DriveApp 拒否で全体が ok:false になった）
    const postErrors = [];
    [['confirmations', function () { if (confirmations.length) ConfirmationSheet_appendItems(caseId, confirmations, '[見積更新]'); }],
     ['artifact', function () { MasterWriteBack_recordArtifact(caseId, '見積更新案', sheetName, estimateUpdateUrl); }],
     ['touch', function () { CaseList_touchUpdatedAt(caseId); }]].forEach(function (step) {
      try { step[1](); } catch (e) { postErrors.push({ step: step[0], error: String(e && e.message || e) }); }
    });
    let enqueued = false;
    try { enqueued = !!_CostProfit_enqueue(caseId); } catch (e) { postErrors.push({ step: 'costProfitEnqueue', error: String(e && e.message || e) }); }
    return Object.assign({ ok: true, verify: verify, letterVerify: letterVerify, postErrors: postErrors, estimateUrl: estimateUrl, estimateUpdateUrl: estimateUpdateUrl, customerLetterUrl: PanelLinks_sheetUrl(ss, letterSheet), sheetName: sheetName,
      changed: plan.changes.filter(function (r) { return r.change === '変更'; }).length, added: plan.changes.filter(function (r) { return r.change === '新規'; }).length, deleted: plan.deletedRows.length,
      attachedFiles: selection.attached.map(function (f) { return f.label; }), skippedFiles: selection.skipped.map(function (f) { return f.label; }), confirmationCount: confirmations.length, costProfitEnqueued: enqueued, usage: JSON.parse(JSON.stringify(res.usage || {})) }, plan.totals);
  } catch (e) { return { ok: false, error: String(e && e.message || e), detail: detail }; }
}
