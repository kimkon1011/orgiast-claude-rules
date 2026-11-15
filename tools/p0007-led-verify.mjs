#!/usr/bin/env node
/**
 * P-0007: LED事前設置の効果検証 — 検証支援ツール
 *
 * 使用方法:
 *   node tools/p0007-led-verify.mjs --plan              # 検証計画書の表示
 *   node tools/p0007-led-verify.mjs --checklist         # 検証チェックリスト生成
 *   node tools/p0007-led-verify.mjs --estimate <パネル枚数>  # 時間削減見積もり
 *   node tools/p0007-led-verify.mjs --report            # 検証結果報告テンプレート
 *   node tools/p0007-led-verify.mjs --all               # 上記すべてを1つの計画書に出力
 *
 * 出力先: stdout（パイプまたはリダイレクトでファイル保存）
 *   例: node tools/p0007-led-verify.mjs --all > outputs/p0007-verification-plan.md
 */

// ─── 設定値 ───────────────────────────────────────

/** パネル1枚あたりの配線時間（分） */
const WIRING_PER_PANEL_MIN = 2.5;

/** パネル1枚あたりの信号線接続時間（分） */
const SIGNAL_PER_PANEL_MIN = 2.0;

/** 事前準備の固定時間（分）：パネル展開・配置 */
const PREP_FIXED_MIN = 10;

/** 事前準備のパネルあたり時間（分）：ケーブル接続＋結束 */
const PREP_PER_PANEL_MIN = 3.5;

/** 事前通電テストの固定時間（分） */
const PREP_TEST_FIXED_MIN = 10;

/** 事前終了処理（折りたたみ・保管）の固定時間（分） */
const PREP_PACK_MIN = 5;

/** 当日の固定時間（分）：運搬・展開 */
const ONSITE_FIXED_MIN = 5;

/** パネル取り付け時間（分/枚）：フレームへの取り付け */
const MOUNT_PER_PANEL_MIN = 3.0;

/** 当日の主電源接続（分）：固定 */
const ONSITE_MAIN_POWER_MIN = 2;

/** 当日の簡易通電テスト（分）：固定 */
const ONSITE_TEST_MIN = 5;

/** 基準値: 事前配線なしの場合の固定時間（分）：開梱＋フレーム取付 */
const BASELINE_FIXED_MIN = 20;

/** 基準値: 事前配線なしの場合のパネルあたり取付時間（分） */
const BASELINE_MOUNT_PER_PANEL_MIN = 3.0;

/** 基準値: 事前配線なしの場合の電源ケーブル接続時間（分/枚） */
const BASELINE_POWER_PER_PANEL_MIN = 2.0;

/** 基準値: 事前配線なしの場合の信号ケーブル接続時間（分/枚） */
const BASELINE_SIGNAL_PER_PANEL_MIN = 2.0;

/** 基準値: 事前配線なしの場合の通電テスト（分） */
const BASELINE_TEST_MIN = 10;

/** 基準値: 事前配線なしの場合の修正予備（分） */
const BASELINE_FIX_BUFFER_MIN = 10;

// ─── 計算ロジック ─────────────────────────────────

/**
 * パネル枚数から時間見積もりを計算
 * @param {number} panels LEDパネルの枚数
 * @returns {object} 見積もり結果
 */
function estimate(panels) {
  // 事前配線あり
  const prepTime = PREP_FIXED_MIN + panels * PREP_PER_PANEL_MIN;
  const prepTest = PREP_TEST_FIXED_MIN;
  const prepPack = PREP_PACK_MIN;
  const totalPrepHours = (prepTime + prepTest + prepPack) / 60;

  const onsiteTime = ONSITE_FIXED_MIN + panels * MOUNT_PER_PANEL_MIN + ONSITE_MAIN_POWER_MIN + ONSITE_TEST_MIN;
  const totalOnsiteMinutes = onsiteTime;
  const totalOnsiteHours = totalOnsiteMinutes / 60;

  // 事前配線なし（基準値）
  const baselineMinutes = BASELINE_FIXED_MIN
    + panels * BASELINE_MOUNT_PER_PANEL_MIN
    + panels * BASELINE_POWER_PER_PANEL_MIN
    + panels * BASELINE_SIGNAL_PER_PANEL_MIN
    + BASELINE_TEST_MIN
    + BASELINE_FIX_BUFFER_MIN;

  // 削減時間
  const savings = baselineMinutes - totalOnsiteMinutes;
  const savingsPercent = baselineMinutes > 0
    ? Math.round((savings / baselineMinutes) * 100)
    : 0;

  return {
    panels,
    baselineMinutes,
    prepTime: prepTime + prepTest + prepPack,
    prepHours: totalPrepHours,
    onsiteMinutes: totalOnsiteMinutes,
    onsiteHours: totalOnsiteHours,
    totalMinutes: prepTime + prepTest + prepPack + totalOnsiteMinutes,
    savings,
    savingsPercent,
    targetMet: savings >= 30,
  };
}

// ─── 出力生成 ─────────────────────────────────────

function generatePlan(panels = 6) {
  const e = estimate(panels);
  return `# P-0007 LED事前設置 効果検証計画書

## 検証設定

- **LEDパネル枚数**: ${e.panels}枚
- **基準（事前配線なし）想定時間**: ${e.baselineMinutes}分
- **事前配線あり想定時間**: ${e.onsiteMinutes}分（当日のみ）
- **削減見込み**: ${e.savings}分（${e.savingsPercent}%）
- **目標達成**: ${e.targetMet ? '✅ 30分以上削減可' : '❌ 30分未満'}

## 時間見積もり詳細

### 事前配線あり

| フェーズ | 作業 | 時間（分） |
|----------|------|-----------|
| 事前準備（オフサイト） | パネル展開・配置（固定） | ${PREP_FIXED_MIN} |
| 事前準備 | パネル間ケーブル接続（${e.panels}枚×${PREP_PER_PANEL_MIN}分） | ${(e.panels * PREP_PER_PANEL_MIN).toFixed(1)} |
| 事前準備 | 通電テスト | ${PREP_TEST_FIXED_MIN} |
| 事前準備 | 結束・マーキング・保管 | ${PREP_PACK_MIN} |
| **事前合計** | | **${e.prepTime}分（${e.prepHours.toFixed(2)}時間）** |
| 当日設営 | 運搬・展開（固定） | ${ONSITE_FIXED_MIN} |
| 当日設営 | フレーム取付（${e.panels}枚×${MOUNT_PER_PANEL_MIN}分） | ${(e.panels * MOUNT_PER_PANEL_MIN).toFixed(1)} |
| 当日設営 | 主電源接続 | ${ONSITE_MAIN_POWER_MIN} |
| 当日設営 | 通電テスト | ${ONSITE_TEST_MIN} |
| **当日合計** | | **${e.onsiteMinutes}分（${e.onsiteHours.toFixed(2)}時間）** |
| **総合計（事前＋当日）** | | **${e.totalMinutes}分（${(e.totalMinutes/60).toFixed(2)}時間）** |

### 基準（事前配線なし）

| 作業 | 時間（分） |
|------|-----------|
| 運搬・開梱・フレーム取付（固定） | ${BASELINE_FIXED_MIN} |
| パネル取付（${e.panels}枚×${BASELINE_MOUNT_PER_PANEL_MIN}分） | ${(e.panels * BASELINE_MOUNT_PER_PANEL_MIN).toFixed(1)} |
| 電源ケーブル接続（${e.panels}枚×${BASELINE_POWER_PER_PANEL_MIN}分） | ${(e.panels * BASELINE_POWER_PER_PANEL_MIN).toFixed(1)} |
| 信号ケーブル接続（${e.panels}枚×${BASELINE_SIGNAL_PER_PANEL_MIN}分） | ${(e.panels * BASELINE_SIGNAL_PER_PANEL_MIN).toFixed(1)} |
| 通電テスト | ${BASELINE_TEST_MIN} |
| 修正予備 | ${BASELINE_FIX_BUFFER_MIN} |
| **合計** | **${e.baselineMinutes}分（${(e.baselineMinutes/60).toFixed(2)}時間）** |

## 結論

${e.targetMet
  ? `✅ **${e.panels}枚構成では${e.savings}分の削減が見込め、目標30分を達成できます。** 事前配線の導入を推奨します。`
  : `⚠️ **${e.panels}枚構成では${e.savings}分の削減にとどまり、目標30分に達しません。** パネル枚数を増やすか、他の工程削減と組み合わせてください。`
}
`;
}

function generateChecklist() {
  return `# P-0007 LED事前設置 検証チェックリスト

## 事前準備（オフサイト）

- [ ] 使用するLEDパネルをすべて床面に展開する
- [ ] 電源ケーブルの本数・種類を確認する
- [ ] 信号ケーブル（Ethernet/DMX）の本数・種類を確認する
- [ ] パネル間の電源ケーブルを接続する
- [ ] 接続箇所を写真撮影する
- [ ] 制御信号ケーブルを接続する
- [ ] 仮電源に接続し通電テストを実施する
- [ ] 全パネルの表示を確認する
- [ ] ケーブルを結束バンドで束ねる
- [ ] パネルごとにマーキング（識別ラベル）を付ける
- [ ] 安全に折りたたみ・積載状態にする
- [ ] 事前準備の所要時間を計測する（____分）

## 当日設営（会場）

- [ ] 事前配線済みユニットを会場へ運搬する
- [ ] フレーム/トラスに取り付ける
- [ ] 主電源ケーブルを電源ユニットに接続する
- [ ] 通電テストを実施する
- [ ] 全パネルの表示を確認する
- [ ] 当日設営の所要時間を計測する（____分）
- [ ] 配線不良の有無を記録する（____件）

## 検証後

- [ ] 基準時間（事前配線なし）との差を計算する
- [ ] 削減時間が30分以上かを確認する
- [ ] 作業者の負担感をヒアリングする
- [ ] 改善点を記録する
- [ ] 結果を Drive の案件「制作」フォルダに保存する

## 計測記録

| 計測項目 | 値 |
|----------|-----|
| 検証日 | ____年____月____日 |
| 検証場所（事前） | |
| 検証場所（当日） | |
| LEDパネル型番 | |
| パネル枚数 | |
| 事前準備時間（分） | |
| 当日設営時間（分） | |
| 基準時間（分） | |
| 削減時間（分） | |
| 配線不良件数 | |
| 担当者名 | |
`;
}

function generateReport() {
  return `# P-0007 LED事前設置 検証結果報告

## 基本情報

| 項目 | 内容 |
|------|------|
| 検証日 | ____年____月____日 |
| 検証場所（事前準備） | |
| 検証場所（当日設営） | |
| 使用LEDパネル型番 | |
| パネル枚数 | |
| 検証担当者 | |

## 計測結果

| 計測項目 | 時間（分） | 備考 |
|----------|-----------|------|
| 事前準備（オフサイト） | | |
| 当日設営（配線あり） | | |
| 基準（配線なし） | | 過去実績または別日に計測 |
| **削減時間** | | **目標30分以上** |
| 配線不良件数 | | 0件が目標 |

## 評価

- [ ] 目標30分以上の削減を達成
- [ ] 配線不良0件
- [ ] 作業者の負担が軽減された
- [ ] 追加コスト（人件費1.5万円以内）が許容範囲

## 改善点・気づき

1.
2.
3.

## 今後の対応

- [ ] 事前配線を標準手順として採用する
- [ ] 手順書を作成する（写真入り）
- [ ] 見積テンプレートに事前準備費用枠を追加する
`;
}

// ─── CLI ─────────────────────────────────────────

function usage() {
  console.log(`使用方法:
  node tools/p0007-led-verify.mjs --plan              # 検証計画書
  node tools/p0007-led-verify.mjs --checklist         # チェックリスト
  node tools/p0007-led-verify.mjs --estimate <枚数>   # 時間見積もり
  node tools/p0007-led-verify.mjs --report            # 報告テンプレート
  node tools/p0007-led-verify.mjs --all               # すべて出力
`);
}

const args = process.argv.slice(2);
const mode = args[0] || '--help';
const panelCount = parseInt(args[1], 10) || 6;

switch (mode) {
  case '--plan':
    console.log(generatePlan(panelCount));
    break;
  case '--checklist':
    console.log(generateChecklist());
    break;
  case '--estimate': {
    const e = estimate(panelCount);
    console.log(`## LED事前設置 時間見積もり（${e.panels}枚）`);
    console.log(``);
    console.log(`| 項目 | 値 |`);
    console.log(`|------|-----|`);
    console.log(`| パネル枚数 | ${e.panels} |`);
    console.log(`| 基準時間（事前配線なし） | ${e.baselineMinutes}分 |`);
    console.log(`| 事前準備時間（オフサイト） | ${e.prepTime}分 |`);
    console.log(`| 当日設営時間（事前配線あり） | ${e.onsiteMinutes}分 |`);
    console.log(`| 削減時間 | ${e.savings}分（${e.savingsPercent}%） |`);
    console.log(`| 目標30分達成 | ${e.targetMet ? '✅' : '❌'} |`);
    break;
  }
  case '--report':
    console.log(generateReport());
    break;
  case '--all':
    console.log(generatePlan(panelCount));
    console.log('---');
    console.log(generateChecklist());
    console.log('---');
    console.log(generateReport());
    break;
  default:
    usage();
    process.exit(1);
}