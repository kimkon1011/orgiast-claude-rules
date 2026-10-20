/**
 * Phase6: スタッフ評価 を生成。
 *
 * 目的:
 *   案件で動いたメンバー (制作 D、運営、施工、ドライバー、外注パートナー) について
 *   タスク完了率・確認事項対応・現場 incident をもとに「事実ベースのレビュー素材」を作る。
 *   人事評価そのものではなく、評価会議に持ち込む素材としてのドラフト。
 *   ハルシネーション禁止 — 推測の人格評価は禁止、行動事実のみ。
 *
 * 出力:
 *   zissi 内「Claude_スタッフ評価」シート + 確認シート積み上げ
 */

const STAFF_EVAL_SHEET_NAME = 'Claude_スタッフ評価';
const STAFF_EVAL_HEADERS = ['担当', '役割', '良かった行動 (事実)', '改善余地 (事実)', '次回への期待', 'データ充足度'];

function Phase6_StaffEval_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) throw new Error('実施計画書が見つかりません。');

  // タスク進捗 / 確認事項 / 報告書 を context にする
  const taskSnippet = _Phase6_loadTaskAssigneeSnippet(zissiSs);
  const confirmationLog = _Phase6_loadConfirmations(caseId);
  const reportDocText = _Phase6_loadReportDocText(zissiSs);

  const manualPages = ManualLoader_findPages([
    'スタッフ評価', '評価', '人事', 'KPI'
  ]).slice(0, 5);

  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の案件で動いたメンバーについて、評価会議用の「事実ベースのレビュー素材」を作成してください。',
    '人格評価・推測の性格描写は絶対に書かないこと。事実（タスク完了/未完、確認事項対応、現場記録）に基づく事象のみ書く。',
    '',
    '## 案件情報',
    '- 案件 ID: ' + c.caseId,
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '',
    '## タスク進捗（担当別抜粋）',
    taskSnippet || '(taskシート無し or 担当列空)',
    '',
    '## 確認事項ログ',
    confirmationLog || '(空)',
    '',
    '## 報告書 Doc 抜粋',
    reportDocText || '(報告書未生成)',
    '',
    '## 出力形式（厳守・JSON 単体、説明文/```json``` ブロック禁止）',
    '{',
    '  "members": [',
    '    {',
    '      "name": "<担当者名 (タスク表記のまま)>",',
    '      "role": "<役割: 制作ディレクター / 営業 / 運営 / 施工 / ドライバー / 外注パートナー>",',
    '      "positive_actions": "<事実として観察できた良かった行動。データから引用>",',
    '      "improvement_areas": "<事実として観察できた改善余地。データから引用>",',
    '      "next_expectation": "<次回への期待を 1〜2 文>",',
    '      "data_sufficiency": "high|mid|low"',
    '    }',
    '  ],',
    '  "missing_inputs": [',
    '    {"category": "<カテゴリ>", "content": "<不足情報>"}',
    '  ]',
    '}',
    '',
    '## 厳守ルール',
    '- 人格 (例: 「真面目」「気が利く」「やる気がある」) を書かない。**事実描写のみ** (例: 「タスクA, B, C を期日内完了」「確認事項#5 への返信が 3 日遅延」)。',
    '- データに登場しないメンバーは含めない。',
    '- データから observable な行動が無い場合は data_sufficiency=low、positive_actions/improvement_areas に「観察可能データなし」と書く。',
    '- 推測で「次回はこう改善できそう」と書かない。事実から導けるアクションだけ next_expectation に書く。',
    '- ハルシネーション禁止。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 6000
  });

  const parsed = _Phase1_parseJson(res.text);
  const members = parsed.members || [];

  let outSheet = zissiSs.getSheetByName(STAFF_EVAL_SHEET_NAME);
  if (!outSheet) {
    try { outSheet = zissiSs.insertSheet(STAFF_EVAL_SHEET_NAME); }
    catch (e) { outSheet = zissiSs.getSheetByName(STAFF_EVAL_SHEET_NAME); }
  } else {
    outSheet.clear();
  }
  outSheet.getRange(1, 1, 1, STAFF_EVAL_HEADERS.length).setValues([STAFF_EVAL_HEADERS])
    .setFontWeight('bold').setBackground('#cfe2f3');
  outSheet.setFrozenRows(1);

  // 注意書き行
  outSheet.getRange(2, 1).setValue('※ Claude による事実ベースのドラフトです。最終評価は会議で判断してください。')
    .setFontStyle('italic');
  outSheet.getRange(2, 1, 1, STAFF_EVAL_HEADERS.length).merge().setBackground('#fff2cc');

  if (members.length > 0) {
    const rows = members.map(function (m) {
      return [
        m.name || '',
        m.role || '',
        m.positive_actions || '',
        m.improvement_areas || '',
        m.next_expectation || '',
        m.data_sufficiency || ''
      ];
    });
    outSheet.getRange(3, 1, rows.length, STAFF_EVAL_HEADERS.length).setValues(rows);
    // data_sufficiency 色付け
    for (let i = 0; i < members.length; i++) {
      const ds = members[i].data_sufficiency;
      const bg = ds === 'high' ? '#d9ead3' : ds === 'mid' ? '#fff2cc' : '#f4cccc';
      outSheet.getRange(3 + i, 6).setBackground(bg);
    }
  }

  outSheet.setColumnWidth(1, 130); // 担当
  outSheet.setColumnWidth(2, 140); // 役割
  outSheet.setColumnWidth(3, 300); // 良かった
  outSheet.setColumnWidth(4, 300); // 改善余地
  outSheet.setColumnWidth(5, 240); // 次回期待
  outSheet.setColumnWidth(6, 100); // データ充足度
  outSheet.getRange(1, 1, outSheet.getMaxRows(), STAFF_EVAL_HEADERS.length).setWrap(true);

  const sheetUrl = PanelLinks_sheetUrl(zissiSs, outSheet);

  // missing_inputs を確認シートに
  const missing = parsed.missing_inputs || [];
  if (missing.length > 0) {
    const tagged = missing.map(function (m) {
      return { category: '[スタッフ評価/補完依頼] ' + (m.category || ''), content: m.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 6);
  }

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, 'スタッフ評価',
    'スタッフ評価 (' + members.length + ' 名)', sheetUrl);

  return {
    sheetUrl: sheetUrl,
    sheetName: STAFF_EVAL_SHEET_NAME,
    memberCount: members.length,
    missingInputCount: missing.length,
    usage: res.usage
  };
}

function _Phase6_loadTaskAssigneeSnippet(zissiSs) {
  const sheet = _Phase6_findSheetByKeyword(zissiSs, ['task', 'Task', 'タスク']);
  if (!sheet) return '';
  try {
    const lastRow = Math.min(sheet.getLastRow(), 500);
    const lastCol = Math.min(sheet.getLastColumn(), 15);
    if (lastRow < 2 || lastCol < 2) return '';
    const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    // 担当者ごとに完了/未完を集計
    const byAssignee = {};
    let assigneeCol = -1;
    let statusCol = -1;
    let itemCol = -1;
    // header row 推定: 1〜5 行目に「担当」「進捗」「項目」 等の列名を探す
    for (let r = 0; r < Math.min(8, data.length); r++) {
      for (let cc = 0; cc < lastCol; cc++) {
        const v = String(data[r][cc] || '');
        if ((v.indexOf('担当') >= 0 || v.indexOf('名前') >= 0 || v.indexOf('分担') >= 0) && assigneeCol < 0) assigneeCol = cc;
        if ((v.indexOf('進捗') >= 0 || v.indexOf('ステータス') >= 0 || v.indexOf('完了') >= 0) && statusCol < 0) statusCol = cc;
        if ((v.indexOf('項目') >= 0 || v.indexOf('タスク') >= 0) && itemCol < 0) itemCol = cc;
      }
    }
    if (assigneeCol < 0) return '(担当列を特定できず)';

    for (let r = 0; r < data.length; r++) {
      const a = String(data[r][assigneeCol] || '').trim();
      if (!a || a === '名前' || a === '担当' || a === '分担') continue;
      const status = statusCol >= 0 ? String(data[r][statusCol] || '').trim() : '';
      const item = itemCol >= 0 ? String(data[r][itemCol] || '').trim() : '';
      if (!byAssignee[a]) byAssignee[a] = { total: 0, done: 0, undone: 0, samples: [] };
      byAssignee[a].total++;
      const isDone = status === '済' || status === '完了' || status === 'done';
      const isUndone = status === '未着手' || status === '進行中';
      if (isDone) byAssignee[a].done++;
      if (isUndone) byAssignee[a].undone++;
      if (byAssignee[a].samples.length < 3 && item) byAssignee[a].samples.push(item);
    }

    const lines = [];
    Object.keys(byAssignee).forEach(function (a) {
      const s = byAssignee[a];
      lines.push('- ' + a + ': 計 ' + s.total + ' 件 (完了 ' + s.done + ' / 未/進行 ' + s.undone + ')。代表タスク: ' + s.samples.join(' / '));
    });
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}
