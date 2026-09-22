/**
 * 備品在庫管理表 の AP 列 (1個容積 m³) を 自動投入し、
 * 案件アイテムリストから全体容積を算出してトラックを自社便優先で選定する。
 *
 * マスター: 1QCW86DIri6nryqheFKw8Cr6e9Ce0YRV6FvFFW0zqBnc / 備品在庫管理表 (gid 935442052)
 *   D 列 = 品名 / R 列 = サイズ縦 / S 列 = サイズ横 / T 列 = サイズ高さ / AP 列 = 容積
 *
 * トラック表: 1_zbmz8LReBsLRynQ7oIxdyXEwzw7mMnnbULsQcAFfio / 搬入出計画 (gid 375728639)
 *   M17:T 行に トラック / 種類 / 長さ / 幅 / 高さ / 容積 (m³)
 *   デュトロ → 自社便2台 → デュトロ＋レンタル の順に判定
 */

const PHASE2_DUTRO_CAPACITY = 9.51;
const PHASE2_CARAVAN_CAPACITY = 7.59;
const PHASE2_EXTRA_TRUCKS = [
    { name: '4トン フルワイド箱車', kind: 'レンタル', capacity: 35.49 },
    { name: '4トン セミワイド箱車', kind: 'レンタル', capacity: 31.79 },
    { name: '4トン 標準箱車', kind: 'レンタル', capacity: 29.71 },
    { name: '2トン ワイドロング箱車', kind: 'レンタル', capacity: 18.0 },
    { name: '2トン ロング箱車', kind: 'レンタル', capacity: 15.05 },
    { name: '2トン ショート箱車', kind: 'レンタル', capacity: 9.19 },
    { name: '軽トラック ハイルーフ', kind: 'レンタル', capacity: 5.47 },
    { name: '軽トラック 標準', kind: 'レンタル', capacity: 3.53 }
  ];

/** LogisticsFormula.js と同じ優先順位。最大クラス超過時は同クラス複数台。 */
function Phase2_selectTrucks(withMarginM3) {
  if (typeof withMarginM3 !== 'number' || !isFinite(withMarginM3) || withMarginM3 < 0) throw new Error('容積は有限の非負数で指定してください');
  var selected = [{ name: 'デュトロ', kind: '自社便', capacity: PHASE2_DUTRO_CAPACITY }];
  var mode = 'dutro_only', rental = 0;
  if (withMarginM3 > PHASE2_DUTRO_CAPACITY) {
    if (withMarginM3 <= PHASE2_DUTRO_CAPACITY + PHASE2_CARAVAN_CAPACITY) {
      selected.push({ name: '日産キャラバン', kind: '自社便', capacity: PHASE2_CARAVAN_CAPACITY });
      mode = 'jisha_both';
    } else {
      mode = 'dutro_plus_rental';
      rental = Math.round((withMarginM3 - PHASE2_DUTRO_CAPACITY) * 1000000) / 1000000;
      var chosen = PHASE2_EXTRA_TRUCKS[0];
      PHASE2_EXTRA_TRUCKS.forEach(function (t) { if (t.capacity >= rental) chosen = t; });
      var count = Math.min(29, Math.ceil(rental / chosen.capacity));
      for (var i = 0; i < count; i++) selected.push({ name: chosen.name, kind: chosen.kind, capacity: chosen.capacity });
    }
  }
  return { selectedTrucks: selected, isCoveredByJisha: rental === 0, rentalNeededM3: rental, mode: mode };
}

const BIHIN_MASTER_SS_ID = '1QCW86DIri6nryqheFKw8Cr6e9Ce0YRV6FvFFW0zqBnc';
const BIHIN_MASTER_GID = 935442052;
const BIHIN_DATA_START_ROW = 4; // ヘッダーは row 3、 データは row 4 から
const BIHIN_COL_NAME = 4;       // D
const BIHIN_COL_CATEGORY = 7;   // G
const BIHIN_COL_SIZE_VERT = 18; // R
const BIHIN_COL_SIZE_HORZ = 19; // S
const BIHIN_COL_SIZE_HEIGHT = 20; // T
const BIHIN_COL_VOLUME = 42;    // AP

const LOGISTICS_SS_ID = '1_zbmz8LReBsLRynQ7oIxdyXEwzw7mMnnbULsQcAFfio';
const LOGISTICS_GID = 375728639;

/**
 * 備品在庫管理表 AP 列 (容積) を全行自動算出して書き込み。
 * - R/S/T (mm) が揃っている → R×S×T / 1e9 = m³
 * - 不揃いなら D 列 (品名) を 正規表現で W×D×H 抽出
 * - 抽出失敗時は カテゴリ別の推定値 (フォールバック)
 * 既存値 (空でない) は上書きしない (手入力を尊重)。
 *
 * @return {object} { totalRows, filledCount, skippedExisting, fallbackEstimateCount, sample }
 */
function Phase2_BihinVolume_fillAP(forceOverwrite) {
  const ss = SpreadsheetApp.openById(BIHIN_MASTER_SS_ID);
  let sheet = null;
  ss.getSheets().forEach(function (s) { if (s.getSheetId() === BIHIN_MASTER_GID) sheet = s; });
  if (!sheet) throw new Error('備品在庫管理表 sheet (gid=' + BIHIN_MASTER_GID + ') not found');

  const lastRow = sheet.getLastRow();
  const rowCount = lastRow - BIHIN_DATA_START_ROW + 1;
  if (rowCount <= 0) return { error: 'no data rows' };

  // 必要 6 列を一括取得 (D, G, R, S, T, AP)
  // D=4, G=7, R=18, S=19, T=20, AP=42
  // batch 範囲: D 〜 AP (39 列) で読み込み → 必要 index だけ参照
  const blockWidth = BIHIN_COL_VOLUME - BIHIN_COL_NAME + 1; // D..AP
  const block = sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_NAME, rowCount, blockWidth).getValues();
  // 元 AP 列の値 (上書き判定用)
  const existingVolumes = block.map(function (r) { return r[blockWidth - 1]; });

  let filled = 0, skipped = 0, fallback = 0;
  const sample = [];
  const newAp = block.map(function (row, i) {
    const existing = existingVolumes[i];
    // 既存値 (数値 > 0 or "計算不要" 等の文字列) は上書きしない
    // forceOverwrite=true なら既存も再計算 (estimate ロジック更新時に使用)
    if (!forceOverwrite && existing !== '' && existing !== null && existing !== 0) {
      skipped++;
      return [existing];
    }
    const name = String(row[BIHIN_COL_NAME - BIHIN_COL_NAME] || '');
    const category = String(row[BIHIN_COL_CATEGORY - BIHIN_COL_NAME] || '');
    const v = Number(row[BIHIN_COL_SIZE_VERT - BIHIN_COL_NAME] || 0);
    const h = Number(row[BIHIN_COL_SIZE_HORZ - BIHIN_COL_NAME] || 0);
    const z = Number(row[BIHIN_COL_SIZE_HEIGHT - BIHIN_COL_NAME] || 0);

    let volume = 0;
    let source = '';
    if (!name && !v && !h && !z) {
      // 空行 → スキップ
      skipped++;
      return [existing || ''];
    }

    if (v > 0 && h > 0 && z > 0) {
      // mm * mm * mm / 10^9 = m^3
      volume = (v * h * z) / 1e9;
      source = 'RST';
    } else {
      // 品名から W×D×H パターン抽出
      const dims = _parseDimensionsFromName(name);
      if (dims) {
        volume = (dims.w * dims.d * dims.h) / 1e9;
        source = 'name';
      } else {
        // 推定値 (分類別)
        volume = _estimateVolumeByCategory(category, name);
        source = 'estimate';
        fallback++;
      }
    }
    // 1 m³ 超は外れ値疑い (構造物以外で発生したら確認用に半減)
    if (volume > 5 && source !== 'RST' && !/トラス|LED|パネル|フロアタイル|什器|テーブル|カウンター/.test(name)) {
      volume = volume / 2;
      source += '-capped';
    }
    // 4 桁有効数字に丸める
    volume = Math.round(volume * 10000) / 10000;
    filled++;
    if (sample.length < 8) {
      sample.push({ row: BIHIN_DATA_START_ROW + i, name: name.slice(0, 30), v: v, h: h, z: z, volume: volume, source: source });
    }
    return [volume];
  });

  // AP 列に一括書き込み
  sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_VOLUME, rowCount, 1).setValues(newAp);
  SpreadsheetApp.flush();

  // read-back verify (先頭 10 行)
  const readBack = sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_VOLUME, Math.min(10, rowCount), 1).getValues();
  return {
    totalRows: rowCount,
    filledCount: filled,
    skippedExisting: skipped,
    fallbackEstimateCount: fallback,
    sample: sample,
    readBackTop10: readBack.map(function (r) { return r[0]; })
  };
}

/**
 * AP 列が estimate fallback (一律 0.005) になっている品目を Claude API で個別容積推定し、
 * AP 列を上書きする。 R/S/T 実寸入力済みの 190 件は触らない。
 *
 * 進捗保存: Script Properties.BIHIN_AP_REFINE_OFFSET にバッチ index を保存し、
 *           次回呼び出しでレジューム可能。 全完了で 0 にリセット。
 *
 * @param {number} maxBatches このコマンド内で処理するバッチ上限 (default 30, Apps Script 6 分制限考慮)
 * @return {object} {totalTargets, batchCount, offsetBefore, offsetAfter, updates, isDone}
 */
function Phase2_BihinVolume_refineWithClaude(maxBatches) {
  const BATCH_SIZE = 50;
  const MAX_BATCHES_PER_RUN = maxBatches || 30;

  const ss = SpreadsheetApp.openById(BIHIN_MASTER_SS_ID);
  let sheet = null;
  ss.getSheets().forEach(function (s) { if (s.getSheetId() === BIHIN_MASTER_GID) sheet = s; });
  if (!sheet) throw new Error('master sheet not found');

  const lastRow = sheet.getLastRow();
  const rowCount = lastRow - BIHIN_DATA_START_ROW + 1;
  const blockWidth = BIHIN_COL_VOLUME - BIHIN_COL_NAME + 1;
  const block = sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_NAME, rowCount, blockWidth).getValues();

  // estimate fallback ターゲット抽出: AP == 0.005 かつ R/S/T 全空
  const targets = [];
  for (let i = 0; i < block.length; i++) {
    const name = String(block[i][0] || '').trim();
    const v = Number(block[i][BIHIN_COL_SIZE_VERT - BIHIN_COL_NAME] || 0);
    const h = Number(block[i][BIHIN_COL_SIZE_HORZ - BIHIN_COL_NAME] || 0);
    const z = Number(block[i][BIHIN_COL_SIZE_HEIGHT - BIHIN_COL_NAME] || 0);
    const ap = Number(block[i][BIHIN_COL_VOLUME - BIHIN_COL_NAME] || 0);
    if (name && v === 0 && h === 0 && z === 0 && Math.abs(ap - 0.005) < 0.0001) {
      targets.push({ row: BIHIN_DATA_START_ROW + i, name: name });
    }
  }

  const batchCount = Math.ceil(targets.length / BATCH_SIZE);
  const props = PropertiesService.getScriptProperties();
  let offset = Number(props.getProperty('BIHIN_AP_REFINE_OFFSET') || 0);
  const startBatch = offset;
  const endBatch = Math.min(startBatch + MAX_BATCHES_PER_RUN, batchCount);

  // 一括取得した AP 列値 (書き戻し用)
  const fullAp = sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_VOLUME, rowCount, 1).getValues();
  let updatesCount = 0;
  const failed = [];

  for (let b = startBatch; b < endBatch; b++) {
    const batch = targets.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    if (batch.length === 0) break;
    const prompt =
      '以下は展示会ブース制作の備品リストです。 各品目の 1個あたりの梱包輸送時容積を m³ で推定し、 JSON 配列で返してください。\n' +
      '基準値の目安:\n' +
      '  - ネジ・釘・ボルト・ナット・ワッシャー (1本/1個): 0.00005-0.0005\n' +
      '  - テープ・養生材・小物文具・薬品・電池 (1巻/1本): 0.0005-0.005\n' +
      '  - 名刺・チラシ・印刷物 (1枚): 0.00001-0.0001\n' +
      '  - 工具・電子小物・USB等 (1個): 0.001-0.02\n' +
      '  - ファイル・段ボール箱 1個: 0.01-0.05\n' +
      '  - 中型機器 (モニター・スタンド・椅子・スピーカー): 0.05-0.3\n' +
      '  - 大型構造物 (トラス本体・LEDUPパネル・什器・カウンター・展示台・ハイテーブル): 0.3-2.0\n' +
      '注意: 品名に「ボルト式シルバートラス用」「LEDUP固定用」等の親構造物名が混入していても、 単体の容積を推定すること。 例: 「ボルト式シルバートラス用 M10 ナット」は ナット1個 (0.0001 m³) であって トラスではない。\n\n' +
      '応答形式: JSON 配列のみ (前後の説明文・コードブロック禁止)\n' +
      '形式: [{"i":0,"v":0.001},{"i":1,"v":0.05}, ...]  i は下記リストの番号、 v は m³\n\n' +
      batch.map(function (t, idx) { return idx + ': ' + t.name.slice(0, 80); }).join('\n');

    try {
      const res = ClaudeClient_call({ userMessage: prompt, maxTokens: 4000 });
      let text = (res.text || '').trim();
      const m = text.match(/\[[\s\S]*\]/);
      if (m) text = m[0];
      const result = JSON.parse(text);
      result.forEach(function (r) {
        const idx = r.i;
        const vol = Number(r.v);
        if (typeof idx !== 'number' || isNaN(vol) || vol <= 0 || vol > 5) return;
        if (idx < 0 || idx >= batch.length) return;
        const masterOffset = batch[idx].row - BIHIN_DATA_START_ROW;
        fullAp[masterOffset][0] = Math.round(vol * 10000) / 10000;
        updatesCount++;
      });
    } catch (e) {
      failed.push({ batch: b, error: e.toString().slice(0, 100) });
    }
  }

  // AP 列を一括書き戻し
  sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_VOLUME, rowCount, 1).setValues(fullAp);
  SpreadsheetApp.flush();

  // 進捗保存
  const isDone = endBatch >= batchCount;
  props.setProperty('BIHIN_AP_REFINE_OFFSET', isDone ? '0' : String(endBatch));

  // read-back verify (10 サンプル)
  const sampleRows = [];
  for (let s = 0; s < Math.min(10, updatesCount); s++) {
    const t = targets[Math.min(startBatch * BATCH_SIZE + s, targets.length - 1)];
    const apVal = sheet.getRange(t.row, BIHIN_COL_VOLUME).getValue();
    sampleRows.push({ row: t.row, name: t.name.slice(0, 40), apAfter: apVal });
  }

  return {
    totalTargets: targets.length,
    batchCount: batchCount,
    offsetBefore: startBatch,
    offsetAfter: endBatch,
    updates: updatesCount,
    failedBatches: failed.length,
    failedDetail: failed.slice(0, 3),
    isDone: isDone,
    nextRunWillResume: !isDone,
    sampleReadBack: sampleRows
  };
}

/**
 * 布製品 (布・カーテン・テーブルクロス・タペストリー・のれん・ファブリック等) の AP を
 * 「厚み 1mm 前提 (折り畳み収納)」 で再推定して上書き。
 *
 * 背景: _parseDimensionsFromName で 2 軸 W×H 抽出時に d=100mm デフォルトを使っており、
 *       布関連は実態 1mm 厚 ≒ 折り畳み収納なので過大評価されている (10cm → 1mm の 100倍)。
 *
 * @return {object} {targetCount, batchCount, updates, sampleReadBack}
 */
function Phase2_BihinVolume_refineCloth() {
  const BATCH_SIZE = 50;
  const ss = SpreadsheetApp.openById(BIHIN_MASTER_SS_ID);
  let sheet = null;
  ss.getSheets().forEach(function (s) { if (s.getSheetId() === BIHIN_MASTER_GID) sheet = s; });
  if (!sheet) throw new Error('master sheet not found');

  const lastRow = sheet.getLastRow();
  const rowCount = lastRow - BIHIN_DATA_START_ROW + 1;
  const blockWidth = BIHIN_COL_VOLUME - BIHIN_COL_NAME + 1;
  const block = sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_NAME, rowCount, blockWidth).getValues();

  // 布関連キーワードでターゲット抽出
  const CLOTH_PATTERN = /布|カーテン|のれん|タペストリー|テーブルクロス|テーブルカバー|ナプキン|旗|バナー|ファブリック|fabric|cloth|クロス|ドレープ|スカート|シーツ|ベール|フェルト|タオル|手拭|風呂敷|シーティング|養生シート(?!.*段ボール)|モール|フリル/i;
  const targets = [];
  for (let i = 0; i < block.length; i++) {
    const name = String(block[i][0] || '').trim();
    if (!name) continue;
    const ap = Number(block[i][BIHIN_COL_VOLUME - BIHIN_COL_NAME] || 0);
    if (CLOTH_PATTERN.test(name) && ap > 0) {
      targets.push({ row: BIHIN_DATA_START_ROW + i, name: name, apBefore: ap });
    }
  }

  if (targets.length === 0) {
    return { targetCount: 0, batchCount: 0, updates: 0, sampleReadBack: [], note: '布関連品目が見つかりませんでした' };
  }

  const batchCount = Math.ceil(targets.length / BATCH_SIZE);
  const fullAp = sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_VOLUME, rowCount, 1).getValues();
  let updatesCount = 0;
  const failed = [];

  for (let b = 0; b < batchCount; b++) {
    const batch = targets.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const prompt =
      '以下は展示会・イベント制作の備品リスト中の「布製品 (布・カーテン・テーブルクロス等)」です。\n' +
      '輸送・保管時は折り畳んで収納するため、 1枚あたり梱包後の容積を以下の前提で推定してください:\n' +
      '  - 厚み (折り畳み後): 1mm を基本、 厚手の生地でも数 mm 程度\n' +
      '  - 縦・横: 折り畳み後 30〜50cm 角を基本\n' +
      '  - 例: テーブルクロス 1枚 → 約 0.001-0.003 m³ (300×300×30mm 程度)\n' +
      '  - 例: バナー (大型) 1枚 → 約 0.005-0.01 m³\n' +
      '  - 例: カーテン (大型遮光) 1枚 → 約 0.003-0.008 m³\n' +
      '  - 例: 養生シート (布製) 1枚 → 約 0.002-0.005 m³\n' +
      '  - モール・フリル等の装飾 → 1巻 0.001-0.005 m³\n\n' +
      '応答形式: JSON 配列のみ (前後の説明文・コードブロック禁止)\n' +
      '形式: [{"i":0,"v":0.001},{"i":1,"v":0.005}, ...]  i は下記リストの番号、 v は m³\n\n' +
      batch.map(function (t, idx) { return idx + ': ' + t.name.slice(0, 80); }).join('\n');

    try {
      const res = ClaudeClient_call({ userMessage: prompt, maxTokens: 4000 });
      let text = (res.text || '').trim();
      const m = text.match(/\[[\s\S]*\]/);
      if (m) text = m[0];
      const result = JSON.parse(text);
      result.forEach(function (r) {
        const idx = r.i;
        const vol = Number(r.v);
        if (typeof idx !== 'number' || isNaN(vol) || vol <= 0 || vol > 1) return;
        if (idx < 0 || idx >= batch.length) return;
        const masterOffset = batch[idx].row - BIHIN_DATA_START_ROW;
        fullAp[masterOffset][0] = Math.round(vol * 10000) / 10000;
        batch[idx].apAfter = fullAp[masterOffset][0];
        updatesCount++;
      });
    } catch (e) {
      failed.push({ batch: b, error: e.toString().slice(0, 100) });
    }
  }

  sheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_VOLUME, rowCount, 1).setValues(fullAp);
  SpreadsheetApp.flush();

  // read-back sample
  const sampleReadBack = targets.slice(0, 15).map(function (t) {
    return {
      row: t.row,
      name: t.name.slice(0, 50),
      before: t.apBefore,
      after: t.apAfter || sheet.getRange(t.row, BIHIN_COL_VOLUME).getValue()
    };
  });

  return {
    targetCount: targets.length,
    batchCount: batchCount,
    updates: updatesCount,
    failedBatches: failed.length,
    failedDetail: failed.slice(0, 3),
    sampleReadBack: sampleReadBack
  };
}

/**
 * 品名から W×D×H パターン抽出。
 * "W3000×H2980" / "3000×1500×500" / "φ900×H1200" / "直径900 H1200" などに対応。
 * 返り値: {w, d, h} (単位 mm) または null
 */
function _parseDimensionsFromName(name) {
  if (!name) return null;
  const s = String(name).replace(/[Ｗｗ]/g, 'W').replace(/[ＨｈＤｄ]/g, function (c) {
    return c === 'Ｄ' || c === 'ｄ' ? 'D' : 'H';
  });
  // パターン 1: 3 軸 数字×数字×数字 (mm 想定)
  let m = s.match(/(\d{2,5})\s*[×x✕＊\*]\s*(\d{2,5})\s*[×x✕＊\*]\s*(\d{2,5})/);
  if (m) return { w: Number(m[1]), d: Number(m[2]), h: Number(m[3]) };
  // パターン 2: W{n}×H{n} (奥行不明 → 100mm 仮定)
  m = s.match(/W\s*(\d{2,5}).*?H\s*(\d{2,5})/);
  if (m) return { w: Number(m[1]), d: 100, h: Number(m[2]) };
  // パターン 3: φ{n}×H{n} or 直径{n} (円柱)
  m = s.match(/[φΦ]\s*(\d{2,5}).*?H\s*(\d{2,5})/);
  if (m) {
    const r = Number(m[1]) / 2;
    return { w: Math.round(Math.PI * r * r / 1000), d: 1000, h: Number(m[2]) };
  }
  m = s.match(/直径\s*(\d{2,5}).*?H\s*(\d{2,5})/);
  if (m) {
    const r = Number(m[1]) / 2;
    return { w: Math.round(Math.PI * r * r / 1000), d: 1000, h: Number(m[2]) };
  }
  // パターン 4: 2 軸 W×H (奥行不明 → 100mm 仮定)
  m = s.match(/(\d{2,5})\s*[×x]\s*(\d{2,5})/);
  if (m && Number(m[1]) > 30 && Number(m[2]) > 30) {
    return { w: Number(m[1]), d: 100, h: Number(m[2]) };
  }
  return null;
}

/**
 * カテゴリ・名前から容積 (m³) を推定。 サイズ不明品目用フォールバック。
 *
 * 重要: マスタ品名にはしばしば 「ボルト式シルバートラス用 ボルト」 のように
 * 親構造物名が混入する → regex で 「トラス」 マッチ → ボルト1個が 0.3 m³ などの
 * 致命的誤判定を起こす。 そこで estimate は 一律 0.005 m³ で押し下げる方針。
 *
 * 大型構造物 (トラス・LEDUP・什器等) の正確な容積は R/S/T 列の手入力に依存する。
 * estimate fallback はあくまで「不明品」扱いの小さな保守値。
 */
function _estimateVolumeByCategory(category, name) {
  // 一律 0.005 m³ (5L) で押し下げ。 大型構造物は R/S/T 入力で個別精緻化前提。
  return 0.005;
}

/**
 * 案件のアイテムリスト全体容積を計算 + 自社便優先トラック選定。
 *
 * 流れ:
 *   1) zissi の Claude_アイテムリスト提案 シートを読む (品名 + 数量)
 *   2) 備品在庫管理表 D 列で品名マッチ → AP 列容積取得
 *   3) マッチしない品目は spec から容積推定 (上記 helper を再利用)
 *   4) 総容積 × 安全係数 1.3 (積載効率)
 *   5) 自社便 (キャラバン 7.59 + デュトロ 9.51 = 17.10 m³) 優先
 *      不足分を 4t > 2t > 軽 の順で 最小台数選定
 *
 * @param {string} caseId
 * @return {object} { items, totalVolume, withMargin, selectedTrucks, isCoveredByJisha, ... }
 */
/** zissi「アイテムリスト」シートの AF1（容積合計セル）を数値で読む。無効なら null。 */
function _Phase2_readItemListAF1(zissi) {
  try {
    var s = Zissi_findItemListSheet(zissi);
    if (!s) return null;
    var v = s.getRange('AF1').getValue();
    var n = Number(String(v).replace(/[,\s㎥㎥m³]/g, ''));
    return (isFinite(n) && n > 0) ? n : null;
  } catch (e) { return null; }
}

/** 実施計画から Claude 生成物ではない「アイテムリスト」シートを探す。 */
function Zissi_findItemListSheet(zissiSs) {
  var sheet = zissiSs.getSheetByName('アイテムリスト');
  if (!sheet) {
    sheet = zissiSs.getSheets().filter(function (s) {
      var n = s.getName();
      return n.indexOf('アイテムリスト') >= 0 && n.indexOf('Claude_') < 0;
    })[0];
  }
  return sheet || null;
}

/** 実施計画の既存「アイテムリスト」から品名と数量を読む。 */
function Zissi_readExistingItemList(zissiSs) {
  var sheet = Zissi_findItemListSheet(zissiSs);
  return Zissi_parseItemListValues(sheet && sheet.getLastRow() && sheet.getLastColumn()
    ? sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues() : []);
}

/** 列・行 index は 0 始まり。未検出は -1。数量候補は配列順に優先。 */
function Zissi_parseItemListValues(raw) {
  var NAME_HEADERS = ['品名', '品目', 'アイテム名', '品目名', 'item', 'name'];
  var QTY_HEADERS = ['現場必要数', '現場数', '数量', '個数', '必要数', 'qty', 'quantity'];
  var headers = (raw || []).slice(0, 5).map(function (row) {
    return row.map(function (v) { return String(v == null ? '' : v).trim().toLowerCase(); });
  });
  function detect(choices) {
    for (var h = 0; h < choices.length; h++) {
      for (var r = 0; r < headers.length; r++) {
        var col = headers[r].indexOf(choices[h]);
        if (col >= 0) return { row: r, col: col };
      }
    }
    return { row: -1, col: -1 };
  }
  var name = detect(NAME_HEADERS), qty = detect(QTY_HEADERS);
  var result = { items: [], qtyHeaderNotFound: qty.col < 0, nameHeaderNotFound: name.col < 0,
    headerRowIndex: Math.max(name.row, qty.row), nameCol: name.col, qtyCol: qty.col };
  if (result.qtyHeaderNotFound || result.nameHeaderNotFound) return result;
  var specCol = detect(['仕様', '仕様/サイズ']).col;
  var categoryCol = detect(['分類', 'カテゴリ']).col;
  raw.slice(result.headerRowIndex + 1).forEach(function (row) {
    var n = String(row[name.col] || '').trim();
    var value = row[qty.col];
    var q = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (n && isFinite(q) && q > 0) {
      var item = { name: n, qty: q };
      if (specCol >= 0) item.spec = String(row[specCol] || '');
      if (categoryCol >= 0) item.category = String(row[categoryCol] || '');
      result.items.push(item);
    }
  });
  return result;
}

function Phase2_VolumeCalc_estimateTrucks(caseId) {
  const c = CaseList_getById(caseId);
  if (!c) throw new Error('案件が見つかりません: ' + caseId);
  if (!c.zissiId) throw new Error('zissi 未設定: ' + caseId);

  // 本表を正本とし、有効行がない場合だけ提案を暫定利用する。
  const zissi = SpreadsheetApp.openById(c.zissiId);
  const existing = Zissi_readExistingItemList(zissi);
  let itemData = existing.items;
  let itemSourceIsProposal = false;
  const existingSheet = Zissi_findItemListSheet(zissi);
  let itemSheetUsed = existingSheet ? existingSheet.getName() : '';
  if (itemData.length === 0) {
    const proposal = zissi.getSheetByName(ITEMLIST_PROPOSAL_SHEET_NAME);
    if (proposal && proposal.getLastRow() >= 2) {
      itemData = Zissi_parseItemListValues(proposal.getRange(1, 1, proposal.getLastRow(), proposal.getLastColumn()).getValues()).items;
      itemSourceIsProposal = true;
      itemSheetUsed = proposal.getName();
    }
  }
  if (itemData.length === 0) {
    throw new Error('アイテムリストに有効な積荷がありません。' +
      (existing.qtyHeaderNotFound ? '⚠️ 数量列（現場必要数）のヘッダーを検出できませんでした。アイテムリストのヘッダー行を確認してください' : '') +
      (existing.nameHeaderNotFound ? ' 品名列のヘッダーを検出できませんでした。' : ''));
  }

  // 2) 備品マスタ全件読込み (品名 → 容積 map)
  const bihinSs = SpreadsheetApp.openById(BIHIN_MASTER_SS_ID);
  let bihinSheet = null;
  bihinSs.getSheets().forEach(function (s) { if (s.getSheetId() === BIHIN_MASTER_GID) bihinSheet = s; });
  if (!bihinSheet) throw new Error('備品在庫管理表 not found');
  const bihinLastRow = bihinSheet.getLastRow();
  const bihinBlock = bihinSheet.getRange(BIHIN_DATA_START_ROW, BIHIN_COL_NAME, bihinLastRow - BIHIN_DATA_START_ROW + 1, BIHIN_COL_VOLUME - BIHIN_COL_NAME + 1).getValues();
  const nameToVolume = {};
  bihinBlock.forEach(function (r) {
    const name = String(r[0] || '').trim();
    const vol = Number(r[r.length - 1] || 0);
    if (name && vol > 0) nameToVolume[name] = vol;
  });

  // 3) アイテムリスト走査
  const items = [];
  let totalVolume = 0;
  let matchedCount = 0, unmatchedCount = 0;
  itemData.forEach(function (row) {
    const name = row.name;
    const qty = row.qty;
    const spec = row.spec;
    if (!name || qty === 0) return;
    // 完全一致 → 部分一致 (品名 contains)
    let unitVolume = nameToVolume[name];
    let source = '';
    if (unitVolume) {
      source = 'exact';
    } else {
      // 部分一致 (品名が マスタ品名を含む or その逆)
      const keys = Object.keys(nameToVolume);
      for (let i = 0; i < keys.length; i++) {
        if (name.indexOf(keys[i]) >= 0 || (keys[i].length >= 4 && keys[i].indexOf(name) >= 0)) {
          unitVolume = nameToVolume[keys[i]];
          source = 'partial:' + keys[i];
          break;
        }
      }
    }
    if (!unitVolume) {
      // spec から推定
      const dims = _parseDimensionsFromName(name + ' ' + spec);
      if (dims) {
        unitVolume = (dims.w * dims.d * dims.h) / 1e9;
        source = 'spec-parse';
      } else {
        unitVolume = _estimateVolumeByCategory(row.category || '', name);
        source = 'category-estimate';
      }
    }
    const itemVolume = Math.round(unitVolume * qty * 10000) / 10000;
    totalVolume += itemVolume;
    if (source === 'exact' || source.indexOf('partial') === 0) matchedCount++;
    else unmatchedCount++;
    items.push({ name: name.slice(0, 30), qty: qty, unitVol: unitVolume, totalVol: itemVolume, source: source });
  });
  totalVolume = Math.round(totalVolume * 100) / 100;

  // 3.5) 総容積は zissi「アイテムリスト」シート AF1（合計セル）を最優先で採用（kim 2026-08 指示）。
  //      AF1 が数値でなければ従来の 備品マスタAP列合算 にフォールバック。
  let volumeSource = '備品マスタAP列合算';
  const af1 = itemSourceIsProposal ? null : _Phase2_readItemListAF1(zissi);
  if (af1 != null) { totalVolume = Math.round(af1 * 100) / 100; volumeSource = 'アイテムリスト!AF1（合計セル）'; }

  // 4) 安全係数
  const SAFETY_FACTOR = 1.3;
  const withMargin = Math.round(totalVolume * SAFETY_FACTOR * 100) / 100;

  // 5) トラック選定
  const selection = Phase2_selectTrucks(withMargin);
  const selectedTrucks = selection.selectedTrucks;
  const isCoveredByJisha = selection.isCoveredByJisha;
  const jishaCapacity = PHASE2_DUTRO_CAPACITY + PHASE2_CARAVAN_CAPACITY;

  // 積載容積の数値は荷台内寸。駐車場判定は TruckExteriorSpec.js の外寸を使う。
  const selectedTrucksWithExterior = selectedTrucks.map(function (t) {
    return { name: t.name, kind: t.kind, capacity: t.capacity, exterior: TruckExteriorSpec_get(t.name) };
  });
  const selectedTruckNames = selectedTrucksWithExterior.map(function (t) { return t.name; });

  // 容積寄与 top 20 を別途返す (外れ値検証用)
  const sortedByVol = items.slice().sort(function (a, b) { return b.totalVol - a.totalVol; });
  return {
    caseId: caseId,
    caseName: c.caseName,
    itemSheetUsed: itemSheetUsed,
    itemSourceIsProposal: itemSourceIsProposal,
    qtyHeaderNotFound: existing.qtyHeaderNotFound,
    nameHeaderNotFound: existing.nameHeaderNotFound,
    topByVolume: sortedByVol.slice(0, 20),
    items: items.slice(0, 30),
    itemCount: items.length,
    matchedCount: matchedCount,
    unmatchedCount: unmatchedCount,
    totalVolumeM3: totalVolume,
    volumeSource: volumeSource,
    safetyFactor: SAFETY_FACTOR,
    withMarginM3: withMargin,
    jishaCapacityM3: jishaCapacity,
    isCoveredByJisha: isCoveredByJisha,
    selectedTrucks: selectedTrucksWithExterior,
    parkingRequirement: TruckExteriorSpec_requirementFor(selectedTruckNames),
    coinParkingCheck: TruckExteriorSpec_checkCoinParking(selectedTruckNames),
    selectedTotalCapacityM3: Math.round(selectedTrucks.reduce(function (a, b) { return a + b.capacity; }, 0) * 100) / 100,
    fitRatio: Math.round(withMargin / selectedTrucks.reduce(function (a, b) { return a + b.capacity; }, 0) * 100) / 100
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { Phase2_selectTrucks: Phase2_selectTrucks, Zissi_parseItemListValues: Zissi_parseItemListValues };
