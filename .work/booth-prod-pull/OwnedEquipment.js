/**
 * 株式会社オージャストの保有機材（Reブース）。
 * Phase2_LayoutPlan の画像プロンプト + アイテムリスト生成時に Claude へ常時投入。
 *
 * Source: https://docs.google.com/presentation/d/1GPaySeZy7wyMIIHLQ3cY2yyJv44PwKClgcMSIJGm2go
 * Updated: 2026-06-11
 */

function _OwnedEquipment_describeHardcoded() {
  return [
    '【株式会社オージャスト 保有機材（Reブース）】',
    '※ ジェネリックな展示会ブース部材ではなく、必ず以下の自社保有機材から組み立てる前提でレイアウトを設計し、画像プロンプトにも具体名で記載すること。',
    '',
    '## 主要構造材',
    '',
    '### Reブーススチール展示用キット (パネル & 展示台)',
    '- パネル実寸: W990 × H2700 × 厚22mm / 約22kg（高さ2700mmの場合）',
    '- 展示台実寸: W900 × H793(キャスター込) × D450mm / 約28kg（展示台兼搬送ケース）',
    '- パネル本体: ブラック / ガルバリウム鋼板 / マグネットシートで色変更可',
    '- 在庫: パネル 9 枚 + 展示台 8 台',
    '- パネル単体は自立しないため、展示台 1 台に対しパネル 2 枚で組む（または展示台とセット）',
    '- 用途: バックパネル / サイドパネル / 商品展示',
    '- AI 画像で表現する形容詞: "black galvanized steel modular panel system" / "matte black exhibition wall with magnetic surface"',
    '',
    '### トラス',
    '- **300角 シルバー (アルミ)**: 支柱直径 32mm / ラチス直径 19.9mm / アルミ色（シルバー）',
    '  → 重量物（モニター吊り下げ等）対応、ロの字組み必須（モニター吊り下げ時）',
    '- **200角 クランプ式 黒色**: メインチューブ 32×2mm / ブレース 22×12×1.8mm / アルミ6061-T6 / マットブラック',
    '- **220角 黒色**: マットブラック',
    '- AI 画像で表現: "300mm square aluminum truss frame silver" / "200mm square clamp-type black aluminum truss"',
    '',
    '### LED UP（内照式LEDパネル）',
    '- 全パネル奥行 120mm 統一',
    '- フレームサイズ:',
    '  - W3000×H2000 または H2980mm（2 セット）',
    '  - W2000×H2000 または H2980mm（2 セット）',
    '  - W1500×H2000 または H2980mm（2 セット）',
    '  - W1000×H2000 または H2980mm（1 セット）',
    '- 鍵付き扉ユニット: W985×H2980mm (1 セット、扉部分は非内照)',
    '- 延長モジュール: 高さ 700mm × 6本、横幅 500mm × 2本、横幅 850mm × 2本',
    '- AI 画像で表現: "internally lit white LED light box wall panel, soft edge-lit glow, frameless design, 120mm depth"',
    '',
    '## 装飾・サイン系',
    '',
    '### ロゴボックス',
    '- サイズ: W900 × H900 × D500mm、4 台',
    '- ロゴ部分は張替え可（W698×H618 マットスチレンボード）',
    '- AI 画像で表現: "white cubic logo box pedestal, swappable face panel"',
    '',
    '### フラワーウォール / 神殿柱',
    '- 神殿柱: 大(H2770)/中(H2470)/小(H2200) 各 2 本、上下底 50×50、円柱 120.5',
    '- AI 画像で表現: "white classical Greek column" / "floral wall backdrop"',
    '',
    '## 家具・什器',
    '',
    '### 商談セット（ハイ）',
    '- ハイテーブル: W600×D600×H680-920mm 天板1.8cm 約8.6kg × 5 台',
    '- ハイチェア: W380×D370×H650-860mm 座面H580-800 × 10 脚',
    '',
    '### 商談セット（ロー）',
    '- ローテーブル + ローソファー（クリーム色）× 4 セット（机1 + ソファー2）',
    '',
    '### 商談テーブル + スタッキングチェア',
    '- 商談テーブル × 12 台',
    '- スタッキングチェア（ホワイト）× 26 脚',
    '',
    '### カフェテーブル',
    '- 直径900×H720mm 丸形 / 天板 オーク色 メラミン / 脚スチール粉体塗装 × 4 台',
    '',
    '### 木製ハイカウンター',
    '- W1200×D600×H1012mm / 白 / メラミン化粧板 × （受付用）',
    '',
    '### ミーティングテーブル (会議机)',
    '- W900×D450×H700mm / アイボリー / クランク式折りたたみ',
    '',
    '### IKEA LINNMON ハイテーブル',
    '- W1200×D600 / 天板上H1040 / 天板下H1000 / アイボリー',
    '',
    '## 表示機材',
    '',
    '### モニター',
    '- 42 インチ (Toshiba TD-Z421) × 5',
    '- 55 インチ (JU55G7E CHiQ) × 1',
    '- 65 インチ (Panasonic TH-65EF1J) × 1',
    '- 32 インチ 4K (LG 32UD99-W) - 看板用',
    '- 自立スタンド × 4 / モニター台（W1300×H1415×D455 斜め設置可、DVDプレーヤー収納扉付） × 数台',
    '',
    '### LEDビジョンバナー / LED チューブ',
    '- LED ビジョン: Indoor P2 320×160mm 40s module、screen 640×480mm（H2460×W640×D440）',
    '- LED チューブ: 長さ 2700mm',
    '',
    '### プロジェクター',
    '- EPSON EB-Z10000U × 2 + 各種交換レンズ（標準/中焦点/超単焦点）',
    '',
    '## 照明',
    '',
    '- アームスポットライト × 17 本 + 取付レール × 11 本',
    '- トラス用照明 × 16 個（金具付き）',
    '- クリップライト × 5 個',
    '',
    '## 床',
    '',
    '### 床パネル (400×400mm、厚 18mm、繰り返し使用可)',
    '- 色: 黒 / グレー / 緑 / 青 / 赤 / 黄 / 白',
    '- AI 画像で表現: "modular interlocking floor tile system 400x400mm 18mm thick polished finish"',
    '',
    '## 音響',
    '',
    '- YAMAHA DBR10 PA スピーカー (バイアンプ2WAYバスレフ、500W LF + 200W HF) × 数台',
    '- 小型拡声器 SH-121 ヘッドセット',
    '',
    '## 配線・付属',
    '',
    '- PVC プロテクター (黒、配線保護用、長さ1000mm × 多数)',
    '- HDMI 分配器',
    '- フィッティングルーム (簡易試着室 W850×D850×H2000mm、黄色 イエロー)',
    '- メタルラック 4 段 (W715×D340×H1275mm、白)',
    '- 脚立 (175cm / 145cm / 9尺=260cm × 2)',
    '- A1 LED パネル × 10 枚',
    '- DJ トラステーブル (ODYSSEY ATT) W1504×D508×H863mm、アルミダイヤモンド模様天板',
    '- 登壇者返しモニターセット (チルト45-65度、24-43型対応) × 2',
    '- 冷蔵ショーケース（卓上4面ガラス W454×D408×H835、レマコム R4G-63SLW）',
    '- アクリルボックス W360×D220×H280 × 20 個',
    '',
    '## ガイドライン（画像プロンプト生成時）',
    '',
    '- 上記の特定機材名を必ず英語プロンプトに含める（例: "Reburse modular black steel panel system" / "300mm aluminum silver truss" / "internally lit LED light box wall"）',
    '- 色は必ず 「matte black galvanized steel」 / 「silver aluminum」 / 「warm white edge-lit LED」 / 「cream beige sofa」 等、保有機材の実際の色合いに合わせる',
    '- "generic exhibition booth" / "standard trade show stand" など曖昧な表現は禁止',
    '- 配置はブースサイズ規定（3M×3M等）と上記在庫数の範囲内で',
    '- 天井高 H2000-2980mm の範囲で（LED UP の最大高に合わせる）'
  ].join('\n');
}

const _OWNED_EQUIPMENT_FALLBACK_NOTICE = '※ 機材マスタの自動同期が取得できず、2026-06-11 時点の固定値を使用しています';
const _OWNED_EQUIPMENT_WALL_FALLBACK = [
  { name: '展示パネル（Reブーススチール展示用キット）', width: 990, height: 2700, stock: 9, kind: 'panel', note: '単体で自立しない。展示台 1 台に対しパネル 2 枚が必要（展示台 在庫 8 台）' },
  { name: 'LED UP W3000', width: 3000, height: 2980, stock: 2, kind: 'ledup', note: '奥行 120mm。高さは 2000 or 2980' },
  { name: 'LED UP W2000', width: 2000, height: 2980, stock: 2, kind: 'ledup', note: '奥行 120mm。高さは 2000 or 2980' },
  { name: 'LED UP W1500', width: 1500, height: 2980, stock: 2, kind: 'ledup', note: '奥行 120mm。高さは 2000 or 2980' },
  { name: 'LED UP W1000', width: 1000, height: 2980, stock: 1, kind: 'ledup', note: '奥行 120mm。高さは 2000 or 2980' },
  { name: 'LED UP 鍵付き扉ユニット W985', width: 985, height: 2980, stock: 1, kind: 'ledup', note: '扉部分は非内照' },
  { name: 'LED UP 延長モジュール W850', width: 850, height: null, stock: 2, kind: 'filler', note: '横幅延長用' },
  { name: 'LED UP 延長モジュール W500', width: 500, height: null, stock: 2, kind: 'filler', note: '横幅延長用' }
];

function _OwnedEquipment_catalogRows() {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(EQUIPMENT_CATALOG_SHEET_NAME || '保有機材カタログ');
    if (!sh || sh.getLastRow() < 2) return [];
    const values = sh.getDataRange().getDisplayValues();
    const headers = values[0].map(function (v) { return String(v || '').trim(); });
    const bodyCol = headers.indexOf('本文テキスト');
    const titleCol = headers.indexOf('タイトル');
    if (bodyCol < 0) return [];
    return values.slice(1).map(function (r) { return { title: titleCol >= 0 ? r[titleCol] : '', bodyText: r[bodyCol] || '' }; })
      .filter(function (r) { return String(r.bodyText).trim(); });
  } catch (e) { return []; }
}

function OwnedEquipment_source() { return _OwnedEquipment_catalogRows().length ? 'sheet' : 'hardcoded'; }

/**
 * スライド本文から取れた dim が「壁面を構成する規格材」かどうか判定する。
 * @param {{w:number,h:number,d:number}} dim
 * @param {string} contextText スライドのタイトル+本文
 * @return {boolean}
 */
function OwnedEquipment_isWallDim(dim, contextText) {
  return !!dim && Number(dim.w) > 0 && Number(dim.w) <= 5000 &&
    dim.h != null && Number(dim.h) >= 2000;
}

function OwnedEquipment_mergeFallbackParts(syncedParts, fallbackParts) {
  const result = [];
  const widths = {};
  (syncedParts || []).forEach(function (part) {
    const width = Number(part.width);
    if (widths[width]) return;
    widths[width] = true;
    result.push(Object.assign({}, part));
  });
  (fallbackParts || []).forEach(function (part) {
    const width = Number(part.width);
    if (widths[width]) return;
    widths[width] = true;
    const merged = Object.assign({}, part);
    merged.note = (merged.note ? merged.note : '') + ' / 自動同期では取得できず固定値を使用';
    result.push(merged);
  });
  return result;
}

function OwnedEquipment_wallParts() {
  const catalog = _OwnedEquipment_catalogRows();
  if (!catalog.length) return _OWNED_EQUIPMENT_WALL_FALLBACK.map(function (p) { return Object.assign({}, p); });
  const inventory = EquipmentSpec_readInventory();
  const result = [];
  catalog.forEach(function (row) {
    const text = row.title + '\n' + row.bodyText;
    if (!/(パネル|LED\s*UP|間仕切|壁)/i.test(text)) return;
    const parsed = EquipmentSpec_parseSlideText(row.bodyText);
    const wallDims = parsed.dims.filter(function (d) { return OwnedEquipment_isWallDim(d, text); });
    const matched = inventory.rows.find(function (r) { return EquipmentSpec_matchPartName(r.name, row.title); });
    const count = parsed.counts.find(function (c) { return /^(枚|セット)$/.test(c.unit); });
    wallDims.forEach(function (d) {
      let stock = 0;
      if (count) stock = count.qty;
      if (matched) stock = matched.stock;
      if (!(stock > 0)) return;
      const isLed = /LED\s*UP/i.test(text);
      const baseName = row.title || '壁面規格材';
      const name = wallDims.length > 1 ? baseName + ' (W' + d.w + ')' : baseName;
      result.push({ name: name, width: d.w, height: d.h || null, stock: stock, kind: isLed ? (/延長/.test(text) ? 'filler' : 'ledup') : 'panel', note: '保有機材カタログから自動同期' });
    });
  });
  return OwnedEquipment_mergeFallbackParts(result, _OWNED_EQUIPMENT_WALL_FALLBACK);
}

function OwnedEquipment_renderWallPartsTable(parts) {
  const rows = (Array.isArray(parts) ? parts : []).map(function (part) {
    const width = Number(part && part.width);
    const height = Number(part && part.height);
    const stock = Number(part && part.stock);
    const size = 'W' + (width > 0 ? width : '不明') + ' × H' + (height > 0 ? height : '不明');
    return '- ' + (part && part.name ? part.name : '名称不明の規格材') + ': ' + size + ' / 在庫' + (stock >= 0 ? stock : '不明');
  });
  return ['## 壁面を構成できる規格材（幅×高さ×在庫、ソルバーと同じ値）']
    .concat(rows.length ? rows : ['- 利用可能な規格材はありません。'])
    .join('\n');
}

function OwnedEquipment_describe() {
  const catalog = _OwnedEquipment_catalogRows();
  const description = !catalog.length
    ? _OWNED_EQUIPMENT_FALLBACK_NOTICE + '\n' + _OwnedEquipment_describeHardcoded()
    : ['【株式会社オージャスト 保有機材（自動同期）】', '※ 保有機材カタログの最新スライド本文を使用。', '']
      .concat(catalog.map(function (r) { return '## ' + (r.title || 'タイトル不明') + '\n' + r.bodyText; })).join('\n\n');
  return description + '\n\n' + OwnedEquipment_renderWallPartsTable(OwnedEquipment_wallParts());
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  OwnedEquipment_wallParts: OwnedEquipment_wallParts,
  OwnedEquipment_renderWallPartsTable: OwnedEquipment_renderWallPartsTable,
  OwnedEquipment_mergeFallbackParts: OwnedEquipment_mergeFallbackParts,
  OwnedEquipment_isWallDim: OwnedEquipment_isWallDim,
  OwnedEquipment_describe: OwnedEquipment_describe,
  OwnedEquipment_source: OwnedEquipment_source
};
