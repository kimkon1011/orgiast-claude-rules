/**
 * Phase_RevisionRequest.js - 顧客の修正要望メールからデザイナー依頼文と見積更新案を生成し配線する
 * (TASK_ID: REBOOTH-T5-revision-request)
 */

var _REVISION_DESIGNER_SHEET_NAME = 'Claude_デザイナー依頼';
var _REVISION_ESTIMATE_SHEET_PREFIX = 'Claude_見積更新案_';

/**
 * 修正要望からデザイナー依頼・見積更新案・送付文を作り台帳へ配線する
 * @param {string} caseId
 * @returns {Object}
 */
function Phase_RevisionRequest_run(caseId) {
  var c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  var zissiSs = _Zissi_open(c);

  // a. 顧客コンテキストの最新メールから要望を JSON 抽出
  var context = Case_loadClientContext(c);
  if (!context) {
    throw new Error('お客様のメール・議事録がまだ取り込まれていません。パネルの「📥 最新の打合せ・メールを取り込む」を実行してから再実行してください。');
  }

  var prompt = [
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '',
    '上記の顧客コンテキスト(打合せ議事録とメールの時系列)から、**お客様から届いた最新のメール**に含まれる「パース・デザイン・施工・備品等の修正・追加・変更要望」を特定し、以下を抽出してください。',
    '',
    '## 抽出要件',
    '1. items: 修正要望の各明細。what(項目名・内容), qty(数量。不明なら1), unitPrice(見積に反映すべき単価の記載があれば数値、なければnull), note(仕様や補足)',
    '2. dueHint: 顧客からの希望期日または次回提案までの期日目安（例: "次回MTG前まで", "10/18まで" など）',
    '3. replySummary: 修正要望の要旨（2〜3行）',
    '',
    '## 出力形式（JSONのみ・前後の説明文やコードブロック禁止）',
    '{',
    '  "items": [',
    '    {"what": "<要望項目名>", "qty": 1, "unitPrice": null, "note": "<補足>" }',
    '  ],',
    '  "dueHint": "<期日目安>",',
    '  "replySummary": "<要旨>"',
    '}'
  ].join('\n');

  var res = ClaudeClient_call({
    cachedContext: [KNOWHOW_DESIGNER_BRIEF_RULES, context],
    userMessage: prompt,
    maxTokens: 4000
  });

  var parsedRevision = _Phase1_parseJson(res.text);
  if (!parsedRevision || typeof parsedRevision !== 'object') {
    throw new Error('修正要望の抽出結果をJSONとして読み取れませんでした。再実行してください。');
  }

  var revision = {
    items: Array.isArray(parsedRevision.items) ? parsedRevision.items : [],
    dueHint: String(parsedRevision.dueHint || '').trim() || '次回MTG前まで',
    replySummary: String(parsedRevision.replySummary || '').trim()
  };

  // b. buildDesignerMessage → DISCORD_DESIGNER_CHANNEL_ID があれば投稿、無ければ実施計画書に Claude_デザイナー依頼 シート
  var designerMsgResult = RevisionRequest_buildDesignerMessage(revision, c);
  var designerMessage = designerMsgResult.ok ? designerMsgResult.message : (
    '【パース・デザイン修正依頼】\n案件名: ' + (c.caseName || '') + '\n\n' +
    '修正要望:\n' + revision.items.map(function (it, idx) { return (idx + 1) + '. ' + it.what; }).join('\n') + '\n\n' +
    'いつものテンプレで補足し作成をお願いいたします。'
  );

  var props = PropertiesService.getScriptProperties();
  var botToken = props.getProperty('DISCORD_BOT_TOKEN') || '';
  var designerChannelId = props.getProperty('DISCORD_DESIGNER_CHANNEL_ID') || '';
  var discordPosted = false;

  if (botToken && designerChannelId) {
    try {
      var postRes = UrlFetchApp.fetch('https://discord.com/api/v10/channels/' + encodeURIComponent(designerChannelId) + '/messages', {
        method: 'post',
        headers: { Authorization: 'Bot ' + botToken },
        contentType: 'application/json',
        payload: JSON.stringify({ content: designerMessage.slice(0, 2000) }),
        muteHttpExceptions: true
      });
      if (postRes.getResponseCode() >= 200 && postRes.getResponseCode() < 300) {
        discordPosted = true;
      } else {
        console.warn('Phase_RevisionRequest discord post failed: ' + postRes.getResponseCode() + ' ' + postRes.getContentText());
      }
    } catch (e) {
      console.warn('Phase_RevisionRequest discord post error: ' + (e.message || e));
    }
  }

  var designerSheet = zissiSs.getSheetByName(_REVISION_DESIGNER_SHEET_NAME);
  if (!designerSheet) {
    designerSheet = zissiSs.insertSheet(_REVISION_DESIGNER_SHEET_NAME);
  } else {
    designerSheet.clear();
  }
  designerSheet.getRange('A1').setValue('🎨 デザイナー修正依頼文').setFontWeight('bold');
  designerSheet.getRange('B1').setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));
  designerSheet.getRange('A2').setValue('Discord投稿状態: ' + (discordPosted ? '✅ 投稿完了 (ch: ' + designerChannelId + ')' : '⚠ 未投稿 (トークン未設定またはシート記録フォールバック)'));
  designerSheet.getRange('A4').setValue(designerMessage).setWrap(true);
  designerSheet.setColumnWidth(1, 600);

  var designerSheetUrl = PanelLinks_sheetUrl(zissiSs, designerSheet);

  // c. 最新見積を読み applyToEstimate → 更新案を実施計画書の別シートに作成。changed:false なら「見積変更なし」と記録
  var estimateData = _AppForm_readEstimateData(c);
  var currentEstimate = {
    lines: (estimateData && Array.isArray(estimateData.items)) ? estimateData.items.map(function (it) {
      return {
        name: it.itemName || it.name,
        qty: it.qty,
        unitPrice: it.unitPrice,
        note: it.note
      };
    }) : [],
    taxRate: 0.1
  };

  var appliedEstimate = RevisionRequest_applyToEstimate(currentEstimate, revision);
  var estimateSheetName = _REVISION_ESTIMATE_SHEET_PREFIX + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MMdd_HHmm');
  var estimateSheet = zissiSs.getSheetByName(estimateSheetName);
  if (!estimateSheet) {
    estimateSheet = zissiSs.insertSheet(estimateSheetName);
  } else {
    estimateSheet.clear();
  }

  estimateSheet.getRange('A1').setValue('🔁 見積更新案 (' + (appliedEstimate.changed ? '変更あり' : '見積変更なし') + ')').setFontWeight('bold');
  estimateSheet.getRange('B1').setValue(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'));

  estimateSheet.getRange(3, 1, 1, 5).setValues([['項目名', '数量', '単価', '金額', '変更区分']]).setFontWeight('bold').setBackground('#cfe2f3');
  var estRows = appliedEstimate.estimate.lines.map(function (l) {
    var amt = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
    var appliedItem = appliedEstimate.applied.find(function (a) { return a.name === l.name; });
    var mode = appliedItem ? (appliedItem.mode === 'incremented' ? '数量加算' : '新規追加') : '据置';
    return [l.name, l.qty, l.unitPrice, amt, mode];
  });
  if (estRows.length > 0) {
    estimateSheet.getRange(4, 1, estRows.length, 5).setValues(estRows);
    var summaryRow = 4 + estRows.length + 1;
    estimateSheet.getRange(summaryRow, 1, 3, 2).setValues([
      ['税抜合計', appliedEstimate.estimate.taxExTotal],
      ['消費税', appliedEstimate.estimate.tax],
      ['税込合計', appliedEstimate.estimate.taxInTotal]
    ]).setFontWeight('bold');
  } else {
    estimateSheet.getRange(4, 1).setValue('現行見積の明細が見つかりませんでした（見積変更なし）');
  }

  var estimateSheetUrl = PanelLinks_sheetUrl(zissiSs, estimateSheet);

  // d. Phase_CoverLetter_generate を呼び、修正反映後の再提出送付文を作る
  var coverLetterResult = null;
  try {
    coverLetterResult = Phase_CoverLetter_generate(caseId, '【修正反映後の再提出】\n要旨: ' + (revision.replySummary || 'ご要望箇所のパースおよび見積を更新いたしました。'));
  } catch (e) {
    console.warn('Phase_RevisionRequest coverLetter failed: ' + (e.message || e));
    coverLetterResult = { ok: false, error: String(e.message || e) };
  }

  // e. 台帳へ「デザイナーへ修正依頼」「見積を更新」「再提出」の 3 タスクを TaskLedger_upsert で登録 (owner=オージャスト)
  // 白川さんの必要/不要判断は ConfirmationSheet_appendItems に「[修正要望] 必要/不要の判断」で上げる
  var dueStr = revision.dueHint || '';
  var ledgerItems = [
    {
      source: '修正要望',
      taskName: 'デザイナーへ修正依頼',
      detail: '修正要望をデザイナーへ依頼 (' + revision.items.map(function (it) { return it.what; }).join(', ') + ')',
      evidence: '顧客メール要旨: ' + (revision.replySummary || '最新メール'),
      due: dueStr,
      owner: 'オージャスト',
      aiFeature: '🔧 修正要望をデザイナーへ繋ぐ (依頼+見積更新)',
      sourceStatus: 'open'
    },
    {
      source: '修正要望',
      taskName: '見積を更新',
      detail: appliedEstimate.changed ? '修正要望に伴う見積更新 (' + appliedEstimate.applied.map(function (a) { return a.name; }).join(', ') + ')' : '修正要望の見積確認 (金額変更なし)',
      evidence: '顧客メール要旨: ' + (revision.replySummary || '最新メール'),
      due: dueStr,
      owner: 'オージャスト',
      aiFeature: '🔁 見積を更新する (議事録・メール・預かり見積から)',
      sourceStatus: 'open'
    },
    {
      source: '修正要望',
      taskName: '再提出',
      detail: 'パース修正と更新見積の顧客への再提出送付文作成・提出',
      evidence: '顧客メール要旨: ' + (revision.replySummary || '最新メール'),
      due: dueStr,
      owner: 'オージャスト',
      aiFeature: '✉ 見積・請求の送付文を作る',
      sourceStatus: 'open'
    }
  ];

  var ledger = null;
  try {
    ledger = TaskLedger_upsert(caseId, ledgerItems);
  } catch (e) {
    console.warn('Phase_RevisionRequest TaskLedger_upsert error: ' + (e.message || e));
    ledger = { error: String(e) };
  }

  try {
    ConfirmationSheet_appendItems(caseId, [{
      category: '[修正要望] 必要/不要の判断',
      content: '顧客からの修正要望（' + (revision.replySummary || revision.items.map(function (it) { return it.what; }).join('、')) + '）について、白川さんによる対応必要／不要の判断をお願いします。'
    }], 2);
  } catch (e) {
    console.warn('Phase_RevisionRequest ConfirmationSheet error: ' + (e.message || e));
  }

  CaseList_touchUpdatedAt(caseId);
  MasterWriteBack_recordArtifact(caseId, '修正要望対応',
    'デザイナー依頼+見積更新(' + (appliedEstimate.changed ? '変更あり' : '変更なし') + ')', designerSheetUrl);

  return {
    ok: true,
    discordPosted: discordPosted,
    designerSheetUrl: designerSheetUrl,
    estimateSheetUrl: estimateSheetUrl,
    coverLetterResult: coverLetterResult,
    estimateChanged: appliedEstimate.changed,
    delta: appliedEstimate.delta,
    itemCount: revision.items.length,
    ledger: ledger
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Phase_RevisionRequest_run: Phase_RevisionRequest_run
  };
}
