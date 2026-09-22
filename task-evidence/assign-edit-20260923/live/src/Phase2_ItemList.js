/**
 * Phase2: アイテムリスト 初版 を生成。
 *
 * 流れ:
 *  1) 案件情報を取得
 *  2) 実施計画書を探す (Phase1_Estimate が作った zissi)
 *  3) アイテムリスト関連マニュアル抜粋を取得
 *  4) Claude でカテゴリ別の品目リスト JSON を生成
 *  5) zissi 内に「Claude_アイテムリスト提案」シートを作成 (or 上書き) して書き込み
 *  6) 確認事項を確認シートに積む
 *
 * 出力構造（提案シート）:
 *   A カテゴリ  B 品目  C 数量  D 仕様/サイズ  E 単価(未確定)  F 発注先候補  G 備考  H ステータス
 */

const ITEMLIST_PROPOSAL_SHEET_NAME = 'Claude_アイテムリスト提案';
const ITEMLIST_HEADERS = ['カテゴリ', '品目', '数量', '仕様/サイズ', '単価(未確定)', '発注先候補', '備考', 'ステータス'];

/**
 * 救急セット(必須品のみ)。設営現場で実際に起きる負傷(切創・トゲ・打撲・熱中症)だけに絞り、
 * 三角巾・巻き包帯・消毒液ボトル等の「使わない/代替できる」品目は意図的に外している。
 * 中身の根拠と除外理由は first-aid-kit.md を参照。
 * 安衛則634条(品目の法定リスト)は2021年12月に削除済みで、現在は事業者が作業リスクに応じて自律的に決める。
 * 633条の義務は「備え付け・置き場所と使い方の周知・清潔保持」のみ。
 */
const ITEMLIST_FIRSTAID_CONTENTS = [
  'ハイドロコロイド絆創膏 大(キズパワーパッド ジャンボ相当) 6枚',
  'ハイドロコロイド絆創膏 指用/標準 10枚',
  '防水絆創膏(普通サイズ) 20枚',
  '滅菌パッド 大判 約10×10cm 3枚',
  '自着性包帯 幅5cm 1巻',
  '不織布サージカルテープ 25mm 1巻',
  'ニトリル手袋 3組',
  'トゲ抜きピンセット(先細) 1本',
  '小型はさみ 1本',
  '個包装アルコール綿 10包',
  '瞬間冷却パック 2個',
  '経口補水パウダー/塩タブレット 4本'
];
const ITEMLIST_FIRSTAID_ITEM = {
  category: '運営備品',
  name: '救急セット 1式',
  quantity: 1,
  spec: ITEMLIST_FIRSTAID_CONTENTS.join(' / '),
  vendor_candidate: '',
  note: '全案件必須(安衛則633条)。工具箱と分けた赤ポーチで搬入車に常備し、置き場所を全員に周知。撤去日に中身を点検して使った分だけ補充。大量出血・骨折・意識障害・目の異物は応急処置せず119番+会場救護室。'
};

function Phase2_ItemList_generate(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);

  // 実施計画書を探す（無くてもDocに出すので致命的ではない）
  let zissiSs = null;
  if (c.zissiId) {
    try { zissiSs = SpreadsheetApp.openById(c.zissiId); } catch (e) {}
  }
  if (!zissiSs) {
    // フォールバック: case フォルダから「実施計画書」名を含む Sheet を探す
    try {
      const folder = DriveApp.getFolderById(c.projectFolderId || c.folderId);
      const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
      while (files.hasNext()) {
        const f = files.next();
        if (f.getName().indexOf('実施計画書') >= 0 && f.getName().indexOf('提出') < 0) {
          zissiSs = SpreadsheetApp.openById(f.getId());
          break;
        }
      }
    } catch (e) {}
  }
  if (!zissiSs) {
    throw new Error('実施計画書が見つかりません。先に Phase1 ② 見積初版を生成するか、既存の実施計画を取り込んでください。');
  }

  const existingItems = Zissi_readExistingItemList(zissiSs).items;

  const manualPages = ManualLoader_findPages([
    'アイテムリスト', '備品リスト', 'アイテムリストシート', '必要備品', '什器'
  ]).slice(0, 15);
  const caseDigest = CaseDigest_load(c);

  const cachedContext = [
    Case_loadClientContext(c),
    OwnedEquipment_describe(),
    caseDigest ? '【案件資料ダイジェスト(夜間に全資料を読んで作成)】\n' + caseDigest : '',
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const existingPrompt = existingItems.length > 0 ? [
    '',
    '## 実施計画に登録済みのアイテムリスト(この品目は提案不要)',
    existingItems.slice(0, 200).map(function (x) { return x.name; }).join('\n')
  ] : [];

  const userPrompt = [
    '以下の展示会ブース案件で、初版のアイテムリスト（必要備品・造作物・グラフィック・什器・印刷物・電気・運営備品 等）を作成してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
  ].concat(existingPrompt).concat([
    '',
    '## 出力形式（厳守・前後の説明文や ```json``` ブロック禁止）',
    '{',
    '  "items": [',
    '    {"category": "造作物", "name": "バックパネル W6000xH2700", "quantity": 1, "spec": "...", "vendor_candidate": "", "note": ""},',
    '    {"category": "グラフィック", "name": "...", "quantity": ..., "spec": "...", "vendor_candidate": "", "note": ""}',
    '  ],',
    '  "confirmations": [',
    '    {"category": "<確認カテゴリ>", "content": "<確認したい内容>"}',
    '  ]',
    '}',
    '',
    '注意:',
    '- カテゴリ例: 造作物 / グラフィック / 什器 / 備品 / 印刷物 / 電気 / 運営備品 / 設営工具',
    '- **★最重要: 上に示した「株式会社オージャスト 保有機材」を最優先で組み合わせて構成すること。外注新規発注は最小限。**',
    '- name 欄には保有機材の固有名（例「Reブースパネル W3000×H2980 黒」「トラス 300角シルバー」「LED UP W2000×H2980」）で記載。',
    '- 在庫数を超える場合のみ vendor_candidate に新規調達先案を書く。',
    '- 数量・仕様はマニュアルに準ずる一般的な展示会ブースの初版想定で入れる。確定情報がない数値は note に「要確認」と書く。',
    '- マニュアルが定める標準セット (基礎コマプラン等) は必ず反映する。',
    '- ブースサイズが未確定なら 3M×3M (1コマ) 想定で記載し confirmations に「ブースサイズ確定」を入れる。',
    '- 運営備品に「' + ITEMLIST_FIRSTAID_ITEM.name + '」を必ず1件入れる。spec 欄には次の中身をそのまま書く: ' + ITEMLIST_FIRSTAID_ITEM.spec,
    '- 救急セットに三角巾・巻き包帯・消毒液ボトル・副木などを足さない(使われず期限切れになるため意図的に除外している)。'
  ]).concat(existingItems.length > 0 ? [
    '- **上記「登録済みのアイテムリスト」にある品目は items に含めないこと。この案件に必要なのに登録済みリストに無い不足品目だけを提案する。**',
    '- 不足品目が本当に無ければ items は空配列でよい。',
    '- 品目名は既存リストと同じ物を指す場合は同じ表記で書くこと。'
  ] : []).join('\n');

  const manualPdfs = CaseManualPdf_find(c);
  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: manualPdfs,
    maxTokens: 10000
  });

  const parsed = _Phase1_parseJson(res.text);
  // parseJson 失敗(JSON途切れ等)は items キー自体が無い → 無言の0品目シートにせずエラーで知らせる
  if (!Array.isArray(parsed.items)) {
    throw new Error('アイテムリスト生成の応答をJSONとして読めませんでした(出力途切れの可能性)。再実行してください。 usage.output_tokens=' + (res.usage && res.usage.output_tokens));
  }
  const items = parsed.items;

  function normalizeItemName(name) {
    return String(name || '').normalize('NFC').toLowerCase().replace(/[\s　]/g, '').replace(/＆/g, '&');
  }
  // 救急セットは全案件必須。プロンプト指示だけだと取りこぼすので確定的にも入れる(二重保証)。
  // 既に実施計画にある場合はこの後の照合で「登録済み」になるだけなので重複しない。
  if (!items.some(function (it) { return String(it.name || '').indexOf('救急') >= 0; })) {
    items.push(Object.assign({}, ITEMLIST_FIRSTAID_ITEM));
  }

  const existingNames = existingItems.map(function (x) { return normalizeItemName(x.name); }).filter(Boolean);
  items.forEach(function (item) {
    const generatedName = normalizeItemName(item.name);
    item._isExisting = existingNames.some(function (existingName) {
      if (generatedName === existingName) return true;
      const shorterLength = Math.min(generatedName.length, existingName.length);
      return shorterLength >= 4 && (generatedName.indexOf(existingName) >= 0 || existingName.indexOf(generatedName) >= 0);
    });
  });
  const sortedItems = items.filter(function (item) { return !item._isExisting; })
    .concat(items.filter(function (item) { return item._isExisting; }));
  const existingMatchedCount = items.filter(function (item) { return item._isExisting; }).length;
  const newItemCount = items.length - existingMatchedCount;

  // 提案シート書き込み（毎回上書き）
  let proposalSheet = zissiSs.getSheetByName(ITEMLIST_PROPOSAL_SHEET_NAME);
  if (!proposalSheet) {
    proposalSheet = zissiSs.insertSheet(ITEMLIST_PROPOSAL_SHEET_NAME);
  } else {
    proposalSheet.clear();
  }
  proposalSheet.getRange(1, 1, 1, ITEMLIST_HEADERS.length).setValues([ITEMLIST_HEADERS])
    .setFontWeight('bold').setBackground('#cfe2f3');
  proposalSheet.setFrozenRows(1);
  if (sortedItems.length > 0) {
    const rows = sortedItems.map(function (it) {
      return [
        it.category || '',
        it.name || '',
        it.quantity || '',
        it.spec || '',
        '', // 単価 (未確定)
        it.vendor_candidate || '',
        it.note || '',
        it._isExisting ? '登録済み(実施計画にあり)' : '🆕未登録(実施計画に追記してください)'
      ];
    });
    proposalSheet.getRange(2, 1, rows.length, ITEMLIST_HEADERS.length).setValues(rows);
    if (newItemCount > 0) {
      proposalSheet.getRange(2, 1, newItemCount, ITEMLIST_HEADERS.length).setBackground('#fff2cc');
    }
  }
  const summary = existingItems.length > 0
    ? '🆕未登録 ' + newItemCount + ' 件 / 登録済み ' + existingMatchedCount + ' 件 (実施計画「アイテムリスト」シート ' + existingItems.length + ' 品目と照合)'
    : '実施計画にアイテムリストが無いため全件を🆕未登録として表示';
  proposalSheet.getRange('J1').setValue(summary).setFontWeight('bold');
  // 列幅
  proposalSheet.setColumnWidth(2, 280); // 品目
  proposalSheet.setColumnWidth(4, 240); // 仕様
  proposalSheet.setColumnWidth(7, 200); // 備考

  const proposalUrl = PanelLinks_sheetUrl(zissiSs, proposalSheet);

  // 確認事項
  if (parsed.confirmations && parsed.confirmations.length > 0) {
    const tagged = parsed.confirmations.map(function (x) {
      return { category: '[アイテムリスト] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  CaseList_touchUpdatedAt(caseId);

  MasterWriteBack_recordArtifact(caseId, 'アイテムリスト',
    'アイテムリスト初版 (全' + items.length + '品目 / 🆕未登録' + newItemCount + '件)', proposalUrl);

  return {
    zissiSheetUrl: zissiSs.getUrl(),
    proposalSheetUrl: proposalUrl,
    proposalSheetName: ITEMLIST_PROPOSAL_SHEET_NAME,
    itemCount: items.length,
    newItemCount: newItemCount,
    existingMatchedCount: existingMatchedCount,
    confirmationCount: (parsed.confirmations || []).length,
    manualPagesUsed: manualPages.length,
    usage: res.usage
  };
}
