/**
 * Phase2: 設営撤去手順 / 搬入出計画 初版 を生成。
 *
 * - Phase2_SetupTeardownPlan_generate(caseId): 会場入りから撤去完了までの作業手順 Doc
 * - Phase2_LogisticsPlan_generate(caseId):     車両・荷物・到着時刻の搬入出計画 Doc
 *
 * 共通仕様:
 *  - 案件 Drive フォルダに Google Doc を保存
 *  - 確認事項（不確定項目）は確認シートに [カテゴリ] プレフィックス付きで追記
 *  - 関連マニュアル抜粋を Claude にキャッシュ context で渡す
 */

const _OPS_PLAN_CONFIG = {
  setup_teardown: {
    displayName: '設営撤去手順',
    docSuffix: '設営撤去手順_初版',
    confirmCategoryPrefix: '[設営撤去]',
    manualQueries: ['設営', '撤去', '搬入', '搬出', 'ブース 施工手順'],
    purposeHint: '展示会本番のブース設営から撤去完了までの作業手順書。施工会社・運営スタッフ・社内担当が現場で参照するため、時系列で誰が何を何時にするかが分かるように。',
    outputSchema: [
      '{',
      '  "title": "<タイトル>",',
      '  "design_summary": {',
      '    "booth_size": "<例: 8コマ 6000×12000 72m2>",',
      '    "wall_layout": "<壁面パネル配置: バックパネル/サイドパネル の枚数 + 備品コード + 寸法>",',
      '    "truss": "<トラス本数 + 角サイズ + 必要ボルト数>",',
      '    "carpet": "<パンチカーペット 色 + 面数 + カット仕様>",',
      '    "electric": "<電気容量 + コンセント位置 + 通電開始時刻 + 申請状況>",',
      '    "ledup": "<LEDUP 構成: 各モジュールの 備品コード + 寸法 + 設置位置>",',
      '    "logo_box": "<ロゴボックスの位置と寸法>",',
      '    "monitors": "<モニター: 台数 / サイズ / 取付方式>"',
      '  },',
      '  "anchor_tools": [',
      '    {"category": "アンカー", "items": ["M10×60mm × 必要本数 (URL)"]},',
      '    {"category": "ドリル", "items": ["電動ドリル / SDSプラスビット φ10.5mm"]},',
      '    {"category": "グラインダー", "items": ["ディスクグラインダ / 切断砥石"]},',
      '    {"category": "ハンドツール", "items": ["ハンマー / ラチェット / メジャー / ペン / 養生テープ / ブロワー / 集塵機"]},',
      '    {"category": "火炎防止", "items": ["不燃シート"]},',
      '    {"category": "保護具", "items": ["保護ゴーグル / 保護手袋"]}',
      '  ],',
      '  "sections": [',
      '    {"heading": "搬入・設営（前日〜初日朝）", "items": ["時刻 / 担当 / 作業内容 (備品コード・寸法・人数まで具体的に)"]},',
      '    {"heading": "アンカー打設手順", "items": ["1. 位置墨出し / 2. φ10.5mm 穴あけ / 3. 集塵 / 4. M10アンカー打込み / ..."]},',
      '    {"heading": "カーペット敷込み手順", "items": ["カット仕様、 ロゴ部分の現場カット、 固定テープ位置"]},',
      '    {"heading": "壁面・パネル組立て", "items": ["パネル備品コード + 順序 + 連結 + 必要人数"]},',
      '    {"heading": "トラス組立て", "items": ["トラス本数、 各ボルト数、 ロの字組み（モニター吊下げ時）"]},',
      '    {"heading": "LEDUP 設置", "items": ["各モジュール備品コード + 寸法 + 設置順 + 配線"]},',
      '    {"heading": "白布張り", "items": ["白布備品コード + 各パネル寸法対応 + 表/裏 + デザイン布指定"]},',
      '    {"heading": "ロゴボックス設置", "items": ["寸法 + コンセント位置 + 配線"]},',
      '    {"heading": "電気・配線", "items": ["申請時刻、 通電開始、 コンセント口数、 PC/モニター配線"]},',
      '    {"heading": "設営仕上げ・最終チェック", "items": [...]},',
      '    {"heading": "会期中の運用（毎日朝の確認 / 終日の片付け）", "items": [...]},',
      '    {"heading": "撤去・搬出（最終日〜翌日）", "items": [...]}',
      '  ],',
      '  "confirmations": [',
      '    {"category": "<確認カテゴリ>", "content": "<確認したい内容>"}',
      '  ]',
      '}'
    ].join('\n')
  },
  logistics: {
    displayName: '搬入出計画',
    docSuffix: '搬入出計画_初版',
    confirmCategoryPrefix: '[搬入出計画]',
    manualQueries: ['搬入出', '搬入出計画', '荷物運送', '車両手配', 'トラック'],
    purposeHint: '搬入出車両・運送ルート・積載物・到着時刻の計画書。ドライバー・施工会社・倉庫担当が参照するため、車両ごとの行程と積載内容が分かるように。',
    outputSchema: [
      '{',
      '  "title": "<タイトル>",',
      '  "vehicles": [',
      '    {"label": "車両A 例: 2tロング", "purpose": "造作物搬入", "departure": "yyyy/MM/dd HH:mm 発地", "arrival": "yyyy/MM/dd HH:mm 着地", "cargo": ["...", "..."], "driver": "未定 / 指名済み等"}',
      '  ],',
      '  "schedule_notes": ["時系列メモ", "..."],',
      '  "confirmations": [',
      '    {"category": "<確認カテゴリ>", "content": "<確認したい内容>"}',
      '  ]',
      '}'
    ].join('\n')
  }
};

function Phase2_SetupTeardownPlan_generate(caseId) {
  return _Phase2_OpsPlan_generate(caseId, 'setup_teardown');
}

function Phase2_LogisticsPlan_generate(caseId) {
  return _Phase2_OpsPlan_generate(caseId, 'logistics');
}

function _Phase2_OpsPlan_generate(caseId, planType) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  const cfg = _OPS_PLAN_CONFIG[planType];
  if (!cfg) throw new Error('不明な planType: ' + planType);

  const manualPages = ManualLoader_findPages(cfg.manualQueries).slice(0, 10);

  // 案件固有の設計資料 (パース/平面/トラス/配線 等) + アイテムリスト + 保有機材カタログ
  // PDF 数は payload size + 6 min trigger timeout 制約から 3 件まで
  const itemListAndCatalog = _Phase2_loadItemListAndCatalog(c);
  const allDesignDocs = _Phase2_findDesignDocs(c); // Slides サムネイル用途は既存経路を維持
  // 出展マニュアルは既に cachedContext に抜粋済み。案件資料を予算内で最大4件添付する。
  const designPdfs = Case_collectCaseMaterials(c, { maxFiles: 4 });

  const caseDigest = CaseDigest_load(c);
  const cachedContext = [
    caseDigest ? '【案件資料ダイジェスト(夜間に全資料を読んで作成)】\n' + caseDigest : '',
    Case_loadClientContext(c),
    OwnedEquipment_describe(),
    '【関連マニュアル抜粋】\n' + manualPages.map(function (p) { return '# ' + p.title + '\nパス: ' + p.path + '\n\n' + p.body; }).join('\n\n'),
    '【案件アイテムリスト / 保有機材カタログ (備品コード参照可)】\n' + (itemListAndCatalog || '(未生成 — Phase2 アイテムリスト と 保有機材カタログ を先に生成すると 備品コード付きで生成される)')
  ].filter(function (s) { return s && s.trim(); });

  const isSetup = planType === 'setup_teardown';
  const detailRequirements = isSetup ? [
    '',
    '## 詳細レベル要件（絶対に守ること）',
    '',
    '### 使用機材の判定（最重要）',
    '- **Re ブース制作案件では トラス（300角シルバー/200角クランプ式黒/220角黒）/ LEDUP / Re ブースパネル / ロゴボックス / 白布 等の自社保有機材は 原則として使用する** 前提で手順を書く。',
    '- パース図に明示されていない、 アイテムリストが未整備でも、 「使用しない」「確認できず」「不使用」 と本文に書くのは禁止。 必ず「本案件で使用する」 として手順を書く。',
    '- 数量 / 寸法 / 備品コード が未確定の場合は本文に「**N 本 / N 枚（数量は最終図面確定後に確定）**」 と書き、 同じ事項を confirmations にも「<品目>の数量確定」と挙げる。',
    '- アイテムリスト (Claude_アイテムリスト提案) に数量入りで掲載されている品目は、 必ず その数量・寸法どおりに使う。',
    '- 「在庫上限のため使わない」「保有数が不足するため除外」と判定するのは禁止。 在庫不足の懸念は本文ではなく confirmations に「在庫確認」として挙げる。',
    '- 「保有機材カタログ」 は 全社の在庫上限の参考情報であり、 案件の使用可否を判定する根拠にはしない。',
    '',
    '### 記述レベル',
    '- 「会場入り、運営スタッフと合流」のような **抽象記述は禁止**。 アイテムリスト/保有機材カタログから **備品コード と 寸法 を引用** して具体的に書く',
    '- パネル: 「Reブースパネル W3000×H2980 黒 × N 枚」 のように 寸法と枚数を明記',
    '- トラス: 「300角シルバートラス × N 本、 ボルト × N 個必要（1本あたり8個）」',
    '- LEDUP: モジュール毎に「3667 (W2000基本セット) × 3、 3668 (W1000延長) × 3、 ...」と分解',
    '- 白布: パネル寸法ごとに対応する白布備品コードを明記',
    '- アンカー打設: M10×60mm × 必要本数、 φ10.5mm SDS プラスビット、 ディスクグラインダ + 切断砥石、 不燃シート、 保護ゴーグル + 保護手袋 など 工具リストを具体的に',
    '- カーペット: パンチカーペットのカット仕様（ロゴ部分の現場カット要）、 固定テープ位置、 4面への字 等',
    '- 電気: 通電開始時刻、 コンセント位置（ロゴボックス下 / 受付下 等）、 申請状況',
    '- 添付の パース図 / 平面図 / トラス図 / 配線図 を **必ず参照** して、 そのブース固有の配置・本数・寸法を反映',
    '- 担当者の動き、 必要人数、 持ち込み品リスト まで現場が困らないレベルで書く'
  ].join('\n') : '';

  const userPrompt = [
    '以下の案件の「' + cfg.displayName + '（初版）」を作成してください。',
    '',
    '## 文書の目的',
    cfg.purposeHint,
    '',
    '## 案件情報',
    '- クライアント: ' + c.clientName,
    '- 案件名: ' + c.caseName,
    '- 出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate),
    '- ブースサイズ: ' + (c.boothSize || '未確定'),
    detailRequirements,
    '',
    '## 出力形式（厳守・前後の説明文や ```json``` ブロック禁止）',
    cfg.outputSchema,
    '',
    '注意:',
    '- 案件情報に無い値（会場住所、車両台数、人員数、業者名、具体時刻等）は本文に書かず confirmations に「<項目名>の確定」として列挙。',
    '- 関連マニュアルが定める標準工程・チェックポイントは本文に必ず反映する。',
    '- 時間が未確定でも、出展期間から逆算した相対的なスケジュール（例: 設営=出展前日 / 撤去=最終日 18:00〜）は書いて良い。',
    '- 出展マニュアル PDF と 案件固有の設計資料 PDF（パース/平面/トラス/配線）の両方を参照し、 ブース固有の数字・位置を反映する。'
  ].join('\n');

  // 出展マニュアル PDF は cachedContext に抜粋テキスト済 → PDF は省略 (request 413 回避)
  // 設計資料 PDF のみ Claude に渡す
  const allDocs = designPdfs;
  const manualPdfs = []; // 廃止 (cachedContext 抜粋で代用)
  const res = ClaudeClient_call({
    cachedContext: cachedContext,
    userMessage: userPrompt,
    documents: allDocs,
    maxTokens: 16000  // reference-level detail で 12 セクション x 数 items 出ると 8000 では足りない
  });

  const parsed = _Phase1_parseJson(res.text);

  // Doc body 組み立て
  const bodyLines = [];
  bodyLines.push((parsed.title || cfg.displayName) + ' / ' + c.caseName + ' (' + c.clientName + ')');
  bodyLines.push('出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate));
  bodyLines.push('');
  if (planType === 'setup_teardown' && Array.isArray(parsed.sections)) {
    // 設計サマリ
    if (parsed.design_summary && typeof parsed.design_summary === 'object') {
      bodyLines.push('■ 設計サマリ');
      const ds = parsed.design_summary;
      const fields = [
        ['ブースサイズ', ds.booth_size],
        ['壁面・パネル', ds.wall_layout],
        ['トラス', ds.truss],
        ['カーペット', ds.carpet],
        ['電気', ds.electric],
        ['LEDUP', ds.ledup],
        ['ロゴボックス', ds.logo_box],
        ['モニター', ds.monitors]
      ];
      fields.forEach(function (f) {
        if (f[1]) bodyLines.push('  ・' + f[0] + ': ' + f[1]);
      });
      bodyLines.push('');
    }
    // アンカー打設用 工具リスト
    if (Array.isArray(parsed.anchor_tools) && parsed.anchor_tools.length > 0) {
      bodyLines.push('■ アンカー打設 必要工具');
      parsed.anchor_tools.forEach(function (g) {
        bodyLines.push('  【' + (g.category || '') + '】');
        (g.items || []).forEach(function (it) {
          bodyLines.push('    ・' + (typeof it === 'string' ? it : JSON.stringify(it)));
        });
      });
      bodyLines.push('');
    }
    // 各セクション
    parsed.sections.forEach(function (s) {
      bodyLines.push('■ ' + (s.heading || ''));
      (s.items || []).forEach(function (it) {
        bodyLines.push('  ・ ' + (typeof it === 'string' ? it : JSON.stringify(it)));
      });
      bodyLines.push('');
    });
  } else if (planType === 'logistics') {
    // 容積算出 + 自社便優先トラック選定 を先頭に挿入
    let volRes = null;
    try { volRes = Phase2_VolumeCalc_estimateTrucks(caseId); } catch (e) {
      bodyLines.push('■ 容積算出 (アイテムリスト未生成のためスキップ)');
      bodyLines.push('  ・ ' + e.toString());
      bodyLines.push('');
    }
    if (volRes) {
      bodyLines.push('■ 容積算出 (アイテムリスト → 備品マスタ AP列容積)');
      _Phase2_appendItemSourceLines(bodyLines, volRes);
      bodyLines.push('  ・ 品目数: ' + volRes.itemCount + ' (備品マスタ一致 ' + volRes.matchedCount + ' / 推定 ' + volRes.unmatchedCount + ')');
      bodyLines.push('  ・ 総容積: ' + volRes.totalVolumeM3 + ' m³（取得元: ' + (volRes.volumeSource || '不明') + '）');
      bodyLines.push('  ・ 安全係数 (' + volRes.safetyFactor + ' 倍): ' + volRes.withMarginM3 + ' m³');
      bodyLines.push('  ・ 自社便容量: ' + volRes.jishaCapacityM3 + ' m³ (キャラバン 7.59 + デュトロ 9.51)');
      bodyLines.push('  ・ 自社便のみで完結: ' + (volRes.isCoveredByJisha ? 'はい ✓' : 'いいえ — 追加トラック必要'));
      bodyLines.push('');
      bodyLines.push('■ トラック選定 (自社便先 / 残量を最小台数でカバー)');
      volRes.selectedTrucks.forEach(function (t, i) {
        bodyLines.push('  ' + (i + 1) + '. ' + t.name + ' (' + t.kind + ') — ' + t.capacity + ' m³');
      });
      bodyLines.push('  ・ 合計容量: ' + volRes.selectedTotalCapacityM3 + ' m³ / 積載率: ' + Math.round(volRes.fitRatio * 100) + '%');
      bodyLines.push('');
      let staffDrivers = null;
      try { staffDrivers = StaffDrivers_fetch(SpreadsheetApp.openById(c.zissiId)); } catch (e) {
        staffDrivers = { found: false, drivers: [], warnings: [] };
      }
      if (!staffDrivers.found) {
        bodyLines.push('■ ドライバー担当（スタッフリストが見つからないためスキップ）');
      } else {
        bodyLines.push('■ ドライバー担当（実施計画書のスタッフリストより自動取得）');
        const driverAssignments = StaffDrivers_matchToTrucks(staffDrivers.drivers, volRes.selectedTrucks.map(function (t) { return t.name; }));
        driverAssignments.forEach(function (driver) {
          let detail;
          if (!driver.assigned) {
            detail = '未アサイン ⚠ 要手配';
          } else {
            detail = driver.name + ' / ' + (driver.tel || '連絡先未登録 ⚠ スタッフリストに携帯番号を入れてください');
            if (driver.status) detail += '（' + driver.status + '）';
            if (driver.truckName === '(車両不明)' && driver.roleLabel) detail += '　※役割「' + driver.roleLabel + '」';
          }
          bodyLines.push('  ・ ' + _padRight(driver.truckName, 22) + detail);
        });
        staffDrivers.warnings.forEach(function (warning) { bodyLines.push('  ※ ' + warning); });
        bodyLines.push('');
        bodyLines.push('■ 搬入出車輌証（全車必要）');
        driverAssignments.forEach(function (driver) {
          bodyLines.push('  ・ ' + _padRight(driver.truckName, 22) + '印刷 → ' + (driver.assigned ? driver.name : '未アサイン') + 'へ配布済みか');
        });
      }
      bodyLines.push('');
      bodyLines.push('■ 車両外寸と駐車場要件 ⚠️ 駐車場を手配する前に必ず確認');
      volRes.selectedTrucks.forEach(function (t) {
        if (!t.exterior) return;
        const x = t.exterior;
        bodyLines.push('  ・ ' + _padRight(t.name, 22) + '全長' + x.lengthMm.toLocaleString('ja-JP') + ' × 全幅' + x.widthMm.toLocaleString('ja-JP') + ' × 全高' + x.heightMm.toLocaleString('ja-JP') + 'mm / 車両総重量' + x.gvwKg.toLocaleString('ja-JP') + 'kg' + (x.confirmed ? '' : '（代表値・実車要確認）'));
        if (x.note) bodyLines.push('      ※' + x.note);
      });
      bodyLines.push('');
      const parking = volRes.parkingRequirement;
      function roundedUp(value) { return (Math.ceil(value / 100) / 10).toFixed(1); }
      bodyLines.push('  【必要な駐車場条件】全長' + roundedUp(parking.maxLengthMm) + 'm以上 / 全幅' + roundedUp(parking.maxWidthMm) + 'm以上 / 高さ制限' + roundedUp(parking.maxHeightMm) + 'm以上または制限なし / 重量' + roundedUp(parking.maxGvwKg) + 't以上');
      if (parking.unknownTrucks.length > 0) {
        bodyLines.push('  【要確認】外寸が未登録の車両: ' + parking.unknownTrucks.join('、') + ' — 外寸・車両総重量を確認して TruckExteriorSpec.js に追加してください');
      }
      if (volRes.coinParkingCheck.ok) {
        bodyLines.push('  【判定】✅ 一般的なコインパーキングに入ります（ただし現地の制限表示は必ず確認）');
      } else {
        bodyLines.push('  【判定】❌ 一般的なコインパーキング(全長5m・全幅1.9m・全高2.1m・重量2.5t)には入りません');
        const labels = { lengthMm: '全長', widthMm: '全幅', heightMm: '全高', gvwKg: '車両総重量' };
        volRes.coinParkingCheck.violations.forEach(function (v) {
          bodyLines.push('      ・ ' + v.truck + ': ' + labels[v.field] + v.actual.toLocaleString('ja-JP') + (v.field === 'gvwKg' ? 'kg' : 'mm') + ' > ' + v.limit.toLocaleString('ja-JP') + (v.field === 'gvwKg' ? 'kg' : 'mm'));
        });
        bodyLines.push('      → 「高さ制限なし・平置き」の駐車場を手配してください');
      }
      bodyLines.push('');
      bodyLines.push('  【駐車場を押さえる前のチェックリスト】');
      bodyLines.push('  ・ 高さ制限なし（または上記の必要高さ以上）の平置きか — 立体・地下は不可');
      bodyLines.push('  ・ 重量制限が必要値以上か（コインパーキングは2.0〜2.5t制限が多い）');
      bodyLines.push('  ・ 24時間入出庫可か（会場駐車場は夜間閉鎖のことがある）');
      bodyLines.push('  ・ 連続駐車の上限時間（「連続駐車は最大48時間まで」等の規約に注意）');
      bodyLines.push('  ・ 台数分の枠を同一場所で確保できるか');
      bodyLines.push('');
      const searchCriteria = TruckExteriorSpec_parkingSearchCriteria(volRes.selectedTrucks.map(function (t) { return t.name; }));
      _Phase2_appendVenueParkingLines(bodyLines, c, volRes.selectedTrucks.map(function (t) { return t.name; }));
      bodyLines.push('■ 駐車場の探し方（前泊・待機で駐車場を使う場合）');
      bodyLines.push('  【車格】');
      volRes.selectedTrucks.forEach(function (t) {
        const x = TruckExteriorSpec_get(t.name);
        if (!x) return;
        let plateDescription = x.plateClass + 'ナンバー';
        if (t.name === 'デュトロ') plateDescription += '(小型貨物)';
        if (t.name === '日産キャラバン') plateDescription += '(特種・キャンピング車)';
        bodyLines.push('  ・ ' + t.name + ' … ' + plateDescription + ' / ' + x.licenseClass + ' / 駐車料金区分「' + x.parkingFeeClass + '」');
      });
      if (searchCriteria.hasEightNumber) {
        bodyLines.push('      ※8ナンバーは「大型車及び8ナンバーの車両お断り」の駐車場に入れません');
      }
      bodyLines.push('');
      const searchLengthCm = Math.ceil(searchCriteria.maxLengthMm / 100) * 10;
      const searchWidthCm = Math.max(190, Math.ceil(searchCriteria.maxWidthMm / 100) * 10);
      const searchHeightCm = Math.ceil(searchCriteria.requiredClearanceMm / 100) * 10;
      bodyLines.push('  【検索条件】全長' + searchLengthCm + 'cm以上 / 横幅' + searchWidthCm + 'cm以上 / 高さ制限なし（または' + searchHeightCm + 'cm以上）');
      bodyLines.push('  【必須】' + searchCriteria.mustHave.join(' / '));
      bodyLines.push('  【除外】' + searchCriteria.mustAvoid.join(' / '));
      bodyLines.push('  【確認】' + searchCriteria.checkPoints.join(' / '));
      bodyLines.push('');
      if (volRes.items && volRes.items.length > 0) {
        bodyLines.push('■ 容積内訳 (上位品目)');
        volRes.items.sort(function (a, b) { return b.totalVol - a.totalVol; }).slice(0, 12).forEach(function (it) {
          bodyLines.push('  ・ ' + it.name + ' × ' + it.qty + ' = ' + it.totalVol + ' m³ (' + it.source + ')');
        });
        bodyLines.push('');
      }
    }
    if (!Array.isArray(parsed.vehicles)) {
      bodyLines.push('(Claude vehicles 構造化パース失敗)');
      bodyLines.push(res.text);
    } else {
      parsed.vehicles.forEach(function (v, i) {
        bodyLines.push('■ 車両' + (i + 1) + ': ' + (v.label || '') + ' / ' + (v.purpose || ''));
        bodyLines.push('  発: ' + (v.departure || '未定'));
        bodyLines.push('  着: ' + (v.arrival || '未定'));
        bodyLines.push('  ドライバー: ' + (v.driver || '未定'));
        bodyLines.push('  積載:');
        (v.cargo || []).forEach(function (it) { bodyLines.push('    - ' + it); });
        bodyLines.push('');
      });
      if (Array.isArray(parsed.schedule_notes) && parsed.schedule_notes.length > 0) {
        bodyLines.push('■ 補足メモ');
        parsed.schedule_notes.forEach(function (m) { bodyLines.push('  ・ ' + m); });
        bodyLines.push('');
      }
    }
  } else {
    bodyLines.push('(構造化パース失敗 — Claude 生 textを掲載)');
    bodyLines.push('');
    bodyLines.push(res.text);
  }

  // 搬入出計画のみ: 詳細を zissi「搬入出計画」シート 21行目以降(A列)へ書き出す(kim 2026-08 指示)。
  // シートが無ければスキップ(Doc 出力は従来通り残す)。
  if (planType === 'logistics') {
    try {
      const zissiForOut = SpreadsheetApp.openById(c.zissiId);
      const hs = zissiForOut.getSheetByName('搬入出計画');
      if (hs) {
        const START = 21;
        const prevLast = Math.max(hs.getLastRow(), START);
        hs.getRange(START, 1, prevLast - START + 1, 1).clearContent();
        const outLines = bodyLines.filter(function (l) { return l != null; });
        if (outLines.length > 0) {
          hs.getRange(START, 1, outLines.length, 1).setValues(outLines.map(function (l) { return [String(l)]; }));
        }
      }
    } catch (e) { /* シート書き出しは best-effort。 Doc 出力は継続 */ }
  }

  // Doc 作成 + 案件 Drive フォルダへ移動
  const folderId = Case_resolveProjectRoot(c);
  const docName = c.caseId + '_' + c.caseName + '_' + cfg.docSuffix;
  const doc = DocumentApp.create(docName);
  doc.getBody().setText(bodyLines.join('\n'));
  doc.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(doc.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }

  // 確認事項
  if (parsed.confirmations && parsed.confirmations.length > 0) {
    const tagged = parsed.confirmations.map(function (x) {
      return { category: cfg.confirmCategoryPrefix + ' ' + (x.category || ''), content: x.content || '' };
    });
    ConfirmationSheet_appendItems(caseId, tagged, 2);
  }
  CaseList_touchUpdatedAt(caseId);

  const docUrl = DocumentApp.openById(doc.getId()).getUrl();
  MasterWriteBack_recordArtifact(caseId, cfg.displayName, parsed.title || cfg.displayName, docUrl);

  // Slides 版 (setup_teardown のみ): 同じ JSON から セクション毎 1 スライド + 図面サムネ埋込み
  // Slides 挿入は image/PDF/Slides/PPTX 全種対応 (Drive thumbnail endpoint)
  let slidesUrl = '';
  if (planType === 'setup_teardown') {
    try {
      const slidesResult = _Phase2_buildSetupTeardownSlides(c, parsed, allDesignDocs, folderId);
      slidesUrl = slidesResult.url;
      MasterWriteBack_recordArtifact(caseId, cfg.displayName + '（スライド版）',
        (parsed.title || cfg.displayName) + ' (Slides)', slidesUrl);
    } catch (e) {
      console.warn('Slides 生成失敗: ' + e.toString());
    }
  }

  return {
    planType: planType,
    planName: cfg.displayName,
    title: parsed.title || cfg.displayName,
    docUrl: docUrl,
    slidesUrl: slidesUrl,
    sectionCount: (parsed.sections || []).length,
    vehicleCount: (parsed.vehicles || []).length,
    confirmationCount: (parsed.confirmations || []).length,
    manualPagesUsed: manualPages.length,
    designPdfsUsed: designPdfs.map(function (p) { return p.label; }),
    usage: res.usage
  };
}

/**
 * 設営撤去手順 の Google Slides 版を生成。 Doc 版と同じ JSON を使い、
 * セクション毎 1 スライド + 関連 PDF サムネを所定スライドに埋込み。
 *
 * Slides 構成:
 *   Slide 1: タイトル (案件名 + 出展期間)
 *   Slide 2: 設計サマリ (design_summary 8 フィールド + パース図サムネ)
 *   Slide 3: アンカー打設 必要工具 (anchor_tools 6 カテゴリ)
 *   Slide 4..N: 各 sections の手順 + 関連 PDF サムネ (キーワードマッチ)
 *
 * PDF サムネ取得: Drive thumbnail エンドポイント (`drive.google.com/thumbnail?id=...`) を
 * OAuth トークン付きで fetch → blob → SlidesApp.insertImage。
 */
function _Phase2_buildSetupTeardownSlides(c, parsed, designFigures, folderId) {
  const title = parsed.title || (c.caseName + ' 設営撤去手順');
  const presName = c.caseId + '_' + c.caseName + '_設営撤去手順_スライド';
  const pres = SlidesApp.create(presName);

  // タイトルスライド (既存の default slide を再利用)
  const defaultSlide = pres.getSlides()[0];
  _Phase2_setSlidePlaceholders(defaultSlide,
    title,
    c.clientName + ' / ' + c.caseName +
    '\n出展期間: ' + _fmtDate(c.startDate) + ' 〜 ' + _fmtDate(c.endDate));

  // 設計サマリ
  if (parsed.design_summary) {
    const slide = pres.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
    const ds = parsed.design_summary;
    const labels = {
      booth_size: 'ブースサイズ', wall_layout: '壁面・パネル', truss: 'トラス',
      carpet: 'カーペット', electric: '電気', ledup: 'LEDUP',
      logo_box: 'ロゴボックス', monitors: 'モニター'
    };
    const lines = [];
    Object.keys(labels).forEach(function (k) {
      if (ds[k]) lines.push('• ' + labels[k] + ': ' + ds[k]);
    });
    _Phase2_setSlidePlaceholders(slide, '設計サマリ', lines.join('\n'));
    const persPdf = _Phase2_findFigureForSection('パース', designFigures);
    if (persPdf) _Phase2_insertThumbnail(slide, persPdf);
  }

  // アンカー打設 必要工具
  if (Array.isArray(parsed.anchor_tools) && parsed.anchor_tools.length > 0) {
    const slide = pres.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
    const lines = [];
    parsed.anchor_tools.forEach(function (g) {
      lines.push('【' + (g.category || '') + '】');
      (g.items || []).forEach(function (it) { lines.push('  • ' + it); });
    });
    _Phase2_setSlidePlaceholders(slide, 'アンカー打設 必要工具', lines.join('\n'));
  }

  // 各 section
  (parsed.sections || []).forEach(function (s) {
    const slide = pres.appendSlide(SlidesApp.PredefinedLayout.TITLE_AND_BODY);
    const lines = (s.items || []).map(function (it) {
      return '• ' + (typeof it === 'string' ? it : JSON.stringify(it));
    });
    _Phase2_setSlidePlaceholders(slide, s.heading || '', lines.join('\n'));
    const fig = _Phase2_findFigureForSection(s.heading || '', designFigures);
    if (fig) _Phase2_insertThumbnail(slide, fig);
  });

  pres.saveAndClose();
  if (folderId) {
    try { DriveApp.getFileById(pres.getId()).moveTo(DriveApp.getFolderById(folderId)); } catch (e) {}
  }
  return { id: pres.getId(), url: pres.getUrl() };
}

/**
 * スライドのタイトル+本文を埋める。 image を右半分に置く前提で:
 * - hasImage=true なら body を左半分 (x=20-420) に縮める
 * - フォント 10pt で 多くの行を収める (overflow 抑制)
 * 標準スライド 720×405pt (10×5.625in) 想定
 */
function _Phase2_setSlidePlaceholders(slide, titleText, bodyText, hasImage) {
  try {
    const phs = slide.getPlaceholders();
    let titleSet = false, bodySet = false;
    phs.forEach(function (ph) {
      try {
        const t = ph.getPlaceholderType();
        if (!titleSet && (t === SlidesApp.PlaceholderType.TITLE || t === SlidesApp.PlaceholderType.CENTERED_TITLE)) {
          const sh = ph.asShape();
          sh.getText().setText(titleText);
          // タイトル: 22pt 程度に
          try { sh.getText().getTextStyle().setFontSize(22); } catch (e) {}
          titleSet = true;
        } else if (!bodySet && (t === SlidesApp.PlaceholderType.BODY || t === SlidesApp.PlaceholderType.SUBTITLE)) {
          const sh = ph.asShape();
          sh.getText().setText(bodyText);
          if (hasImage) {
            // 左半分に縮める (image が右半分 x=430-710 と被らないように)
            try { sh.setLeft(20).setTop(70).setWidth(400).setHeight(320); } catch (e) {}
          } else {
            // 全幅でも余裕を持って
            try { sh.setLeft(20).setTop(70).setWidth(680).setHeight(320); } catch (e) {}
          }
          // 本文フォント縮小 (10pt) で overflow 抑制
          try { sh.getText().getTextStyle().setFontSize(10); } catch (e) {}
          bodySet = true;
        }
      } catch (e) {}
    });
    // Title 用 fallback (見つからなければ shape を直接挿入)
    if (!titleSet) {
      const tb = slide.insertTextBox(titleText, 20, 15, 680, 40);
      try { tb.getText().getTextStyle().setFontSize(22).setBold(true); } catch (e) {}
    }
    if (!bodySet) {
      const w = hasImage ? 400 : 680;
      const tb = slide.insertTextBox(bodyText, 20, 70, w, 320);
      try { tb.getText().getTextStyle().setFontSize(10); } catch (e) {}
    }
  } catch (e) {
    console.warn('setSlidePlaceholders failed: ' + e.toString());
  }
}

/**
 * セクション heading から 関連 図面/画像を探す。
 * マッチング: heading の キーワードで対応する figure を優先順に検索。
 * 1 つしか出さないと毎スライド同じ画像になりがちなので、 同じ figure を続けて使わないよう
 * usedIds で重複回避する (caller が usedIds 渡せば実装)
 */
function _Phase2_findFigureForSection(heading, designFigures) {
  if (!heading || !designFigures || designFigures.length === 0) return null;
  const rules = [
    { kw: /パース|デザイン|完成|外観|内観|サマリ/, match: /パース|レイアウト|ブースデザイン|デザイン|完成|イメージ|外観/i },
    { kw: /アンカー|床/, match: /アンカー|平面|小間|床|設営編|施工手順/i },
    { kw: /トラス/, match: /トラス|金具|LEDUP/i },
    { kw: /LED|LEDUP/, match: /LED|LEDUP|金具|トラス/i },
    { kw: /カーペット/, match: /カーペット|平面|小間|設営編|レイアウト/i },
    { kw: /壁面|パネル/, match: /パネル|レイアウト|平面|小間|金具/i },
    { kw: /電気|配線/, match: /配線|電気|コンセント|分電盤|平面/i },
    { kw: /ロゴ/, match: /ロゴ|レイアウト|平面/i },
    { kw: /設営|搬入/, match: /設営|施工手順|レイアウト|平面/i },
    { kw: /撤去|搬出/, match: /撤去|施工手順|レイアウト/i },
    { kw: /会期|運用|チェック/, match: /レイアウト|完成|施工手順/i },
    { kw: /測定|実測|採寸|寸法|現調|下見|検証/, match: /測定|実測|採寸|寸法|現調|下見|検証/i }
  ];
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].kw.test(heading)) {
      for (let j = 0; j < designFigures.length; j++) {
        if (rules[i].match.test(designFigures[j].label || '')) return designFigures[j];
      }
    }
  }
  return null;
}

/**
 * ファイル ID から サムネ blob を取得し スライドに挿入。
 * image/*: 直接 getBlob() で原寸 → サイズダウン不要
 * pdf/Slides/pptx: Drive thumbnail エンドポイント (1 ページ目)
 */
function _Phase2_insertThumbnail(slide, fig) {
  try {
    const fileId = typeof fig === 'string' ? fig : fig.driveFileId;
    const isImage = typeof fig === 'object' && fig.isImage;
    let blob;
    if (isImage) {
      // 画像ファイルは直接取得
      try { blob = DriveApp.getFileById(fileId).getBlob(); } catch (e) {}
    }
    if (!blob) {
      // それ以外は Drive thumbnail
      const url = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1600';
      const res = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) return;
      blob = res.getBlob();
    }
    // 右下に挿入 (スライドは 720×405pt 想定)
    slide.insertImage(blob, 430, 90, 280, 200);
  } catch (e) {
    console.warn('insertThumbnail failed: ' + e.toString());
  }
}

/**
 * 案件 project folder 配下から 設計資料 PDF (パース/平面/トラス/配線/アンカー/レイアウト) を採集。
 * 出展マニュアル / 申請書 / 申込書 は除外。 最大 maxFiles 件。
 */
function _Phase2_findDesignDocs(c) {
  const out = [];
  const seen = {};
  const baseFolderId = Case_resolveProjectRoot(c);
  if (!baseFolderId) return out;
  const designKeywords = /パース|レイアウト|ブースデザイン|デザイン|完成|イメージ|外観|内観|平面|図面|立面|配置図|小間|ゾーニング|zoning|ブース案|トラス|配線|電気|アンカー|施工図|什器|プラン|CAD|金具|LEDUP|実機|測定|実測|採寸|寸法|現調|下見|検証|寸法確認/i;
  const excludeKeywords = /出展マニュアル|主催者|出展規定|出展ガイド|申請|申込|提出フォーマット|見積|請求|スクリーンショット/;
  function walk(folderId, depth) {
    if (depth <= 0 || out.length >= 40) return;
    let folder;
    try { folder = DriveApp.getFolderById(folderId); } catch (e) { return; }
    const it = folder.getFiles();
    while (it.hasNext() && out.length < 40) {
      const f = it.next();
      const id = f.getId();
      if (seen[id]) continue;
      // Mac 由来ファイル名は濁点が NFD 分解されておりキーワード不一致になるため NFC 正規化
      const name = String(f.getName()).normalize('NFC');
      if (excludeKeywords.test(name)) continue;
      if (!designKeywords.test(name)) continue;
      const mt = f.getMimeType();
      const isImage = /^image\//.test(mt);
      const isPdf = mt === 'application/pdf';
      const isSlides = mt === 'application/vnd.google-apps.presentation';
      const isPptx = mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      if (!isImage && !isPdf && !isSlides && !isPptx) continue;
      seen[id] = true;
      let lastUpdated = 0;
      try { lastUpdated = f.getLastUpdated().getTime(); } catch (e) {}
      out.push({
        driveFileId: id, label: name, mimeType: mt,
        isPdf: isPdf, isImage: isImage, isSlides: isSlides, isPptx: isPptx,
        lastUpdated: lastUpdated
      });
    }
    const subs = folder.getFolders();
    while (subs.hasNext() && out.length < 40) {
      walk(subs.next().getId(), depth - 1);
    }
  }
  walk(baseFolderId, 4);
  // 同名系の古い版 ((1) / のコピー 等) を捨て、更新日時の新しい順で上位 15 件
  return Case_dedupeNewestFiles(out).slice(0, 15);
}

/**
 * 案件アイテムリスト + 全社共通 保有機材カタログ を文字列化。
 * Claude が 備品コード を引いて手順書に反映できる context。
 */
function _Phase2_loadItemListAndCatalog(c) {
  const blocks = [];
  // (1) zissi 内の Claude_アイテムリスト提案
  if (c.zissiId) {
    try {
      const ss = SpreadsheetApp.openById(c.zissiId);
      const sh = ss.getSheetByName(ITEMLIST_PROPOSAL_SHEET_NAME);
      if (sh) {
        const lastRow = Math.min(sh.getLastRow(), 200);
        if (lastRow >= 2) {
          const data = sh.getRange(1, 1, lastRow, Math.min(sh.getLastColumn(), 7)).getValues();
          const lines = ['--- 案件アイテムリスト (Claude_アイテムリスト提案) ---'];
          data.forEach(function (row) {
            const text = row.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' | ');
            if (text) lines.push(text);
          });
          blocks.push(lines.join('\n'));
        }
      }
    } catch (e) {}
  }
  // (2) app SS の 保有機材カタログ (備品コード参照)
  try {
    const appSs = SpreadsheetApp.getActive();
    const catSheet = appSs.getSheetByName('保有機材カタログ');
    if (catSheet) {
      const lastRow = Math.min(catSheet.getLastRow(), 200);
      if (lastRow >= 2) {
        const data = catSheet.getRange(1, 1, lastRow, Math.min(catSheet.getLastColumn(), 6)).getValues();
        const lines = ['--- 保有機材カタログ (備品コード参照) ---'];
        data.forEach(function (row) {
          const text = row.map(function (v) { return String(v || '').trim(); }).filter(Boolean).join(' | ');
          if (text) lines.push(text);
        });
        blocks.push(lines.join('\n'));
      }
    }
  } catch (e) {}
  return blocks.join('\n\n');
}

/**
 * 文字列の表示幅（全角=2、半角=1）を計算し、目標の幅に達するまで右パディング（スペース）を付与する。
 */
function _padRight(str, targetWidth) {
  var w = 0;
  for (var i = 0; i < str.length; i++) {
    w += (str.charCodeAt(i) <= 0x7f) ? 1 : 2;
  }
  var pad = '';
  var needed = Math.max(2, targetWidth - w);
  for (var j = 0; j < needed; j++) {
    pad += ' ';
  }
  return str + pad;
}

function _Phase2_appendItemSourceLines(lines, volRes) {
  lines.push('  ・ 積荷の正本: ' + (volRes.itemSheetUsed || '不明'));
  if (volRes.itemSourceIsProposal) lines.push('⚠️ 本表「アイテムリスト」が未作成のため AI提案シートで暫定計算しています。積荷は要確認');
  if (volRes.qtyHeaderNotFound) lines.push('⚠️ 数量列（現場必要数）のヘッダーを検出できませんでした。アイテムリストのヘッダー行を確認してください');
  if (volRes.nameHeaderNotFound) lines.push('⚠️ 品名列のヘッダーを検出できませんでした。アイテムリストのヘッダー行を確認してください');
}

function _Phase2_appendVenueParkingLines(lines, c, truckNames) {
  var venue = String(c.venue || '').trim();
  if (!venue) {
    try {
      if (c.masterSsId && c.masterCol) venue = SpreadsheetApp.openById(c.masterSsId).getSheetByName('task').getRange(3, c.masterCol).getDisplayValue();
    } catch (e) { venue = ''; }
  }
  var recommendation = VenueParkingSpec_recommendFor(venue, truckNames);
  if (!recommendation.matched) return;
  lines.push('■ 推奨駐車場（過去実地検証済み・' + recommendation.venue + '）');
  recommendation.ok.forEach(function (p) {
    lines.push('  【' + p.rank + '】' + p.name + ' / ' + (p.address || '住所未確認') + ' / ' + (p.feeText || '料金未確認') + ' / ' + p.surface + '・' + (p.capacity == null ? '台数未確認' : p.capacity + '台可'));
    lines.push('      判定: ' + truckNames.map(function (name) { return name + (p.lengthMm == null || p.widthMm == null ? ' 要確認（寸法等の未確認項目あり）' : ' ○（記録済み条件）'); }).join(' / '));
    if (p.url) lines.push('      ' + p.url);
    lines.push('      ※検証日 ' + p.verifiedOn + '。対象日の空き状況は必ず事前確認（' + (p.reservationRequired ? '予約制' : '予約不要・先着') + '）');
    lines.push('      ※' + p.note);
  });
  recommendation.ng.forEach(function (entry) {
    lines.push('  【選定車両では利用不可】' + entry.candidate.name + ' — ' + entry.ng.join(' / '));
  });
  recommendation.knownUnusable.forEach(function (entry) {
    lines.push('  【使用不可として記録済み】' + entry.name + ' — ' + entry.reason);
  });
  lines.push('');
}
