/**
 * 修正指示書（汎用）— クライアント/社内レビューの feedback を構造化して、
 *   各担当に渡せる「修正指示書 Doc」+「修正履歴シート」を生成する。
 *
 * 対応タイプ:
 *   - estimate   : 見積修正指示書    (Phase 2 内)
 *   - design     : パース/デザイン修正指示書 (Phase 2 内)
 *   - final_check: 最終チェック修正指示書 (Phase 4 内)
 *
 * 入力:
 *   - caseId
 *   - feedbackText: 修正要望の生テキスト (メール本文 / MTG 議事録 / レビュー結果 等)
 *   - typeKey: 上記のいずれか
 *
 * 出力:
 *   - Google Doc (修正指示書本文)
 *   - 「Claude_修正履歴」シート (履歴1行追加: 日時/タイプ/feedback原文/抽出件数/Doc URL)
 *   - 確認シートに未確定項目積み上げ
 */

const _REVISION_CONFIG = {
  estimate: {
    displayName: '見積',
    docSuffix: '見積修正指示書',
    recipients: '営業 / 制作ディレクター',
    artifactLabel: '見積修正指示書',
    contextHint: '見積金額・項目数量・単価・支払い条件・税抜税込・支払いタイミングに関する修正',
    phase: 2,
    manualQueries: ['見積', '見積修正', '修正指示']
  },
  design: {
    displayName: 'パース/デザイン',
    docSuffix: 'パース修正指示書',
    recipients: 'デザイナー',
    artifactLabel: 'パース修正指示書',
    contextHint: 'パース絵・レイアウト・色・素材・ロゴ位置・グラフィック差替・サイズ修正等のデザイン関連修正',
    phase: 2,
    manualQueries: ['パース修正', 'デザイン修正', 'グラフィック修正']
  },
  final_check: {
    displayName: '最終チェック',
    docSuffix: '最終チェック修正指示書',
    recipients: '全関係者 (デザイナー / 施工 / 運営 / 営業)',
    artifactLabel: '最終チェック修正指示書',
    contextHint: '最終チェック (本番直前/設営直後) で見つかった全領域の修正事項。優先度判定が重要',
    phase: 4,
    manualQueries: ['最終チェック', '本番直前', '修正指示']
  }
};

function Phase_RevisionBrief_generate(caseId, typeKey, feedbackText) {
  if (!feedbackText || !String(feedbackText).trim()) {
    throw new Error('feedback テキストが空です。');
  }
  const cfg = _REVISION_CONFIG[typeKey];
  if (!cfg) throw new Error('未知の typeKey: ' + typeKey);

  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) throw new Error('実施計画書が見つかりません。');

  const manualPages = ManualLoader_findPages(cfg.manualQueries).slice(0, 5);
  const cachedContext = [
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ];

  const userPrompt = [
    '以下の展示会ブース案件で、クライアント or 社内レビューから出た修正 feedback を構造化し、',
    '「' + cfg.displayName + '修正指示書」として ' + cfg.recipients + ' に渡せる形にまとめてください。',
    '',
    '## 案件情報',
    '- 案件 ID: ' + c.caseId,
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '',
    '## このタイプの想定範囲',
    cfg.contextHint,
    '',
    '## 受領した feedback (原文)',
    String(feedbackText).trim(),
    '',
    '## 出力形式（厳守・JSON 単体、説明文/```json``` ブロック禁止）',
    '{',
    '  "title": "<指示書のタイトル>",',
    '  "summary": "<全体サマリ 100 字以内>",',
    '  "revisions": [',
    '    {',
    '      "id": "<R-001 / R-002 等の通し番号>",',
    '      "priority": "high|mid|low",',
    '      "target": "<対象 (例: 受付カウンター / 壁面グラフィック A / 見積項目 XX)>",',
    '      "current": "<現状 (feedback に書かれた認識)>",',
    '      "request": "<具体的な修正内容>",',
    '      "rationale": "<理由 / クライアントの意図>",',
    '      "assignee_hint": "<担当ヒント (デザイナー / 施工 / 営業 等)>"',
    '    }',
    '  ],',
    '  "open_questions": [',
    '    "<clarification が必要な質問 (feedback だけでは判断できないこと)>"',
    '  ]',
    '}',
    '',
    '## 重要ルール',
    '- feedback に明示されていない範囲は revisions に書かない（推測しない）。',
    '- 曖昧な指示は revisions ではなく open_questions に積む。',
    '- priority は事故/納期/コスト影響度で判定。明示が無ければ mid。',
    '- 修正内容は具体的に。「位置を直す」ではなく「カウンター位置を東壁から 200mm 中央寄せ」のように。',
    '- ハルシネーション禁止。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 5000
  });

  const parsed = _Phase1_parseJson(res.text);
  const title = parsed.title || (c.caseName + ' ' + cfg.displayName + '修正指示書');
  const revisions = parsed.revisions || [];

  // Doc 生成
  const folderId = c.projectFolderId || c.folderId;
  const ts = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  const docName = c.caseId + '_' + c.caseName + '_' + cfg.docSuffix + '_' + ts;
  const doc = DocumentApp.create(docName);
  const body = doc.getBody();
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('案件 ID: ' + c.caseId + ' / 宛先: ' + cfg.recipients +
    ' / 生成日: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')).setItalic(true);
  body.appendHorizontalRule();

  if (parsed.summary) {
    body.appendParagraph('全体サマリ').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph(parsed.summary);
  }

  if (revisions.length > 0) {
    body.appendParagraph('修正事項').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const rank = { high: 0, mid: 1, low: 2 };
    revisions.sort(function (a, b) { return (rank[a.priority] || 9) - (rank[b.priority] || 9); });
    revisions.forEach(function (r) {
      body.appendParagraph('● [' + (r.priority || '') + '] ' + (r.id || '') + ' ' + (r.target || ''))
        .setHeading(DocumentApp.ParagraphHeading.HEADING3);
      if (r.current)  body.appendParagraph('現状: ' + r.current);
      if (r.request)  body.appendParagraph('修正内容: ' + r.request);
      if (r.rationale) body.appendParagraph('理由: ' + r.rationale);
      if (r.assignee_hint) body.appendParagraph('担当ヒント: ' + r.assignee_hint);
    });
  }

  if (parsed.open_questions && parsed.open_questions.length > 0) {
    body.appendParagraph('未確定 / 追加確認が必要な事項').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    parsed.open_questions.forEach(function (q) {
      body.appendListItem(q).setGlyphType(DocumentApp.GlyphType.BULLET);
    });
  }

  body.appendHorizontalRule();
  body.appendParagraph('--- 受領した feedback (原文) ---').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(String(feedbackText).trim()).setItalic(true);

  doc.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }
  const docUrl = DocumentApp.openById(doc.getId()).getUrl();

  // 修正履歴シート (履歴を 1 行追記)
  const HIST = 'Claude_修正履歴';
  let histSheet = zissiSs.getSheetByName(HIST);
  if (!histSheet) {
    try { histSheet = zissiSs.insertSheet(HIST); }
    catch (e) { histSheet = zissiSs.getSheetByName(HIST); }
    if (histSheet) {
      histSheet.getRange(1, 1, 1, 6).setValues([['日時', 'タイプ', 'タイトル', '指摘件数', 'feedback 原文', 'Doc URL']])
        .setFontWeight('bold').setBackground('#fce5cd');
      histSheet.setFrozenRows(1);
      histSheet.setColumnWidth(1, 130);
      histSheet.setColumnWidth(2, 100);
      histSheet.setColumnWidth(3, 240);
      histSheet.setColumnWidth(4, 70);
      histSheet.setColumnWidth(5, 360);
      histSheet.setColumnWidth(6, 360);
    }
  }
  if (histSheet) {
    histSheet.appendRow([
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'),
      cfg.displayName,
      title,
      revisions.length,
      String(feedbackText).trim(),
      docUrl
    ]);
  }

  // open_questions を確認シートに
  if (parsed.open_questions && parsed.open_questions.length > 0) {
    const tagged = parsed.open_questions.map(function (q) {
      return { category: '[' + cfg.displayName + '修正指示書/未確定] ', content: q };
    });
    ConfirmationSheet_appendItems(caseId, tagged, cfg.phase);
  }

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, cfg.artifactLabel, title, docUrl);

  return {
    typeKey: typeKey,
    typeName: cfg.displayName,
    docUrl: docUrl,
    docName: docName,
    title: title,
    revisionCount: revisions.length,
    openQuestionCount: (parsed.open_questions || []).length,
    summary: parsed.summary || '',
    usage: res.usage
  };
}

// 3 つの thin wrapper (whitelist 登録の都合)
function Phase2_EstimateRevision_generate(caseId, feedbackText) {
  return Phase_RevisionBrief_generate(caseId, 'estimate', feedbackText);
}
function Phase2_DesignRevision_generate(caseId, feedbackText) {
  return Phase_RevisionBrief_generate(caseId, 'design', feedbackText);
}
function Phase4_FinalCheckRevision_generate(caseId, feedbackText) {
  return Phase_RevisionBrief_generate(caseId, 'final_check', feedbackText);
}
