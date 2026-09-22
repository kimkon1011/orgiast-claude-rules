/**
 * Phase4: 本番当日案内 初版 を生成。
 *
 * 対象パーティ:
 *  - 'client'       : クライアント（出展企業）
 *  - 'construction' : 施工会社
 *  - 'ops'          : 運営スタッフ
 *  - 'driver'       : ドライバー
 *
 * 各パーティに合わせた「当日の集合時刻 / 場所 / 持ち物 / 連絡先 / 想定スケジュール / 注意事項」
 * を含むメール本文を Gmail Draft + Doc で生成。
 */

const _DAY_BRIEF_CONFIG = {
  client: {
    displayName: 'クライアント',
    docSuffix: '当日案内_クライアント',
    subjectFallback: '展示会本番 当日のご案内',
    manualQueries: ['本番当日', '当日進行', 'クライアント当日', '本番案内', '受付', '会場入り'],
    contextHint: 'クライアント（出展企業ご担当者様）への本番当日案内。集合時刻 / 場所 / 受付ブース位置 / 担当連絡先 / 当日の流れ（オープニング → セッション → 終了 → 撤去開始 等）を上品で丁寧な調子で。'
  },
  construction: {
    displayName: '施工会社',
    docSuffix: '当日案内_施工会社',
    subjectFallback: '展示会本番 当日案内（施工 / 設営撤去）',
    manualQueries: ['設営', '撤去', '搬入', '搬出', '施工会社', '当日'],
    contextHint: '施工会社への本番案内。設営開始時刻・搬入導線・養生指示・設営完了マイルストーン・撤去開始時刻・搬出ルート・連絡先を実務向け簡潔な調子で。'
  },
  ops: {
    displayName: '運営スタッフ',
    docSuffix: '当日案内_運営スタッフ',
    subjectFallback: '展示会本番 当日のご案内（運営スタッフ）',
    manualQueries: ['運営スタッフ', '当日進行', 'スタッフ', '受付', '当日タスク'],
    contextHint: '当日運営スタッフ向け案内。集合時刻 / 場所 / 服装 / 持参物 / 担当ポジション / シフト / 緊急連絡先 / よくある質問対応を実務的に。'
  },
  driver: {
    displayName: 'ドライバー',
    docSuffix: '当日案内_ドライバー',
    subjectFallback: '展示会本番 搬入出当日案内',
    manualQueries: ['ドライバー', '搬入出', '車両', 'トラック', '駐車'],
    contextHint: '搬入出ドライバーへの案内。集合時刻 / 集合場所（倉庫等）/ 車両サイズ / 会場までの推奨ルート / 搬入入口・搬出入口 / 駐車場 / 連絡先 / 積荷リストへの参照を実務的に。'
  }
};

function Phase4_DayBrief_generate(caseId, partyType) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const cfg = _DAY_BRIEF_CONFIG[partyType];
  if (!cfg) throw new Error('不明な partyType: ' + partyType + ' (有効値: client / construction / ops / driver)');

  const manualPages = ManualLoader_findPages(cfg.manualQueries).slice(0, 12);
  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の案件について、本番当日に ' + cfg.displayName + ' に送るメール本文（初版）を作成してください。',
    '',
    '## メールの目的',
    cfg.contextHint,
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
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
    '- 受信者の固有名・連絡先（メアド・電話番号）は案件情報に無いので本文に書かず confirmations へ。',
    '- 集合時刻・場所・担当者名等の数値/固有値で未確定なものは confirmations へ。',
    '- 本文には「以下未確定:」「○○未確定」と仮置きで書かず、確定情報の範囲で自然な文を生成し、不足は confirmations に分離する。',
    '- 関連マニュアルが定める当日進行・チェックリスト・緊急時連絡フローは本文に必ず反映。'
  ].join('\n');

  const manualPdfs = CaseManualPdf_find(c, { includeSubmission: false });
  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: manualPdfs,
    maxTokens: 3500
  });

  const parsed = _Phase1_parseJson(res.text);

  const draft = GmailApp.createDraft(
    '',
    Mail_externalSubject(c.caseId, c.caseName, parsed.subject || cfg.subjectFallback, cfg.displayName + '・当日案内'),
    parsed.body || ''
  );

  const folderId = Case_resolveProjectRoot(c);
  const docName = c.caseId + '_' + c.caseName + '_' + cfg.docSuffix + '_初版';
  const doc = DocumentApp.create(docName);
  doc.getBody().setText('件名: ' + (parsed.subject || '') + '\n\n' + (parsed.body || ''));
  doc.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }

  if (parsed.confirmations && parsed.confirmations.length > 0) {
    const tagged = parsed.confirmations.map(function (x) {
      return { category: '[当日案内/' + cfg.displayName + '] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 4);
  }
  CaseList_touchUpdatedAt(caseId);

  const docUrl = DocumentApp.openById(doc.getId()).getUrl();
  MasterWriteBack_recordArtifact(caseId, cfg.displayName + '当日案内', parsed.subject || '', docUrl);

  return {
    partyType: partyType,
    partyName: cfg.displayName,
    subject: parsed.subject,
    draftId: draft.getId(),
    docUrl: docUrl,
    confirmationCount: (parsed.confirmations || []).length,
    manualPagesUsed: manualPages.length,
    manualPdfs: manualPdfs.map(function (p) { return p.label; }),
    usage: res.usage
  };
}
