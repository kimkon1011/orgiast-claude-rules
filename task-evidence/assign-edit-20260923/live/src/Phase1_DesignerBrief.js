/**
 * Phase1: デザイナー依頼文章 初版 を生成。
 *
 * 流れ:
 *  1) 案件情報を取得
 *  2) 関連マニュアル（提案書の作り方/パース図作成メンバー）を取得
 *  3) Claude で依頼文章 + 確認事項JSON を生成
 *  4) Gmail Draft（自分宛）として作成、本文を案件 Drive フォルダにも Doc 保存
 *  5) 確認事項を確認シートに積む
 */

function Phase1_DesignerBrief_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  const manualPages = ManualLoader_findPages([
    '展示会ブースの提案書の作り方',
    'パース図作成メンバー',
    '/11:制作部/展示会ブース関連マニュアル(親ページ)/展示会ブースの提案書の作り方'
  ]);

  const cachedContext = [
    Case_loadClientContext(c),
    '【関連マニュアル抜粋】',
    ...manualPages.map(p => '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body)
  ].filter(Boolean);

  const userPrompt = [
    '以下の案件について、社内デザイナーにパース図作成を依頼するメール本文を作成してください。',
    '',
    '## 案件情報',
    '- クライアント名: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ（小間の実寸）: ' + (c.boothSize || '未確定'),
    '- デザイン有効範囲（小間実寸から四方100mm内側）: ' + (_Phase1_insetBoothSize(c.boothSize, _PHASE1_BOOTH_INSET_MM) || '要算出（小間実寸から四方100mmずつ内側）'),
    '',
    '## 本文に必ず入れる指示',
    '- パース図は「小間（コマ）の実寸から四方それぞれ' + _PHASE1_BOOTH_INSET_MM + 'mm 内側」を design 有効範囲として作成してもらうこと。',
    '  （隣接小間・柱・パンチカーペット等との干渉を避けるため、小間ラインいっぱいまで造作しない）',
    '- 上で算出済みの有効範囲寸法が出ている場合は、その実寸（mm）を本文に明記すること。',
    '- 提出物に「平面図（全体寸法をmmで明記したもの）」を必ず含めてもらうこと。',
    '  （四方' + _PHASE1_BOOTH_INSET_MM + 'mm の逃げが取れているかを寸法で検証するため。寸法記載のない図面は検証不可と伝える）',
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
    '- 案件情報に無い項目（クライアント側の担当者名・部署等）は本文に書かず confirmations へ。',
    '- 関連マニュアルが示す書式・指定事項は本文に反映すること。',
    '- ブースサイズが未確定、または有効範囲を算出できない場合も、四方' + _PHASE1_BOOTH_INSET_MM + 'mm 内側で作成する旨は本文に必ず書き、実寸の確認は confirmations へ。'
  ].join('\n');

  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    maxTokens: 3000
  });

  const parsed = _Phase1_parseJson(res.text);

  // Gmail Draft 作成（受信者は空 — デザイナー名は user が下書きで埋める）
  const draft = GmailApp.createDraft(
    '',
    Mail_externalSubject(c.caseId, c.caseName, parsed.subject || 'パース図作成のご依頼'),
    parsed.body || ''
  );

  // Drive フォルダにも Doc 保存
  const docName = c.caseId + '_' + c.caseName + '_デザイナー依頼文_初版';
  const doc = DocumentApp.create(docName);
  doc.getBody().setText('件名: ' + (parsed.subject || '') + '\n\n' + (parsed.body || ''));
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(c.folderId));

  // 確認事項を積む
  if (parsed.confirmations && parsed.confirmations.length > 0) {
    ConfirmationSheet_appendItems(caseId, parsed.confirmations, 1);
  }
  CaseList_touchUpdatedAt(caseId);

  const docUrl = DocumentApp.openById(doc.getId()).getUrl();
  MasterWriteBack_recordArtifact(caseId, 'デザイナー依頼文', parsed.subject || '', docUrl);

  return {
    subject: parsed.subject,
    draftId: draft.getId(),
    docUrl: docUrl,
    confirmationCount: (parsed.confirmations || []).length,
    usage: res.usage
  };
}

/** 小間実寸から四方に取るクリアランス(mm) */
const _PHASE1_BOOTH_INSET_MM = 100;

/**
 * ブースサイズ表記から「四方 inset mm 内側」の有効範囲を算出して文字列で返す。
 * W×D が読み取れない表記（"3小間" / "9㎡" 等）では '' を返す。
 * @param {string} boothSize 例 "W5940×D2970" / "5.94m x 2.97m"
 * @param {number} inset 片側のクリアランス(mm)
 * @return {string} 例 "W5740mm × D2770mm（小間実寸 W5940 × D2970 から四方100mm内側）"
 */
function _Phase1_insetBoothSize(boothSize, inset) {
  const source = String(boothSize == null ? '' : boothSize);
  const normalized = (source.normalize ? source.normalize('NFKC') : source).replace(/,/g, '');
  const matches = normalized.replace(/m2/gi, 'm').match(/\d+(?:\.\d+)?/g);
  if (!matches || matches.length < 2) return '';

  let width = Number(matches[0]);
  let depth = Number(matches[1]);
  if (!isFinite(width) || !isFinite(depth) || width <= 0 || depth <= 0) return '';
  // 100 未満は m 表記とみなして mm に換算（_AssignSheet_boothArea と同じ判定）
  if (width < 100 && depth < 100) {
    width = width * 1000;
    depth = depth * 1000;
  }
  const innerW = Math.round(width - inset * 2);
  const innerD = Math.round(depth - inset * 2);
  if (innerW <= 0 || innerD <= 0) return '';
  return 'W' + innerW + 'mm × D' + innerD + 'mm' +
    '（小間実寸 W' + Math.round(width) + 'mm × D' + Math.round(depth) + 'mm から四方' + inset + 'mm内側）';
}

function _Phase1_parseJson(text) {
  let t = text.trim();
  // ```json ... ``` で包まれているケースを除去
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  try {
    return JSON.parse(t);
  } catch (e) {
    // JSON パース失敗時は body にそのまま入れて返す
    return { subject: '', body: text, confirmations: [] };
  }
}

function _fmtDate(d) {
  if (!d) return '未確定';
  if (d instanceof Date) return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd');
  return String(d);
}
