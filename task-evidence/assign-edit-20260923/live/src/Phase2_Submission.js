/**
 * Phase2: 提出書類 初版 を生成。
 *
 * 出展時に主催者へ提出する書類群を網羅した「Claude_提出書類チェックリスト」を生成。
 *
 * 想定対象書類:
 *  - 電気申請 / 出展者カード / 搬入車両申請 / 搬出車両申請
 *  - 養生申請 / 駐車場利用申請 / 危険物届 / 消防届 / 食品衛生届
 *  - 高所作業届 / 騒音届 / 図面提出（平面図・立面図） 等
 *
 * 案件の業態（飲食/医療/IT/学会等）と会場・開催規模から不要な届出は除外。
 *
 * 出力構造（zissi 内 新シート）:
 *   A 書類名  B 提出先  C 提出期限(目安)  D 必要記載事項  E 添付資料  F 担当(候補)  G ステータス  H 備考
 */

const SUBMISSION_PROPOSAL_SHEET_NAME = 'Claude_提出書類チェックリスト';
const SUBMISSION_HEADERS = ['書類名', '提出先', '提出期限(目安)', '必要記載事項', '添付資料', '担当(候補)', 'ステータス', '備考'];

function Phase2_Submission_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) {
    throw new Error('実施計画書が見つかりません。先に Phase1 ② 見積初版を生成するか、既存の実施計画を取り込んでください。');
  }

  const manualPages = ManualLoader_findPages([
    '提出書類', '電気申請', '搬入申請', '搬出申請', '出展者カード', '危険物届', '養生',
    '主催者提出', '消防', '食品衛生'
  ]).slice(0, 15);

  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の展示会ブース案件で、主催者・関係官庁に提出する書類の初版チェックリストを作成してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '',
    '## 出力形式（厳守・前後の説明文や ```json``` ブロック禁止）',
    '{',
    '  "documents": [',
    '    {"name": "電気申請書", "submitTo": "主催者事務局", "deadline": "開催 3週間前 (yyyy/MM/dd 目安)", "fields": "使用電力(W), 単相/三相, 100/200V, 使用機器一覧", "attachments": "回路図", "owner": "制作P", "note": ""}',
    '  ],',
    '  "confirmations": [',
    '    {"category": "<確認カテゴリ>", "content": "<確認したい内容>"}',
    '  ]',
    '}',
    '',
    '注意:',
    '- 一般展示会ブースで標準的に必要な書類を網羅。案件特有 (飲食/医療/学会/IT 等) で必要な届出があれば追加。',
    '- 提出期限 (deadline) は案件の開催開始日から逆算した目安 (例: 開催3週間前=yyyy/MM/dd)。',
    '- 主催者から正式な書式が支給されている案件は名称に「主催者支給書式」と添える。',
    '- 該当しない書類は出力しない (例: 飲食を扱わない案件で食品衛生届は不要)。',
    '- 不明な属性 (使用電力・車両台数・危険物有無等) は confirmations に列挙。'
  ].join('\n');

  const manualPdfs = CaseManualPdf_find(c, { includeSubmission: true });
  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: manualPdfs,
    maxTokens: 5000
  });

  const parsed = _Phase1_parseJson(res.text);
  const docs = parsed.documents || [];

  let proposalSheet = zissiSs.getSheetByName(SUBMISSION_PROPOSAL_SHEET_NAME);
  if (!proposalSheet) {
    proposalSheet = zissiSs.insertSheet(SUBMISSION_PROPOSAL_SHEET_NAME);
  } else {
    proposalSheet.clear();
  }
  proposalSheet.getRange(1, 1, 1, SUBMISSION_HEADERS.length).setValues([SUBMISSION_HEADERS])
    .setFontWeight('bold').setBackground('#cfe2f3');
  proposalSheet.setFrozenRows(1);
  if (docs.length > 0) {
    const rows = docs.map(function (d) {
      return [
        d.name || '',
        d.submitTo || '',
        d.deadline || '',
        d.fields || '',
        d.attachments || '',
        d.owner || '',
        '未着手',
        d.note || ''
      ];
    });
    proposalSheet.getRange(2, 1, rows.length, SUBMISSION_HEADERS.length).setValues(rows);
  }
  proposalSheet.setColumnWidth(1, 200); // 書類名
  proposalSheet.setColumnWidth(2, 160); // 提出先
  proposalSheet.setColumnWidth(3, 160); // 期限
  proposalSheet.setColumnWidth(4, 320); // 必要記載事項
  proposalSheet.setColumnWidth(5, 200); // 添付資料
  proposalSheet.setColumnWidth(8, 200); // 備考

  const proposalUrl = PanelLinks_sheetUrl(zissiSs, proposalSheet);

  if (parsed.confirmations && parsed.confirmations.length > 0) {
    const tagged = parsed.confirmations.map(function (x) {
      return { category: '[提出書類] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  let ledger;
  try {
    ledger = TaskLedger_upsert(caseId, docs.map(function (d) {
      return { source: '提出書類', taskName: String('提出: ' + (d.name || '') + ' → ' + (d.submitTo || '提出先不明')).slice(0, 80), detail: String('記載項目: ' + (d.fields || '') + ' / 添付: ' + (d.attachments || '') + (d.note ? ' / ' + d.note : '')).slice(0, 500), evidence: '提出書類チェックリスト', due: d.deadline || '', owner: 'オージャスト', aiFeature: '', sourceStatus: 'open' };
    }));
  } catch (e) { console.warn('Phase2_Submission ledger: ' + e); ledger = { error: String(e) }; }
  CaseList_touchUpdatedAt(caseId);

  MasterWriteBack_recordArtifact(caseId, '提出書類チェックリスト',
    '提出書類 初版 (' + docs.length + ' 件)', proposalUrl);

  return {
    zissiSheetUrl: zissiSs.getUrl(),
    proposalSheetUrl: proposalUrl,
    proposalSheetName: SUBMISSION_PROPOSAL_SHEET_NAME,
    documentCount: docs.length,
    confirmationCount: (parsed.confirmations || []).length,
    manualPagesUsed: manualPages.length,
    exhibitionManualPdfs: manualPdfs.map(function (p) { return p.label; }),
    usage: res.usage,
    ledger: ledger
  };
}
