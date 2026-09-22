/**
 * Phase2: アサインセット打診文 初版 を生成。
 *
 * 対象パーティ:
 *  - 'construction' : 施工会社（ブース造作・設営撤去の外注先）
 *  - 'ops'          : 運営スタッフ（当日進行サポートスタッフ）
 *  - 'driver'       : ドライバー（搬入出車両手配）
 *
 * 流れ:
 *  1) 案件情報を取得
 *  2) パーティ別の関連マニュアル抜粋を取得
 *  3) Claude で打診文 + 確認事項 JSON を生成
 *  4) Gmail Draft（受信者空欄）+ Doc を案件 Drive フォルダに保存
 *  5) 確認事項を確認シートに積む
 */

const _PARTY_CONFIG = {
  construction: {
    displayName: '施工会社',
    docSuffix: '施工会社打診文',
    subjectFallback: '施工ご協力のお願い（' + '初版' + '）',
    manualQueries: ['施工会社', '設営撤去', '搬入出計画', '展示会ブース 施工'],
    contextHint: '施工会社（造作・設営・撤去の外注先）への打診メール。設営日・搬出日・ブースサイズ・必要工程を伝えて見積依頼まで。'
  },
  ops: {
    displayName: '運営スタッフ',
    docSuffix: '運営スタッフ打診文',
    subjectFallback: '当日運営スタッフのご協力依頼（初版）',
    manualQueries: ['運営スタッフ', '当日進行', 'スタッフ手配', 'シフト'],
    contextHint: '展示会本番当日の運営スタッフ（受付・案内・対応サポート）への打診メール。当日時間帯・場所・必要人数・想定業務内容を伝えて稼働可否確認まで。'
  },
  driver: {
    displayName: 'ドライバー',
    docSuffix: 'ドライバー打診文',
    subjectFallback: '搬入出車両手配のご相談（初版）',
    manualQueries: ['ドライバー', '搬入出', '車両手配', '配送', 'トラック'],
    contextHint: 'ブース備品・造作物の搬入出ドライバーへの打診メール。搬入日時・搬出日時・会場住所・想定積載量・車両サイズを伝えて手配可否確認まで。'
  }
};

function Phase2_AssignBrief_generate(caseId, partyType) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const cfg = _PARTY_CONFIG[partyType];
  if (!cfg) {
    throw new Error('不明な partyType: ' + partyType + ' (有効値: construction / ops / driver)');
  }

  // 関連ページが多すぎるとプロンプトコストが膨れるので上位 15 件に絞る
  const manualPages = ManualLoader_findPages(cfg.manualQueries).slice(0, 15);

  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の案件について、' + cfg.displayName + 'への初版打診メール本文を作成してください。',
    '',
    '## メールの目的',
    cfg.contextHint,
    '',
    '## 案件情報',
    '- クライアント名: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '',
    '## 出力形式（厳守）',
    '次の JSON だけを返してください。前後の説明文や ```json``` ブロックは不要。',
    '{',
    '  "subject": "<メール件名>",',
    '  "body": "<メール本文・改行は \\n>",',
    '  "confirmations": [',
    '    {"category": "<確認カテゴリ>", "content": "<確認したい内容>"}',
    '  ]',
    '}',
    '',
    '注意:',
    '- 受信者の固有名（会社名・担当者名）は案件情報に無いので本文に書かず confirmations へ。',
    '- 価格・人数・台数等の数値は案件情報に確定値が無いなら本文では「ご相談」「未確定」と書き、確定すべき項目は confirmations へ。',
    '- 関連マニュアルが示す依頼文書式・必要記載事項は本文に反映すること。'
  ].join('\n');

  const manualPdfs = CaseManualPdf_find(c);
  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: manualPdfs,
    maxTokens: 3000
  });

  const parsed = _Phase1_parseJson(res.text);

  // Gmail Draft 作成（受信者は空 — 実際の発注先 user 側で埋める）
  const draft = GmailApp.createDraft(
    '',
    Mail_externalSubject(c.caseId, c.caseName, parsed.subject || cfg.subjectFallback, cfg.displayName),
    parsed.body || ''
  );

  // Drive フォルダにも Doc 保存
  const folderId = Case_resolveProjectRoot(c);
  const docName = c.caseId + '_' + c.caseName + '_' + cfg.docSuffix + '_初版';
  const doc = DocumentApp.create(docName);
  doc.getBody().setText('件名: ' + (parsed.subject || '') + '\n\n' + (parsed.body || ''));
  doc.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }

  // 確認事項を積む（Phase=2 で積む）
  if (parsed.confirmations && parsed.confirmations.length > 0) {
    const tagged = parsed.confirmations.map(function (x) {
      return { category: '[' + cfg.displayName + '] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  CaseList_touchUpdatedAt(caseId);

  const docUrl = DocumentApp.openById(doc.getId()).getUrl();
  MasterWriteBack_recordArtifact(caseId, cfg.displayName + '打診文', parsed.subject || '', docUrl);

  return {
    partyType: partyType,
    partyName: cfg.displayName,
    subject: parsed.subject,
    draftId: draft.getId(),
    docUrl: docUrl,
    confirmationCount: (parsed.confirmations || []).length,
    manualPagesUsed: manualPages.length,
    usage: res.usage
  };
}
