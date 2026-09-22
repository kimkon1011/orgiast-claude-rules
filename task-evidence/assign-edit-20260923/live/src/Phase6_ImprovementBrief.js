/**
 * Phase6: 次回向け 改善指示書 を生成。
 *
 * 目的:
 *   今回案件の振り返り（報告書・確認シート・タスク進捗）から、次回類似案件で
 *   制作チーム / 営業 / 運営 / 倉庫 などに渡す「次はこう変えよう」の指示書を作る。
 *   ハルシネーション禁止 — データ無いところは「ヒアリング要」と書く。
 *
 * 出力:
 *   Doc (改善指示書) + 「Claude_改善指示書」ナビシート + 確認シート積み上げ
 */

const IMPROVE_BRIEF_DOC_SUFFIX = '改善指示書';
const IMPROVE_BRIEF_NAV_SHEET = 'Claude_改善指示書';

function Phase6_ImprovementBrief_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) throw new Error('実施計画書が見つかりません。');

  // 報告書 Doc が既に作成されていれば、その内容も context に乗せる
  const reportDocText = _Phase6_loadReportDocText(zissiSs);
  const zissiSnippets = _Phase6_extractZissiSnippets(zissiSs);
  const confirmationLog = _Phase6_loadConfirmations(caseId);

  const manualPages = ManualLoader_findPages([
    '改善', '振り返り', '次回', '申し送り', 'KPT', 'デブリ'
  ]).slice(0, 8);

  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の案件を振り返り、次回類似案件の各担当 (営業 / 制作ディレクター / 施工 / 運営 / 倉庫 / 経営) に対する',
    '「改善指示書」を作成してください。',
    '',
    '## 案件情報',
    '- 案件 ID: ' + c.caseId,
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '',
    '## 報告書 Doc 抜粋',
    reportDocText || '(報告書 Doc 未作成 — 先に Phase6 報告書を生成することを推奨)',
    '',
    '## 実施計画書 抜粋',
    zissiSnippets || '(該当データなし)',
    '',
    '## 確認事項ログ',
    confirmationLog || '(空)',
    '',
    '## 出力形式（厳守・JSON 単体、説明文/```json``` ブロック禁止）',
    '{',
    '  "title": "<改善指示書のタイトル>",',
    '  "improvements": [',
    '    {',
    '      "audience": "<営業 / 制作ディレクター / 施工 / 運営 / 倉庫 / 経営 のいずれか>",',
    '      "priority": "high|mid|low",',
    '      "topic": "<改善テーマ>",',
    '      "current": "<今回起きた事象・現状>",',
    '      "next_action": "<次回どうするか具体的に>",',
    '      "rationale": "<なぜそうするか>"',
    '    }',
    '  ],',
    '  "missing_inputs": [',
    '    {"category": "<不足情報のカテゴリ>", "content": "<何を確認すべきか>"}',
    '  ]',
    '}',
    '',
    '## 重要ルール',
    '- 必ず audience 別に分けて記載 (担当ごとに何をするか明確に)。',
    '- データが無い場合の推測指示は出さない。「ヒアリング要」「再現性のあるデータがそろえば判断可能」等と書く。',
    '- priority は事故防止/コスト/利益への影響度で判定。曖昧なら mid。',
    '- 件数の下限なし。本当に改善点が見当たらない場合は missing_inputs にデータ不足を列挙。',
    '- ハルシネーション禁止。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 6000
  });

  const parsed = _Phase1_parseJson(res.text);
  const title = parsed.title || (c.caseName + ' 改善指示書');
  const improvements = parsed.improvements || [];

  // Doc 生成
  const folderId = c.projectFolderId || c.folderId;
  const docName = c.caseId + '_' + c.caseName + '_' + IMPROVE_BRIEF_DOC_SUFFIX + '_初版';
  const doc = DocumentApp.create(docName);
  const body = doc.getBody();
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('案件 ID: ' + c.caseId + ' / 生成日: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'))
    .setItalic(true);
  body.appendHorizontalRule();

  // audience 別にグルーピング
  const grouped = {};
  improvements.forEach(function (it) {
    const a = it.audience || 'その他';
    if (!grouped[a]) grouped[a] = [];
    grouped[a].push(it);
  });
  const audienceOrder = ['営業', '制作ディレクター', '施工', '運営', '倉庫', '経営', 'その他'];
  audienceOrder.forEach(function (aud) {
    const items = grouped[aud];
    if (!items || items.length === 0) return;
    body.appendParagraph('■ ' + aud).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    // priority 順
    const rank = { high: 0, mid: 1, low: 2 };
    items.sort(function (a, b) { return (rank[a.priority] || 9) - (rank[b.priority] || 9); });
    items.forEach(function (it) {
      body.appendParagraph('● [' + (it.priority || '') + '] ' + (it.topic || ''))
        .setHeading(DocumentApp.ParagraphHeading.HEADING3);
      body.appendParagraph('現状: ' + (it.current || ''));
      body.appendParagraph('次回アクション: ' + (it.next_action || ''));
      if (it.rationale) body.appendParagraph('根拠: ' + it.rationale);
    });
  });
  // audience 別の漏れ (audienceOrder に無いカテゴリ)
  Object.keys(grouped).forEach(function (aud) {
    if (audienceOrder.indexOf(aud) >= 0) return;
    body.appendParagraph('■ ' + aud).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    grouped[aud].forEach(function (it) {
      body.appendParagraph('● [' + (it.priority || '') + '] ' + (it.topic || ''))
        .setHeading(DocumentApp.ParagraphHeading.HEADING3);
      body.appendParagraph('現状: ' + (it.current || ''));
      body.appendParagraph('次回アクション: ' + (it.next_action || ''));
      if (it.rationale) body.appendParagraph('根拠: ' + it.rationale);
    });
  });

  doc.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }
  const docUrl = DocumentApp.openById(doc.getId()).getUrl();

  // ナビ用シート
  let navSheet = zissiSs.getSheetByName(IMPROVE_BRIEF_NAV_SHEET);
  if (!navSheet) {
    try { navSheet = zissiSs.insertSheet(IMPROVE_BRIEF_NAV_SHEET); }
    catch (e) { navSheet = zissiSs.getSheetByName(IMPROVE_BRIEF_NAV_SHEET); }
  } else {
    navSheet.clear();
  }
  navSheet.getRange(1, 1).setValue('改善指示書 Doc URL').setFontWeight('bold');
  navSheet.getRange(1, 2).setValue(docUrl);
  navSheet.getRange(2, 1).setValue('指摘件数').setFontWeight('bold');
  navSheet.getRange(2, 2).setValue(improvements.length);
  navSheet.getRange(3, 1).setValue('生成日時').setFontWeight('bold');
  navSheet.getRange(3, 2).setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  navSheet.setColumnWidth(1, 140);
  navSheet.setColumnWidth(2, 500);

  // missing_inputs を確認シートに積む
  const missing = parsed.missing_inputs || [];
  if (missing.length > 0) {
    const tagged = missing.map(function (m) {
      return { category: '[改善指示書/補完依頼] ' + (m.category || ''), content: m.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 6);
  }

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '改善指示書', title, docUrl);

  return {
    docUrl: docUrl,
    docName: docName,
    title: title,
    improvementCount: improvements.length,
    audiences: Object.keys(grouped),
    missingInputCount: missing.length,
    manualPagesUsed: manualPages.length,
    usage: res.usage
  };
}

function _Phase6_loadReportDocText(zissiSs) {
  // 「Claude_報告書」ナビシートに Doc URL があれば、その Doc のテキストを返す
  try {
    const navSheet = zissiSs.getSheetByName(POST_REPORT_NAV_SHEET);
    if (!navSheet) return '';
    const url = String(navSheet.getRange(1, 2).getValue() || '').trim();
    const m = url.match(/\/document\/d\/([A-Za-z0-9_-]+)/);
    if (!m) return '';
    const doc = DocumentApp.openById(m[1]);
    const text = doc.getBody().getText();
    return text.length > 8000 ? text.slice(0, 8000) + '\n...(以下省略)' : text;
  } catch (e) {
    return '';
  }
}
