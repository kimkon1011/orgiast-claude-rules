/**
 * Build updated fee table spreadsheet:
 * 1. Rename v3 tab → prefix with 【誤り・旧ブロック使用】
 * 2. Add new tab "料金表v4_2026.2改定準拠_1117"
 * 3. Use correct Sheet2 2026.2改定 block values
 */
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const TMP = 'C:/Users/USER/AppData/Local/Temp';
const XLSX_PATH = `${TMP}/rebooth-fee-v3.xlsx`;

// ── Read existing workbook ──
const wb = XLSX.readFile(XLSX_PATH);

// ── Step 1: Rename v3 tab ──
const oldIdx = wb.SheetNames.indexOf('料金表v3_シート2準拠_1117');
if (oldIdx === -1) throw new Error('v3 tab not found');
wb.SheetNames[oldIdx] = '【誤り・旧ブロック使用】料金表v3_シート2準拠_1117';

// ── Step 2: Build new v4 tab ──

// Helper: encode cell ref
function c(addr, val, opts = {}) {
  const cell = { t: 's', v: String(val) };
  // Set rich formatting for numeric-looking strings
  if (opts.bold) cell.s = { font: { bold: true } };
  return cell;
}

const ws_data = {};
const merges = [];

function setCell(r, c_idx, val, opts = {}) {
  const addr = XLSX.utils.encode_cell({ r, c: c_idx });
  ws_data[addr] = c(addr, val, opts);
}

function setRow(r, values, opts = {}) {
  values.forEach((v, i) => setCell(r, i, v, opts));
}

function mergeRange(s, e_r, e_c) {
  merges.push({ s, e: { r: e_r, c: e_c } });
}

// ── Build content ──

let r = 0;

// Title
setRow(r, ['Reブース デザイナー依頼費 料金表v4（2026.2改定ブロック準拠・2026-11-17）']);
mergeRange({ r: r, c: 0 }, r, 7); r++;

setRow(r, ['金額はすべて税別。提案費＝プレゼンまで。受注費＝受注後の実施デザインで提案費に追加。']);
mergeRange({ r: r, c: 0 }, r, 7); r++;

setRow(r, ['修正回数：提案段階・受注後のそれぞれ5回まで基本料金に含む（kim指示）。修正箇所をディレクター及びプロデューサーがチェックしOKで1カウント。']);
mergeRange({ r: r, c: 0 }, r, 7); r++;

setRow(r, ['区分は実面積㎡（kim指示）。トラス・LEDUPの配置設計は基本料金に含む（kim指示）。']);
mergeRange({ r: r, c: 0 }, r, 7); r++;

r++;
// ── Section A: Fee Table ──
setRow(r, ['【A】料金表（面積区分ごとの提案/受注後/合計）']);
mergeRange({ r: r, c: 0 }, r, 7); r++;

// Header row
setRow(r, ['区分', '実面積', '目安', '提案費', '受注費（追加）', '受注時合計', '出典セル（シート2）', '備考'], { bold: true }); r++;

// Helper for XL/XXL calculation
function calcRow(label, areaMin, areaMax, desc, proposalBase, postOrderBase, source, note) {
  // For 36㎡以下: proposal 20000, postOrder 40000
  // For 37㎡以上: proposal = 20000 + 8000 per 9㎡ increment, postOrder = 40000 + 4000 per 9㎡ increment
  const isOver36 = areaMin >= 37;
  const increments = isOver36 ? Math.floor((areaMin - 36) / 9) : 0;
  // For 37-54: 1 increment, 55-80: 2-4 increments, 81+: 5+ increments
  let propVal, postVal, totalVal;
  
  if (areaMin < 9) {
    // SS: needs kim decision
    propVal = `要kim判断（${proposalBase}）`;
    postVal = `要kim判断（${postOrderBase}）`;
    totalVal = `要kim判断`;
  } else if (areaMax <= 36 || (areaMin <= 36 && areaMax <= 36)) {
    propVal = proposalBase;
    postVal = postOrderBase;
    totalVal = proposalBase + postOrderBase;
  } else {
    propVal = `${proposalBase}+¥8,000×${increments}㎡増`;
    postVal = `${postOrderBase}+¥4,000×${increments}㎡増`;
    totalVal = `個別計算`;
  }
  
  setRow(r, [label, `${areaMin}〜${areaMax}㎡`, desc, 
    typeof propVal === 'number' ? propVal : propVal,
    typeof postVal === 'number' ? postVal : postVal,
    typeof totalVal === 'number' ? totalVal : totalVal,
    source, note]);
  r++;
}

// SS: 0-9㎡ (トラス不可) — シート2に区分なし → 要kim判断
setRow(r, ['SS', '0〜9㎡未満', '3m×3m以下（トラス不可）',
  '要kim判断', '要kim判断', '要kim判断',
  'シート2にSS区分なし。実績：6.48㎡=15,000+30,000（居酒屋JAPAN）、9㎡=15,000+30,000（FOOD STYLE Chubu/ファベックス）',
  '小区画減額区分。シート2に記載がなければ要kim判断']);
r++;

// S: 9-18㎡
setRow(r, ['S', '9〜18㎡未満', '2コマ相当',
  20000, 40000, 60000,
  'シート2!H1: 36㎡以下提案¥20,000。シート2!H1: 受注後¥40,000',
  '実績平均提案20,625円']);
r++;

// M: 18-27㎡
setRow(r, ['M', '18〜27㎡未満', '3コマ相当',
  20000, 40000, 60000,
  'シート2!H1: 36㎡以下提案¥20,000。シート2!H1: 受注後¥40,000',
  '全件実績30,000+30,000だがシート2値を使用']);
r++;

// L: 27-36㎡
setRow(r, ['L', '27〜36㎡', '4コマ相当',
  20000, 40000, 60000,
  'シート2!H1: 36㎡以下提案¥20,000。シート2!H1: 受注後¥40,000',
  '実績36㎡=30,000+30,000だがシート2値を使用']);
r++;

// XL: 37-54㎡ (1 increment)
setRow(r, ['XL', '37〜54㎡', '9㎡刻み加算（1段階）',
  '20,000+8,000', '40,000+4,000', 72000,
  'シート2!H1: 36㎡以下¥20,000 +20%/9㎡ = +¥8,000/9㎡(提案) / +¥4,000/9㎡(受注後)',
  '端数の扱いはシート2に記載がなければ「要kim判断」']);
r++;

// XXL: 55-80㎡ (2-4 increments)
setRow(r, ['XXL', '55〜80㎡未満', '9㎡刻み加算（2〜4段階）',
  '20,000+8,000×n', '40,000+4,000×n', '個別計算',
  'シート2!H1比例計算',
  '端数の扱いはシート2に記載がなければ「要kim判断」']);
r++;

// XXXL: 81㎡以上
setRow(r, ['XXXL', '81㎡以上', '9㎡刻み加算（5段階〜）',
  '要個別見積', '要個別見積', '要個別見積',
  'シート2!H1比例計算だが実績不足',
  '要kim判断']);
r++;

// Calculation examples for common sizes
r++;
setRow(r, ['【参考】実面積ごとの計算例']);
mergeRange({ r: r, c: 0 }, r, 7); r++;
setRow(r, ['面積', '9㎡増分(36㎡超)', '提案費', '受注費（追加）', '受注時合計', '計算式'], { bold: true }); r++;

function calcExample(area) {
  if (area <= 36) {
    return [area, 0, 20000, 40000, 60000, `36㎡以下: ¥20,000+¥40,000`];
  }
  const inc = Math.ceil((area - 36) / 9);
  const prop = 20000 + 8000 * inc;
  const post = 40000 + 4000 * inc;
  return [area, inc, prop, post, prop + post, `¥20,000+¥8,000×${inc}`];
}

const examples = [37, 45, 54, 63, 72, 81, 90];
examples.forEach(area => {
  const ex = calcExample(area);
  setRow(r, ex); r++;
});

r++;
// ── Section B: Corrections ──
setRow(r, ['【B】修正（提案段階・受注後）']);
mergeRange({ r: r, c: 0 }, r, 5); r++;
setRow(r, ['項目', '内容', '金額', '条件', '出典セル', '備考'], { bold: true }); r++;

setRow(r, ['修正（提案段階）1〜5回目', '基本料金内', '0円', '5回まで無料（kim指示）', 'kim指示', '修正箇所をディレクター及びプロデューサーがチェックしOKで1カウント']); r++;
setRow(r, ['修正（提案段階）6回目以降', '36㎡以下', '10,000円/回', '6回目から', 'シート2!H1: 修正1万円/1回', '']); r++;
setRow(r, ['修正（提案段階）6回目以降', '37㎡以上', '+2,000円/1回/9㎡', '6回目から', 'シート2!H1: 修正+2000円/1回/9㎡', '']); r++;
setRow(r, ['修正（受注後）1〜5回目', '基本料金内', '0円', '5回まで無料（kim指示）', 'kim指示', '']); r++;
setRow(r, ['修正（受注後）6回目以降', '36㎡以下', '10,000円/回', '6回目から', 'シート2!H1: 修正1万円/1回', '']); r++;
setRow(r, ['修正（受注後）6回目以降', '37㎡以上', '+2,000円/1回/9㎡', '6回目から', 'シート2!H1: 修正+2000円/1回/9㎡', '']); r++;

r++;
// ── Section C: Additional options ──
setRow(r, ['【C】1案追加']);
mergeRange({ r: r, c: 0 }, r, 5); r++;
setRow(r, ['項目', '金額', '出典セル', '備考'], { bold: true }); r++;
setRow(r, ['1案追加（36㎡以下）', '10,000円', 'シート2!H1: 1案プラスで1万円', '実績：キーノスロジック_JAPAN BUILD ¥5,000（旧価格）']); r++;
setRow(r, ['1案追加（37㎡以上、+2,000円/9㎡）', '10,000+2,000×増分', 'シート2!H1: 1案1万プラス+2000円/9㎡', '']); r++;

r++;
setRow(r, ['【D】継続リサイズ']);
mergeRange({ r: r, c: 0 }, r, 5); r++;
setRow(r, ['区分', '提案費', '受注費', '受注時合計', '出典セル', '備考'], { bold: true }); r++;
setRow(r, ['36㎡以下', '15,000円', '30,000円', '45,000円', 'シート2!K1: 継続案件リサイズ36㎡以下¥15,000→受注後3万円', '']); r++;
setRow(r, ['37㎡以上（+3,000円/9㎡）', '15,000+3,000×増分', '30,000+3,000×増分', '個別計算', 'シート2!K1/K18: 37㎡以上+¥3,000/9㎡（2026.2改定）', '']); r++;

r++;
setRow(r, ['【E】その他']);
mergeRange({ r: r, c: 0 }, r, 5); r++;
setRow(r, ['項目', '金額', '出典セル', '備考'], { bold: true }); r++;
setRow(r, ['お客様との直接やりとり', '10,000円', 'シート2!N14: お客様との直接やりとり¥10,000', '使用実績未確認']); r++;
setRow(r, ['継続案件で追加の新規デザイン物（1点）', '6,000円/点', 'シート2!N17: 1点6,000円追加。パラペット系はデザイン系統で数える', '実績：taiziii_ネクステック 新規デザイン物4点×¥6,000=¥24,000']); r++;

r++;
// ── Section F: Options ──
setRow(r, ['【F】加算オプション（kim指示：LEDUP印刷面と展示ポスター・チラシの2つのみ）']);
mergeRange({ r: r, c: 0 }, r, 6); r++;
setRow(r, ['項目', '内容', '単位', '提案費加算', '受注費加算', '出典', '備考'], { bold: true }); r++;
setRow(r, ['LEDUP印刷面のデザイン', 'LEDUPに入れる印刷面のグラフィック', '1面', 0, 6000,
  'デザイナー様用セル（実績：6,000円/点）',
  '金額は「要kim判断」が出典セルがなければ']); r++;
setRow(r, ['展示ポスター・チラシのデザイン', 'ブース内ポスター・チラシ（片面）', '1点', 0, 6000,
  'デザイナー様用セル（実績：6,000円/点）',
  '金額は「要kim判断」が出典セルがなければ']); r++;

r++;
// ── Section G: Truss/unavailable discount ──
setRow(r, ['【G】3m×3m等トラス不可の減額']);
mergeRange({ r: r, c: 0 }, r, 4); r++;
setRow(r, ['項目', '内容', '状態', '判断'], { bold: true }); r++;
setRow(r, ['トラス不可減額', '3m×3m等トラスを立てられない小区画', '根拠セルが無し', '要kim判断（数値を作らない）']);
setRow(r, ['', '', 'シート2にSS区分の記載なし', '実績ベース：6.48㎡=15,000+30,000 / 9㎡=15,000+30,000']); r++;

r++;
// ── Section H: Source map ──
setRow(r, ['【H】値の出典セル一覧']);
mergeRange({ r: r, c: 0 }, r, 4); r++;
setRow(r, ['項目', '値', '出典セル（シート2）', '備考'], { bold: true }); r++;
setRow(r, ['36㎡以下 提案費', '¥20,000', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['36㎡以下 受注費（追加）', '¥40,000', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['37㎡以上 提案加算/9㎡', '+¥8,000/9㎡（+20%）', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['37㎡以上 受注加算/9㎡', '+¥4,000/9㎡（+20%）', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['修正（36㎡以下）', '¥10,000/回', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['修正（37㎡以上/9㎡）', '+¥2,000/1回/9㎡', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['1案追加（36㎡以下）', '¥10,000', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['1案追加（37㎡以上/9㎡）', '+¥2,000/9㎡', 'シート2!H1', '2026.2改定ブロック']); r++;
setRow(r, ['継続リサイズ 36㎡以下', '¥15,000→受注後¥30,000', 'シート2!K1/K18', '2026.2改定ブロック']); r++;
setRow(r, ['継続リサイズ 37㎡以上/9㎡', '+¥3,000/9㎡', 'シート2!K1/K18', '2026.2改定ブロック']); r++;
setRow(r, ['お客様との直接やりとり', '¥10,000', 'シート2!N14', '']); r++;
setRow(r, ['継続案件追加新規デザイン物', '¥6,000/点', 'シート2!N17', 'パラペット系はデザイン系統で数える']); r++;

r++;
// ── Section I: Past case matching ──
setRow(r, ['【I】過去案件の突合（デザイナー様用・ディレクター様用タブの全行から抽出）']);
mergeRange({ r: r, c: 0 }, r, 8); r++;
setRow(r, ['案件名', '実面積㎡', '記録額（デザイン費）', '記録額（制作費）', '記録額（修正等その他）', '記録合計', 'v4料金（提+受）', '差額', '記録セル番地'], { bold: true }); r++;

// Data from デザイナー様用 tab. Each row: [案件名, 面積, 提案額(U), 制作額(V), その他(W), 合計, v4提案, v4受注, セル番地]
// Mapping against v4 rates:
// SS(0-9): 要kim判断. Use 実績=15,000+30,000 as reference.
// S(9-18): 20,000+40,000 = 60,000
// M/L(18-36): 20,000+40,000 = 60,000
// XL(37-54): 20,000+8,000 + 40,000+4,000 (n increments)

// Note: These are from the デザイナー様用 tab as read above.
// The column mapping: U=提案デザイン費, V=実施制作費, W=修正等その他
// These are all from デザイナー様用 rows
const pastCases = [
  // [案件名, 面積, 記録U(提案), 記録V(制作), 記録W(その他), 記録合計, セル番地]
  // Row numbers are xlsx row (0-based), Excel rows are +3 (header at row 1 in Excel = index 0 here)
  // Actually: デザイナー様用 read above, A2=ステータス (header row 1), data starts row 5 (0-based index 4)
  // But in the dump: Row 4 = A5, Row 5 = A6 etc.
  // So row index R → Excel row = R+1

  // Row 4 (A5): 営業段階, マイクロウェーブ展2026 - no U/V values → skip
  // Row 5 (A6): taiziii, 24.3㎡ - U=30000, V=30000 → 18-36㎡ → v4: 20000+40000=60000
  // Row 6 (A7): PDR核医学会, 20.3㎡ - U=30000, V=30000
  // Row 7 (A8): アビリカ, 34.28㎡ - U=35000, V=30000, W=修正¥10000
  // Row 8 (A9): フジミック名古屋, 16.2㎡ - U=15000, V=30000
  // Row 9 (A10): 建設技術展, 16㎡ - U=30000, V=30000
  // Row 10 (A11): パシフィックコンサルタンツ_自治体, 72.9㎡ - U=60000, V=60000, W=修正¥20000
  // Row 11 (A12): クラフトフィックス, 18㎡ - U=30000, V=30000
  // Row 12 (A13): ISR_IT Week大阪 - 面積確認中 → skip
  // Row 13 (A14): キーノスロジック_JAPAN BUILD, 32.4㎡ - U=35000, V=30000
  // Row 14 (A15): ISR名古屋 - 確認中 → skip
  // Row 15 (A16): ISR春 - 確認中 → skip
  // Row 16 (A17): 伯東, 18㎡ - U=40000, V=0, W=修正¥3000
  // Row 17 (A18): 国際医用画像総合展, 40.2㎡ - U=18000, V=30000, W=黒トラス¥12000/高さ変更¥8900
  // Row 18 (A19): クラフトフィックス_ビューティ大阪, 36㎡ - U=30000, V=30000, W=チラシ¥5000/トラス図¥3000
  // Row 19 (A20): クラフトフィックス_FOOD STYLE Chubu, 9㎡ - U=15000, V=30000
  // Row 20 (A21): クラフトフィックス_FOOD STYLE Kyushu, 18㎡ - U=15000, V=30000
  // Row 21 (A22): クラフトフィックス_FOOD STYLE JAPAN, 面積未確認/2コマ → skip
  // Row 22 (A23): ESキッチン(1st), 48.6㎡ - U=42000+12000, V=30000
  // Row 23 (A24): 海上・港湾・航空技術研究所_マイクロウェーブ展, 17.64㎡ - U=30000, V=30000, W=トラス図
  // Row 24 (A25): ESキッチン(2nd), 8.1㎡ - U=30000, V=30000
  // Row 25 (A26): クラフトフィックス_居酒屋JAPAN, 6.48㎡ - U=15000, V=30000
  // Row 26 (A27): クラフトフィックス_ビューティ福岡, 18㎡ - U=15000+トラス図3000+デザイン追加15000, V=30000
  // Row 27 (A28): taiziii_ネクステック, 32.4㎡ - U=15000+レイアウト追加計, V=30000+トラス図3000
  // Row 28 (A29): W2_reブース, 72.9㎡ - U=20000+(9㎡×4)×4000=36000, V=40000+(4000×4)=56000, W=特急10000/受注報酬10000/トラス図3000
  // Row 29 (A30): グリーンエナジー/reブース, 32.4㎡ - U=20000, V=40000, W=トラス無しプラン追加¥10000
  // Row 30 (A31): クラフトフィックス_第29回ファベックス, 9㎡ - U=15000+トラス図3000, V=30000
  // Row 31 (A32): マークスライフ_自治体公共Week - 面積8100×7500 → skip (no U/V)
  // Row 32 (A33): キースノロジック_産業DX展, 18㎡ - U=20000
  // Row 33 (A34): KLSマーチンジャパン, 43.2㎡ - U=20000
  // Row 34 (A35): マークスライフ_フューネラル, 72㎡ - V=60000
  // Row 35 (A36): SBIアルヒ, 18㎡ - U=30000
  // Row 36 (A37): KOKOIST, 面積不明 → skip
  // Row 37 (A38): Trip.com → skip
  // Row 38 (A39): HARP → skip
  // Row 39 (A40): RECORESERUM → skip
  // Row 40 (A41): グリーンエナジー_サステナブル経営WEEK秋, 72.9㎡ - U=40000, V=56000, W=トラス図3000
  // Row 41 (A42): パーソルクロス_IT Week秋, 32.4㎡ - U=20000, V=40000, W=松竹梅¥15000
  // Row 43 (A44): GridBeyond, 36㎡ - U=20000, V=40000
];

// Helper: determine v4 amounts for a given area
function v4Amounts(area) {
  if (area === null || area === undefined) return [null, null];
  if (area <= 9) return ['要kim判断(SS)', '要kim判断(SS)'];
  if (area <= 36) return [20000, 40000];
  // 37㎡以上: increments of 9㎡ from 37
  const inc = Math.ceil((area - 36) / 9);
  return [20000 + 8000 * inc, 40000 + 4000 * inc];
}

// Populate past cases
const caseData = [
  // [案件名略称, 面積, U, V, W, セル番地（デザイナー様用）]
  ['taiziii', 24.3, 30000, 30000, '', 'デザイナー様用!U6/V6'],
  ['PDR核医学会', 20.3, 30000, 30000, '', 'デザイナー様用!U7/V7'],
  ['アビリカ', 34.28, 35000, 30000, '修正¥10,000(U8)', 'デザイナー様用!U8/V8'],
  ['フジミック名古屋', 16.2, 15000, 30000, '', 'デザイナー様用!U9/V9'],
  ['建設技術展', 16, 30000, 30000, '', 'デザイナー様用!U10/V10'],
  ['パシフィックコンサル_自治体', 72.9, 60000, 60000, '修正¥20,000(U11)', 'デザイナー様用!U11/V11'],
  ['クラフトフィックス(初)', 18, 30000, 30000, '', 'デザイナー様用!U12/V12'],
  ['キーノスロジック_JAPAN BUILD', 32.4, 35000, 30000, '', 'デザイナー様用!U14/V14'],
  ['伯東', 18, 40000, 0, '修正¥3,000(W17)', 'デザイナー様用!U17/V17'],
  ['国際医用画像総合展', 40.2, 18000, 30000, '黒トラス¥12,000/高さ¥8,900(W18)', 'デザイナー様用!U18/V18'],
  ['クラフトフィックス_ビューティ大阪', 36, 30000, 30000, 'チラシ¥5,000/トラス図¥3,000(W19)', 'デザイナー様用!U19/V19'],
  ['クラフトフィックス_FOOD STYLE Chubu', 9, 15000, 30000, '', 'デザイナー様用!U20/V20'],
  ['クラフトフィックス_FOOD STYLE Kyushu', 18, 15000, 30000, '', 'デザイナー様用!U21/V21'],
  ['ESキッチン(1st)', 48.6, 54000, 30000, '', 'デザイナー様用!U23/V23'],
  ['海上港湾航空_マイクロウェーブ展', 17.64, 30000, 30000, 'トラス図(W24)', 'デザイナー様用!U24/V24'],
  ['ESキッチン(2nd)', 8.1, 30000, 30000, '', 'デザイナー様用!U25/V25'],
  ['クラフトフィックス_居酒屋JAPAN', 6.48, 15000, 30000, '', 'デザイナー様用!U26/V26'],
  ['クラフトフィックス_ビューティ福岡', 18, 30000, 30000, '他¥18,000(W27)', 'デザイナー様用!U27/V27'],
  ['taiziii_ネクステック', 32.4, 35000, 30000, '新規デザイン物¥24,000等(W28)', 'デザイナー様用!U28/V28'],
  ['W2_reブース', 72.9, 56000, 56000, '特急¥10,000/報酬¥10,000(W29)', 'デザイナー様用!U29/V29'],
  ['グリーンエナジー/reブース', 32.4, 20000, 40000, 'トラス無し追加¥10,000(W30)', 'デザイナー様用!U30/V30'],
  ['クラフトフィックス_ファベックス', 9, 18000, 30000, 'トラス図¥3,000(W31)', 'デザイナー様用!U31/V31'],
  ['キースノロジック_産業DX展', 18, 20000, 0, '', 'デザイナー様用!U33'],
  ['KLSマーチンジャパン', 43.2, 20000, 0, '', 'デザイナー様用!U34'],
  ['マークスライフ_フューネラル', 72, 0, 60000, '', 'デザイナー様用!V35'],
  ['SBIアルヒ', 18, 30000, 0, '', 'デザイナー様用!U36'],
  ['グリーンエナジー_サステナブルWEEK秋', 72.9, 40000, 56000, 'トラス図¥3,000(W41)', 'デザイナー様用!U41/V41'],
  ['パーソルクロス_IT Week秋', 32.4, 20000, 40000, '松竹梅¥15,000(W42)', 'デザイナー様用!U42/V42'],
  ['GridBeyond_SMART ENERGY WEEK', 36, 20000, 40000, '', 'デザイナー様用!U44/V44'],
];

caseData.forEach(([name, area, u, v, w, cell]) => {
  const [v4Prop, v4Post] = v4Amounts(area);
  const recordTotal = u + v;
  let v4Total;
  if (typeof v4Prop === 'number' && typeof v4Post === 'number') {
    v4Total = v4Prop + v4Post;
  } else {
    v4Total = '要kim判断';
  }
  const diff = typeof recordTotal === 'number' && typeof v4Total === 'number' ? v4Total - recordTotal : 'N/A';
  setRow(r, [
    name,
    area,
    u,
    v,
    w || '',
    recordTotal,
    typeof v4Prop === 'number' ? v4Prop : v4Prop,
    v4Total,
    diff,
    cell
  ]);
  r++;
});

r++;
// ── Section J: Old vs New comparison ──
setRow(r, ['【J】新旧比較（既存タブの値→v4の値）']);
mergeRange({ r: r, c: 0 }, r, 7); r++;
setRow(r, ['比較項目', 'Untitled(旧案)', '料金表v2(中間案)', 'v3(旧ブロック準拠)', 'シート2 2026.2改定', 'v4(本版)', '出典'], { bold: true }); r++;

const comparison = [
  ['SS(0-9㎡) 提案', '15,000', '15,000', '15,000', '該当区分なし', '要kim判断', 'シート2にSS区分なし'],
  ['SS(0-9㎡) 受注', '20,000', '30,000', '30,000', '該当区分なし', '要kim判断', '実績:6.48㎡=15,000+30,000'],
  ['S(9-18㎡) 提案', '20,000', '20,000', '20,000', '20,000', '20,000', 'シート2!H1'],
  ['S(9-18㎡) 受注', '30,000', '30,000', '30,000', '40,000', '40,000', 'シート2!H1'],
  ['M/L(18-36㎡) 提案', '25,000', '30,000', '30,000', '20,000', '20,000', 'シート2!H1'],
  ['M/L(18-36㎡) 受注', '40,000', '40,000', '30,000', '40,000', '40,000', 'シート2!H1'],
  ['XL(37-54㎡) 提案', '35,000', '30,000+8,000', '36,000', '20,000+8,000/9㎡', '28,000', 'シート2!H1'],
  ['XL(37-54㎡) 受注', '55,000', '40,000+4,000', '38,000', '40,000+4,000/9㎡', '44,000', 'シート2!H1'],
  ['修正6回目以降', '3,000/回', '3,000/回', '10,000/回', '10,000/回(36㎡以下)', '10,000/回', 'シート2!H1'],
  ['修正6回目以降(37㎡以上)', '記載なし', '記載なし', '10,000/回', '+2,000/1回/9㎡', '+2,000/回/9㎡', 'シート2!H1'],
  ['1案追加', '実績のみ', '10,000', '10,000', '10,000', '10,000', 'シート2!H1'],
  ['1案追加(37㎡以上)', '記載なし', '記載なし', '10,000', '+2,000/9㎡', '+2,000/9㎡', 'シート2!H1'],
  ['継続リサイズ 提案', '記載なし', '15,000', '15,000', '15,000', '15,000', 'シート2!K1'],
  ['継続リサイズ 受注', '記載なし', '30,000', '30,000', '30,000', '30,000', 'シート2!K1'],
  ['継続リサイズ(37㎡以上/9㎡)', '記載なし', '3,000', '3,000', '3,000', '3,000', 'シート2!K1/K18'],
  ['直接やりとり', '記載なし', '10,000', '10,000', '10,000', '10,000', 'シート2!N14'],
  ['追加新規デザイン物', '6,000/点', '6,000/点', '6,000/点', '6,000/点', '6,000/点', 'シート2!N17'],
  ['トラス図', '3,000', '基本料金に含む', '基本料金に含む', '基本料金に含む', '基本料金に含む', 'kim指示'],
  ['5回まで無料', 'なし', '新設', '新設', 'kim指示', '新設', 'kim指示'],
];

comparison.forEach(row => {
  setRow(r, row); r++;
});

// ── Create worksheet ──
const ws = XLSX.utils.aoa_to_sheet([]);
// Apply all cells
Object.keys(ws_data).forEach(key => {
  ws[key] = ws_data[key];
});
ws['!merges'] = merges;

// Set column widths
ws['!cols'] = [
  { wch: 40 },  // A
  { wch: 18 },  // B
  { wch: 30 },  // C
  { wch: 22 },  // D
  { wch: 22 },  // E
  { wch: 18 },  // F
  { wch: 50 },  // G
  { wch: 35 },  // H
  { wch: 18 },  // I
  { wch: 30 },  // J
];

// Add the new sheet
XLSX.utils.book_append_sheet(wb, ws, '料金表v4_2026.2改定準拠_1117');

// ── Write output ──
const outPath = `${TMP}/rebooth-fee-v4-result.xlsx`;
XLSX.writeFile(wb, outPath);

console.log('OK');
console.log(JSON.stringify({ path: outPath, bytes: fs.statSync(outPath).size }));