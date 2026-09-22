/**
 * Phase6: 最終見積 を生成。
 *
 * 目的:
 *   案件終了後、原価実績ベースで「最終見積」をクライアント請求/社内記録用にまとめる。
 *   初版見積 (Phase1_Estimate) との差分・追加発注・減額調整 を Claude が拾ってシートに出す。
 *
 * 出力:
 *   - zissi 内「Claude_最終見積」シート (品目別: 見積初版/最終/差分/差分理由)
 *   - 確認シートへの未確定項目積み上げ
 */

const FINAL_ESTIMATE_SHEET_NAME = 'Claude_最終見積';
const FINAL_ESTIMATE_HEADERS = ['カテゴリ', '品目', '数量', '初版単価', '最終単価', '初版小計', '最終小計', '差分', '差分理由'];

function Phase6_FinalEstimate_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) throw new Error('実施計画書が見つかりません。');

  // 初版見積 / アイテムリスト / 確認事項 を context として渡す
  const itemListSnippet = _Phase6_loadItemListSnippet(zissiSs);
  const estimateSnippet = _Phase6_loadEstimateSnippet(zissiSs);
  const costSnippet = _Phase6_loadCostSnippet(zissiSs);
  const confirmationLog = _Phase6_loadConfirmations(caseId);

  const manualPages = ManualLoader_findPages([
    '最終見積', '原価', '見積管理', '差分', '請求書'
  ]).slice(0, 6);

  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の案件の「最終見積」を、初版見積と実発注/実工数の差分を踏まえて作成してください。',
    '',
    '## 案件情報',
    '- 案件 ID: ' + c.caseId,
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '',
    '## アイテムリスト（Claude_アイテムリスト提案）',
    itemListSnippet || '(なし — Phase2 アイテムリストを先に生成推奨)',
    '',
    '## 初版見積シート抜粋',
    estimateSnippet || '(初版見積データなし)',
    '',
    '## 原価/発注実績シート抜粋',
    costSnippet || '(原価データなし — 未記入と判定)',
    '',
    '## 確認事項ログ',
    confirmationLog || '(空)',
    '',
    '## 出力形式（厳守・JSON 単体、説明文/```json``` ブロック禁止）',
    '{',
    '  "items": [',
    '    {',
    '      "category": "<カテゴリ>",',
    '      "name": "<品目名>",',
    '      "quantity": <数値>,',
    '      "initial_unit_price": <初版単価, 不明なら null>,',
    '      "final_unit_price": <最終単価, 不明なら null>,',
    '      "delta_reason": "<増減理由>"',
    '    }',
    '  ],',
    '  "missing_inputs": [',
    '    {"category": "<カテゴリ>", "content": "<不足情報>"}',
    '  ],',
    '  "summary": "<総括 (200 字以内)>"',
    '}',
    '',
    '## 重要ルール',
    '- 単価が不明な品目は initial_unit_price / final_unit_price を null にし、delta_reason に「単価未記入」と書く。推測で数値を埋めない。',
    '- 数量も不明なら 0 にして delta_reason に明記。',
    '- 差分は (final_unit_price * quantity) - (initial_unit_price * quantity) で計算側 (本実装側) が出す。Claude は単価と理由だけ書けばよい。',
    '- 差分理由は具体的に (例: 「現地でモニター追加発注」「電気容量増 → 工事費 +」「リユース確定で外注削減」)。',
    '- 品目は アイテムリスト + 初版見積に出てくる範囲。新規追加発注は実績シートから拾う。',
    '- ハルシネーション禁止。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 6000
  });

  const parsed = _Phase1_parseJson(res.text);
  const items = parsed.items || [];

  // 出力シート
  let outSheet = zissiSs.getSheetByName(FINAL_ESTIMATE_SHEET_NAME);
  if (!outSheet) {
    try { outSheet = zissiSs.insertSheet(FINAL_ESTIMATE_SHEET_NAME); }
    catch (e) { outSheet = zissiSs.getSheetByName(FINAL_ESTIMATE_SHEET_NAME); }
  } else {
    outSheet.clear();
  }
  outSheet.getRange(1, 1, 1, FINAL_ESTIMATE_HEADERS.length).setValues([FINAL_ESTIMATE_HEADERS])
    .setFontWeight('bold').setBackground('#d9ead3');
  outSheet.setFrozenRows(1);

  // メタ
  outSheet.getRange(2, 1).setValue('【総括】').setFontWeight('bold');
  outSheet.getRange(2, 2).setValue(String(parsed.summary || '').slice(0, 500));
  outSheet.getRange(2, 1, 1, FINAL_ESTIMATE_HEADERS.length).setBackground('#f3f3f3');

  if (items.length > 0) {
    const rows = items.map(function (it) {
      const qty = Number(it.quantity) || 0;
      const initial = (it.initial_unit_price == null) ? '' : Number(it.initial_unit_price);
      const final = (it.final_unit_price == null) ? '' : Number(it.final_unit_price);
      const initialTotal = (initial === '') ? '' : initial * qty;
      const finalTotal = (final === '') ? '' : final * qty;
      const delta = (initialTotal === '' || finalTotal === '') ? '' : (finalTotal - initialTotal);
      return [
        it.category || '',
        it.name || '',
        qty,
        initial,
        final,
        initialTotal,
        finalTotal,
        delta,
        it.delta_reason || ''
      ];
    });
    outSheet.getRange(3, 1, rows.length, FINAL_ESTIMATE_HEADERS.length).setValues(rows);

    // 合計行
    const totalRow = 3 + rows.length;
    let sumInitial = 0, sumFinal = 0;
    rows.forEach(function (r) {
      if (typeof r[5] === 'number') sumInitial += r[5];
      if (typeof r[6] === 'number') sumFinal += r[6];
    });
    outSheet.getRange(totalRow, 1).setValue('合計').setFontWeight('bold');
    outSheet.getRange(totalRow, 6).setValue(sumInitial).setFontWeight('bold');
    outSheet.getRange(totalRow, 7).setValue(sumFinal).setFontWeight('bold');
    outSheet.getRange(totalRow, 8).setValue(sumFinal - sumInitial).setFontWeight('bold');
    outSheet.getRange(totalRow, 1, 1, FINAL_ESTIMATE_HEADERS.length).setBackground('#fff2cc');

    // 金額カラム書式
    outSheet.getRange(3, 4, rows.length + 1, 5).setNumberFormat('#,##0');
  }

  // 列幅
  outSheet.setColumnWidth(1, 100); // カテゴリ
  outSheet.setColumnWidth(2, 240); // 品目
  outSheet.setColumnWidth(3, 60);  // 数量
  outSheet.setColumnWidth(4, 100); // 初版単価
  outSheet.setColumnWidth(5, 100); // 最終単価
  outSheet.setColumnWidth(6, 110); // 初版小計
  outSheet.setColumnWidth(7, 110); // 最終小計
  outSheet.setColumnWidth(8, 100); // 差分
  outSheet.setColumnWidth(9, 260); // 差分理由

  const sheetUrl = PanelLinks_sheetUrl(zissiSs, outSheet);

  // missing_inputs を確認シートに
  const missing = parsed.missing_inputs || [];
  if (missing.length > 0) {
    const tagged = missing.map(function (m) {
      return { category: '[最終見積/補完依頼] ' + (m.category || ''), content: m.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 6);
  }

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '最終見積',
    '最終見積 (' + items.length + ' 品目)', sheetUrl);

  return {
    sheetUrl: sheetUrl,
    sheetName: FINAL_ESTIMATE_SHEET_NAME,
    itemCount: items.length,
    missingInputCount: missing.length,
    summary: parsed.summary || '',
    usage: res.usage
  };
}

function _Phase6_loadItemListSnippet(zissiSs) {
  try {
    const sheet = zissiSs.getSheetByName(ITEMLIST_PROPOSAL_SHEET_NAME);
    if (!sheet) return '';
    const lastRow = Math.min(sheet.getLastRow(), 200);
    if (lastRow < 2) return '';
    const data = sheet.getRange(2, 1, lastRow - 1, Math.min(sheet.getLastColumn(), 8)).getValues();
    const lines = [];
    data.forEach(function (row) {
      const text = row.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' / ');
      if (text) lines.push(text);
    });
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

function _Phase6_loadEstimateSnippet(zissiSs) {
  // 「見積」または「管理画面」シート (案件毎の見積テンプレ)
  const sheet = _Phase6_findSheetByKeyword(zissiSs, ['管理画面', '見積', 'estimate']);
  if (!sheet) return '';
  try {
    const lastRow = Math.min(sheet.getLastRow(), 50);
    const lastCol = Math.min(sheet.getLastColumn(), 12);
    if (lastRow < 2 || lastCol < 2) return '';
    const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const lines = ['--- 「' + sheet.getName() + '」シート抜粋 ---'];
    data.forEach(function (row) {
      const text = row.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' | ');
      if (text) lines.push(text);
    });
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}

function _Phase6_loadCostSnippet(zissiSs) {
  // 「原価」「発注」「外注」 などのシート
  const sheets = zissiSs.getSheets();
  const candidates = [];
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    if (name.indexOf('原価') >= 0 || name.indexOf('発注') >= 0 || name.indexOf('外注') >= 0 || name.indexOf('実績') >= 0) {
      candidates.push(sheets[i]);
    }
  }
  if (candidates.length === 0) return '';
  const lines = [];
  candidates.slice(0, 2).forEach(function (sh) {
    try {
      const lastRow = Math.min(sh.getLastRow(), 60);
      const lastCol = Math.min(sh.getLastColumn(), 10);
      if (lastRow < 2 || lastCol < 2) return;
      const data = sh.getRange(1, 1, lastRow, lastCol).getValues();
      lines.push('--- 「' + sh.getName() + '」シート抜粋 ---');
      data.forEach(function (row) {
        const text = row.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' | ');
        if (text) lines.push(text);
      });
    } catch (e) {}
  });
  return lines.join('\n');
}
