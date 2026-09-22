/**
 * Phase6: 案件終了後の報告書 を生成。
 *
 * 目的:
 *   案件が完了した後、社内共有 + クライアント送付の元ネタとなる報告書を Claude にまとめさせる。
 *   実施計画書内の「報告」シート / 確認シート / Claude 生成物の URL を context として渡し、
 *   ハルシネーション禁止ルールに従って既知情報のみで構成させる。
 *
 * 出力:
 *   - Google Doc (case フォルダ配下)
 *   - 「Claude_報告書」シート(同 zissi 内、ナビゲーション用に URL を貼る)
 *   - 確認シートへの未確認項目 (KPI 数値未記入 等) の積み上げ
 */

const POST_REPORT_DOC_SUFFIX = '報告書';
const POST_REPORT_NAV_SHEET = 'Claude_報告書';

function Phase6_PostReport_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // 実施計画書
  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) throw new Error('実施計画書が見つかりません。');

  // 実施計画書内の主要シートから snippet 抽出
  const zissiSnippets = _Phase6_extractZissiSnippets(zissiSs);

  // 確認シートの内容
  const confirmationLog = _Phase6_loadConfirmations(caseId);

  // 既に生成した Claude 成果物の URL リスト (Claude生成物 シート参照)
  const artifactLog = _Phase6_loadArtifactList(zissiSs);

  // マニュアル抜粋 (報告書テンプレートが定義されていれば参照)
  const manualPages = ManualLoader_findPages([
    '報告書', '実績', '振り返り', 'デブリーフィング', '案件終了'
  ]).slice(0, 10);

  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の展示会ブース案件について、終了後の報告書を作成してください。',
    '',
    '## 案件情報',
    '- 案件 ID: ' + c.caseId,
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未記入'),
    '',
    '## 実施計画書から抽出した主要情報',
    zissiSnippets || '(該当データなし)',
    '',
    '## 確認事項ログ',
    confirmationLog || '(確認シート空)',
    '',
    '## 生成済み Claude 成果物',
    artifactLog || '(なし)',
    '',
    '## 出力形式（厳守・JSON 単体、説明文/```json``` ブロック禁止）',
    '{',
    '  "title": "<報告書のタイトル>",',
    '  "sections": [',
    '    {"heading": "案件概要", "body": "<本文>"},',
    '    {"heading": "実施内容のサマリ", "body": "<本文>"},',
    '    {"heading": "成功要因 / 良かった点", "body": "<本文>"},',
    '    {"heading": "課題・改善点", "body": "<本文>"},',
    '    {"heading": "クライアントからのフィードバック", "body": "<本文。データに無い場合は「ヒアリング待ち」と書く>"},',
    '    {"heading": "数値実績", "body": "<予算/原価/工数 等。データに無い数値は「未記入」と書く>"},',
    '    {"heading": "次回への申し送り", "body": "<本文>"}',
    '  ],',
    '  "missing_inputs": [',
    '    {"category": "<KPI / フィードバック 等のカテゴリ>", "content": "<確認したい/補ってほしい内容>"}',
    '  ]',
    '}',
    '',
    '## 重要ルール',
    '- 上記コンテキストに **明示的に書かれている事実のみ** を本文に記載すること。',
    '- 数値・社名・人名・成果 等で確証がないものは「未記入」「ヒアリング待ち」「要確認」と書き、絶対に推測で埋めない。',
    '- ハルシネーションは禁止。空欄や未確定情報は missing_inputs に列挙する。',
    '- 文体は社内共有の体裁 (です/ます調)。',
    '- 各 body は箇条書きと段落を適切に混在させ、500 字以内を目安に。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 6000
  });

  const parsed = _Phase1_parseJson(res.text);
  const title = parsed.title || (c.caseName + ' 報告書');
  const sections = parsed.sections || [];

  // Google Doc 生成
  const folderId = Case_resolveProjectRoot(c);
  const docName = c.caseId + '_' + c.caseName + '_' + POST_REPORT_DOC_SUFFIX + '_初版';
  const doc = DocumentApp.create(docName);
  const body = doc.getBody();
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('案件 ID: ' + c.caseId + ' / 生成日: ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'))
    .setItalic(true);
  body.appendHorizontalRule();
  sections.forEach(function (sec) {
    body.appendParagraph(sec.heading || '').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph(sec.body || '');
  });
  doc.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }
  const docUrl = DocumentApp.openById(doc.getId()).getUrl();

  // ナビ用シート (zissi 内に URL を貼っておくと bound から開きやすい)
  let navSheet = zissiSs.getSheetByName(POST_REPORT_NAV_SHEET);
  if (!navSheet) {
    try { navSheet = zissiSs.insertSheet(POST_REPORT_NAV_SHEET); }
    catch (e) { navSheet = zissiSs.getSheetByName(POST_REPORT_NAV_SHEET); }
  } else {
    navSheet.clear();
  }
  navSheet.getRange(1, 1).setValue('報告書 Doc URL').setFontWeight('bold');
  navSheet.getRange(1, 2).setValue(docUrl);
  navSheet.getRange(2, 1).setValue('生成日時').setFontWeight('bold');
  navSheet.getRange(2, 2).setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  navSheet.getRange(3, 1).setValue('タイトル').setFontWeight('bold');
  navSheet.getRange(3, 2).setValue(title);
  navSheet.setColumnWidth(1, 140);
  navSheet.setColumnWidth(2, 500);

  // missing_inputs を確認シートに積む
  const missing = parsed.missing_inputs || [];
  if (missing.length > 0) {
    const tagged = missing.map(function (m) {
      return { category: '[報告書/補完依頼] ' + (m.category || ''), content: m.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 6);
  }

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '報告書', title, docUrl);

  return {
    docUrl: docUrl,
    docName: docName,
    title: title,
    sectionCount: sections.length,
    missingInputCount: missing.length,
    manualPagesUsed: manualPages.length,
    usage: res.usage
  };
}

function _Phase6_extractZissiSnippets(zissiSs) {
  const lines = [];
  // 「報告」シートがあれば上位 30 行
  const reportSheet = _Phase6_findSheetByKeyword(zissiSs, ['報告', 'デブリ', 'デブリーフ']);
  if (reportSheet) {
    const lastRow = Math.min(reportSheet.getLastRow(), 30);
    const lastCol = Math.min(reportSheet.getLastColumn(), 8);
    if (lastRow > 0 && lastCol > 0) {
      const data = reportSheet.getRange(1, 1, lastRow, lastCol).getValues();
      lines.push('--- 「' + reportSheet.getName() + '」シート抜粋 ---');
      data.forEach(function (row) {
        const nonEmpty = row.filter(function (v) { return String(v || '').trim(); });
        if (nonEmpty.length > 0) lines.push(nonEmpty.join(' | '));
      });
    }
  }
  // 「task」シートで残タスク / 完了率の手がかり
  const taskSheet = _Phase6_findSheetByKeyword(zissiSs, ['task', 'Task', 'タスク']);
  if (taskSheet) {
    try {
      const summary = taskSheet.getRange(1, 1, 5, Math.min(taskSheet.getLastColumn(), 10)).getValues();
      lines.push('--- 「' + taskSheet.getName() + '」シート上部 ---');
      summary.forEach(function (row) {
        const nonEmpty = row.filter(function (v) { return String(v || '').trim(); });
        if (nonEmpty.length > 0) lines.push(nonEmpty.join(' | '));
      });
    } catch (e) {}
  }
  return lines.join('\n');
}

function _Phase6_findSheetByKeyword(ss, keywords) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    for (let j = 0; j < keywords.length; j++) {
      if (name.indexOf(keywords[j]) >= 0) return sheets[i];
    }
  }
  return null;
}

function _Phase6_loadConfirmations(caseId) {
  try {
    const c = CaseList_getById(caseId);
    if (!c || !c.zissiId) return '';
    const ss = SpreadsheetApp.openById(c.zissiId);
    const sheet = ss.getSheetByName('確認') || _Phase6_findSheetByKeyword(ss, ['確認事項']);
    if (!sheet) return '';
    const lastRow = Math.min(sheet.getLastRow(), 100);
    if (lastRow < 2) return '';
    const data = sheet.getRange(2, 1, lastRow - 1, Math.min(sheet.getLastColumn(), 6)).getValues();
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

function _Phase6_loadArtifactList(zissiSs) {
  try {
    const sheet = zissiSs.getSheetByName('Claude生成物');
    if (!sheet) return '';
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return '';
    const data = sheet.getRange(2, 1, lastRow - 1, Math.min(sheet.getLastColumn(), 6)).getValues();
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
