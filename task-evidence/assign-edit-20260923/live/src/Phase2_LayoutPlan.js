/**
 * Phase2: レイアウトシート 初版 を生成。
 *
 * 平面/立面/トラス/床タイル/電源ケーブル/LED UP/接続図 等、
 * 制作仕様の構成要素をカテゴリ別に列挙する。
 *
 * 出力構造（zissi 内 新シート）:
 *   A カテゴリ  B 項目名  C 仕様/寸法  D 数量  E 必要素材  F 担当(候補)  G 備考  H ステータス
 */

const LAYOUTPLAN_PROPOSAL_SHEET_NAME = 'Claude_レイアウト提案';
const LAYOUTPLAN_PROMPT_SHEET_NAME = 'Claude_レイアウト画像プロンプト';
const LAYOUTPLAN_HEADERS = ['カテゴリ', '項目名', '仕様/寸法', '数量', '必要素材', '担当(候補)', '備考', 'ステータス'];
const LAYOUTPLAN_PROMPT_HEADERS = ['シーン', '推奨ツール', 'プロンプト (日本語)', 'プロンプト (英語)', 'パラメータ/設定ヒント', '参考画像 URL (ChatGPT に添付)'];

function Phase2_LayoutPlan_generate(caseId) {
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
    'レイアウト', '平面図', 'トラス', 'LED UP', '電気配線', '床タイル', '会場レイアウト',
    'ブース設営', '立面図'
  ]).slice(0, 15);

  // 保有機材カタログ（スライド番号 → 画像URL）を読み取り、コンテキストへ
  const catalog = _LayoutPlan_loadEquipmentCatalog();
  const catalogContext = catalog.length > 0
    ? '【保有機材カタログ画像 (スライド番号 + タイトル + 現物写真URL)】\n' +
      'プロンプトに対して、最も近い機材のスライド番号を image_prompts[].reference_slides に列挙すること。' +
      'アプリは指定された番号のカタログ画像 URL を ChatGPT 添付用に出力する。\n\n' +
      catalog.map(function (c) { return 'Slide ' + c.slideNum + ': ' + c.title; }).join('\n')
    : '';

  const cachedContext = [
    Case_loadClientContext(c),
    OwnedEquipment_describe(),
    catalogContext,
    '【関連マニュアル抜粋】',
    ...manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; })
  ].filter(Boolean);

  const userPrompt = [
    '以下の展示会ブース案件で、レイアウトシート 初版（仕様明細）+ AI 画像生成用プロンプト を作成してください。',
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    '',
    '## 出力形式（厳守・前後の説明文や ```json``` ブロック禁止）',
    '{',
    '  "items": [',
    '    {"category": "平面図", "name": "ブース配置図 (上面)", "spec": "W6000xD3000mm スケール 1/50", "quantity": 1, "materials": "印刷物 / CADデータ", "owner": "デザイナー", "note": ""},',
    '    {"category": "トラス", "name": "トラス組み", "spec": "...", "quantity": ..., "materials": "...", "owner": "", "note": ""}',
    '  ],',
    '  "image_prompts": [',
    '    {"scene": "上面平面図 (top-down floor plan)", "tool": "Midjourney / Adobe Firefly", "prompt_ja": "<日本語の詳細な指示>", "prompt_en": "<English prompt for image gen AI>", "settings": "aspect ratio 4:3, photoreal, blueprint style 等", "reference_slides": [N, N, ...]},',
    '    {"scene": "パース (3D perspective view)", ...},',
    '    {"scene": "俯瞰CG (aerial three-quarter view, SketchUp風 建築CG)", ...},',
    '    {"scene": "トラス・骨組み構造 (truss frame)", ...},',
    '    {"scene": "正面立面 (front elevation)", ...}',
    '  ],',
    '  "confirmations": [',
    '    {"category": "<確認カテゴリ>", "content": "<確認したい内容>"}',
    '  ]',
    '}',
    '',
    '注意:',
    '- items のカテゴリ: 平面図 / 立面図 / 透視図(パース) / トラス / 床タイル / 電源・ケーブル配線 / LED UP / 接続図 / 看板・グラフィック / 什器配置',
    '- 寸法・数量は ブースサイズから一般的な仕様で初版を出す。確定情報がないものは note に「要確認」。',
    '- **寸法の優先順位: ①冒頭の【顧客要望・打合せ議事録】に出てくる実寸 (ブースサイズ・トラス高さ・パネル寸法等) ②案件情報のブースサイズ ③それでも不明な場合のみ 3M×3M 想定** (勝手に3M×3Mへ丸めるのは禁止。議事録に 9M×8.1M 等の実寸があればそれが正)。使った寸法の根拠が議事録なら note に「議事録より」と書く。',
    '- ブースサイズが議事録にも案件情報にも無い場合のみ confirmations に「ブースサイズ確定」を入れる。',
    '- マニュアル / 添付出展マニュアル PDF が定める寸法上限・規定（天井高/吊り下げ可否/床面荷重等）は必ず反映する。',
    '',
    '## image_prompts の作り方',
    '- 必ず 5 シーン分作る: ①上面平面図 ②3Dパース(アイレベル) ③俯瞰CG(SketchUp風・デザイナー提案書と同じ視点: aerial three-quarter view, clean architectural CG, light gray materials with brand color accents) ④トラス・骨組み ⑤正面立面',
    '- 各シーン: prompt_en は Midjourney/Adobe Firefly/DALL-E にコピペで使える形 (英語、詳細な視覚要素)',
    '- prompt_ja は同じ内容を日本語訳した形 (Adobe Firefly 日本語 / 日本語特化モデル向け)',
    '- **★最重要: 上で示した「株式会社オージャスト 保有機材」のみを使ってブースを構成し、ジェネリックな展示会パーツは描かないこと。**',
    '- **prompt_en / prompt_ja に固有機材の英語名 / 型番を明記 (例: "Reburse modular black galvanized steel panel system, internally lit LED light box wall, 300mm silver aluminum truss frame, white cream low sofa meeting set")**',
    '- "generic exhibition booth" / "standard trade show stand" など曖昧な表現は禁止',
    '- 寸法・色・素材・配置・照明・スタイル(blueprint風 / photoreal 等)を具体的に記述',
    '- 主要要素(バックパネル/LED UP/トラス/受付カウンター/什器/照明)の位置を明記',
    '- クライアント業態に合わせた色トーン・印象は LED UP のサインや床パネルの色 等、保有機材内で表現する',
    '- **床仕様は議事録・実施計画の決定に従う (例: 白床パネル)。決定が無い場合のみ Reブース標準の黒グレー市松。勝手に市松にしない。**',
    '- **ゾーニングを必ず描写: 商談セット(ハイテーブル+ハイチェア×N) / 実機展示ゾーン(ステージプラットフォーム) / バックヤード(カーテン仕切り+メタルラック) の位置関係を prompt に含める (議事録・図面に基づく)。**',
    '- 大型ブース(4小間以上)でよく使う機材の英語語彙 (プロンプトで使用):',
    '    トロマットサイン出力(緑帯看板) = "wide fabric banner sign (Toromat print, W7500×H600) mounted on top truss beam"',
    '    クランプトラス黒+トロマット両面 = "black clamp-type truss column with double-sided fabric graphic"',
    '    ステージプラットフォーム = "low exhibition stage platform (H100-200mm) with white top panel for machinery display"',
    '    LEDチューブ照明 = "LED tube accent lighting lines running along truss frame"',
    '    バックヤード = "curtained backyard storage area with 4-tier metal rack"',
    '    司会台 = "presenter podium"、 85インチ斜め配置 = "85 inch display mounted on diagonal black truss"',
    '- settings: アスペクト比、スタイルパラメータ、推奨モデル等のヒント',
    '- **reference_slides: そのシーンで使う主要機材のスライド番号 (上記の保有機材カタログから) を 3〜6 個列挙。アプリが該当スライドの現物写真 URL を ChatGPT 添付用に出力する。**'
  ].join('\n');

  const manualPdfs = CaseManualPdf_find(c);
  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: manualPdfs,
    maxTokens: 8000
  });

  const parsed = _Phase1_parseJson(res.text);
  const items = parsed.items || [];
  const imagePrompts = parsed.image_prompts || [];

  // 画像プロンプトシートを作成 (毎回上書き)
  let promptSheet = _LayoutPlan_getOrInsertSheet(zissiSs, LAYOUTPLAN_PROMPT_SHEET_NAME);
  promptSheet.getRange(1, 1, 1, LAYOUTPLAN_PROMPT_HEADERS.length).setValues([LAYOUTPLAN_PROMPT_HEADERS])
    .setFontWeight('bold').setBackground('#cfe2f3');
  promptSheet.setFrozenRows(1);
  if (imagePrompts.length > 0) {
    // slideNum -> imageUrl のマップ
    const catalogByNum = {};
    catalog.forEach(function (c) { catalogByNum[c.slideNum] = c.imageUrl; });
    const promptRows = imagePrompts.map(function (p) {
      const refSlides = Array.isArray(p.reference_slides) ? p.reference_slides : [];
      const refUrls = refSlides.map(function (n) { return catalogByNum[Number(n)]; }).filter(Boolean);
      return [
        p.scene || '',
        p.tool || '',
        p.prompt_ja || '',
        p.prompt_en || '',
        p.settings || '',
        refUrls.join('\n')
      ];
    });
    promptSheet.getRange(2, 1, promptRows.length, LAYOUTPLAN_PROMPT_HEADERS.length).setValues(promptRows);
  }
  promptSheet.setColumnWidth(1, 200); // シーン
  promptSheet.setColumnWidth(2, 200); // ツール
  promptSheet.setColumnWidth(3, 380); // ja
  promptSheet.setColumnWidth(4, 380); // en
  promptSheet.setColumnWidth(5, 240); // settings
  promptSheet.setColumnWidth(6, 320); // refs
  promptSheet.getRange(1, 1, imagePrompts.length + 1, LAYOUTPLAN_PROMPT_HEADERS.length).setWrap(true).setVerticalAlignment('top');

  let proposalSheet = _LayoutPlan_getOrInsertSheet(zissiSs, LAYOUTPLAN_PROPOSAL_SHEET_NAME);
  proposalSheet.getRange(1, 1, 1, LAYOUTPLAN_HEADERS.length).setValues([LAYOUTPLAN_HEADERS])
    .setFontWeight('bold').setBackground('#cfe2f3');
  proposalSheet.setFrozenRows(1);
  if (items.length > 0) {
    const rows = items.map(function (it) {
      return [
        it.category || '',
        it.name || '',
        it.spec || '',
        it.quantity || '',
        it.materials || '',
        it.owner || '',
        it.note || '',
        '未着手'
      ];
    });
    proposalSheet.getRange(2, 1, rows.length, LAYOUTPLAN_HEADERS.length).setValues(rows);
  }
  proposalSheet.setColumnWidth(1, 130);
  proposalSheet.setColumnWidth(2, 240);
  proposalSheet.setColumnWidth(3, 280);
  proposalSheet.setColumnWidth(5, 200);
  proposalSheet.setColumnWidth(7, 200);

  const proposalUrl = PanelLinks_sheetUrl(zissiSs, proposalSheet);
  const promptUrl = PanelLinks_sheetUrl(zissiSs, promptSheet);

  if (parsed.confirmations && parsed.confirmations.length > 0) {
    const tagged = parsed.confirmations.map(function (x) {
      return { category: '[レイアウト] ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  CaseList_touchUpdatedAt(caseId);

  MasterWriteBack_recordArtifact(caseId, 'レイアウトシート',
    'レイアウトシート 初版 (' + items.length + ' 項目)', proposalUrl);
  MasterWriteBack_recordArtifact(caseId, 'レイアウト画像プロンプト',
    'AI画像生成プロンプト (' + imagePrompts.length + ' シーン)', promptUrl);

  return {
    zissiSheetUrl: zissiSs.getUrl(),
    proposalSheetUrl: proposalUrl,
    proposalSheetName: LAYOUTPLAN_PROPOSAL_SHEET_NAME,
    promptSheetUrl: promptUrl,
    promptSheetName: LAYOUTPLAN_PROMPT_SHEET_NAME,
    itemCount: items.length,
    promptCount: imagePrompts.length,
    confirmationCount: (parsed.confirmations || []).length,
    manualPagesUsed: manualPages.length,
    manualPdfs: manualPdfs.map(function (p) { return p.label; }),
    usage: res.usage
  };
}

/**
 * シートを取得または作成（既存なら clear）。
 * 前回の失敗で半端に作られたシートでも getSheetByName が null を返すケースがあるため、
 * insertSheet を try で囲み、衝突時は再取得して clear。
 */
function _LayoutPlan_getOrInsertSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    sheet.clear();
    return sheet;
  }
  try {
    return ss.insertSheet(name);
  } catch (e) {
    SpreadsheetApp.flush();
    sheet = ss.getSheetByName(name);
    if (!sheet) throw e;
    sheet.clear();
    return sheet;
  }
}

/**
 * 案件一覧 SS の「保有機材カタログ」シートから {slideNum, title, imageUrl}[] を読み取り。
 * EquipmentImages_buildCatalog で生成された状態を前提。
 */
function _LayoutPlan_loadEquipmentCatalog() {
  try {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName('保有機材カタログ');
    if (!sheet || sheet.getLastRow() < 2) return [];
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
    const out = [];
    for (let i = 0; i < data.length; i++) {
      const n = Number(data[i][0]);
      const title = String(data[i][1] || '').trim();
      const url = String(data[i][4] || '').trim().split('\n')[0];
      if (n && url) out.push({ slideNum: n, title: title, imageUrl: url });
    }
    return out;
  } catch (e) {
    return [];
  }
}
