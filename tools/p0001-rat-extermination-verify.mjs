#!/usr/bin/env node
/**
 * P-0001: ネズミ駆除作業の同日完了可否検証 — シミュレーション支援ツール
 *
 * 使用方法:
 *   node tools/p0001-rat-extermination-verify.mjs --plan              # 検証計画書
 *   node tools/p0001-rat-extermination-verify.mjs --checklist         # チェックリスト
 *   node tools/p0001-rat-extermination-verify.mjs --estimate [開口部数] [作業員数]  # 時間見積もり
 *   node tools/p0001-rat-extermination-verify.mjs --simulate <シナリオ番号>  # シナリオシミュレーション
 *   node tools/p0001-rat-extermination-verify.mjs --report            # 報告テンプレート
 *   node tools/p0001-rat-extermination-verify.mjs --all               # すべて出力
 *
 * 出力先: stdout
 */

// ─── 設定値 ───────────────────────────────────────

/** 開口部1箇所あたりの事前封鎖時間（分）：くん煙漏れ防止 */
const PRE_SEAL_PER_OPENING_MIN = 10;

/** 開口部1箇所あたりの事後封鎖時間（分）：くん煙用解放部分の本封鎖 */
const POST_SEAL_PER_OPENING_MIN = 15;

/** 開口部1箇所あたりの点検時間（分） */
const INSPECT_PER_OPENING_MIN = 3;

/** 煙式くん煙の作用待機時間（分） */
const SMOKE_FUMIGATION_WAIT_MIN = 60;

/** ガス式くん煙の作用待機時間（分） */
const GAS_FUMIGATION_WAIT_MIN = 120;

/** 換気時間（分） */
const VENTILATION_MIN = 20;

/** 準備・撤収の固定時間（分） */
const SETUP_FIXED_MIN = 30;

/** 同日完了の基準時間（分）：8時間 */
const SAME_DAY_LIMIT_MIN = 480;

/** 建物規模ごとの開口部数（既定） */
const BUILDING_OPENINGS = { small: 5, medium: 8, large: 15 };

const BUILDING_LABELS = { small: '小（30㎡未満）', medium: '中（30〜100㎡）', large: '大（100㎡超）' };

// ─── 既定シナリオ ─────────────────────────────────

const SCENARIOS = [
  { id: 1, name: '標準（小規模倉庫）', building: 'small', openings: 5, workers: 3, method: 'smoke', preSealRate: 0.7 },
  { id: 2, name: '標準（中規模倉庫）', building: 'medium', openings: 8, workers: 3, method: 'smoke', preSealRate: 0.7 },
  { id: 3, name: '厳しい条件', building: 'large', openings: 15, workers: 3, method: 'gas', preSealRate: 0.6 },
  { id: 4, name: '人員増強', building: 'large', openings: 15, workers: 5, method: 'gas', preSealRate: 0.7 },
  { id: 5, name: '最大効率', building: 'large', openings: 15, workers: 6, method: 'smoke', preSealRate: 0.8 },
];

// ─── 計算ロジック ─────────────────────────────────

/**
 * 開口部数・作業員数・くん煙方法・事前封鎖率から時間見積もりを計算
 * @param {number} openings 開口部数（出入口・窓・通気口等の合計）
 * @param {number} workers 封鎖作業に従事する人数
 * @param {'smoke'|'gas'} method くん煙方法
 * @param {number} preSealRate 事前封鎖率（0〜100%）
 * @returns {object} 見積もり結果
 */
function estimate(openings, workers, method = 'smoke', preSealRate = 0.7) {
  const preOpenings = Math.ceil(openings * preSealRate);
  const postOpenings = openings - preOpenings;

  // 事前封鎖時間
  const preSealTime = Math.ceil((preOpenings * PRE_SEAL_PER_OPENING_MIN) / workers);
  // くん煙時間
  const fumigationWait = method === 'gas' ? GAS_FUMIGATION_WAIT_MIN : SMOKE_FUMIGATION_WAIT_MIN;
  const fumigationTime = fumigationWait + VENTILATION_MIN;
  // 事後封鎖時間
  const postSealTime = Math.ceil((postOpenings * POST_SEAL_PER_OPENING_MIN) / workers);
  // 点検時間
  const inspectTime = Math.ceil((openings * INSPECT_PER_OPENING_MIN) / workers);
  // 固定時間
  const fixedTime = SETUP_FIXED_MIN;

  const totalMinutes = fixedTime + preSealTime + fumigationTime + postSealTime + inspectTime;
  const sameDay = totalMinutes <= SAME_DAY_LIMIT_MIN;

  const timeline = [
    { phase: '準備・資材確認', start: 0, duration: fixedTime, end: fixedTime },
    { phase: '事前封鎖', start: fixedTime, duration: preSealTime, end: fixedTime + preSealTime },
    { phase: method === 'gas' ? 'ガスくん煙' : '煙式くん煙', start: fixedTime + preSealTime, duration: fumigationWait, end: fixedTime + preSealTime + fumigationWait },
    { phase: '換気', start: fixedTime + preSealTime + fumigationWait, duration: VENTILATION_MIN, end: fixedTime + preSealTime + fumigationTime },
    { phase: '事後封鎖', start: fixedTime + preSealTime + fumigationTime, duration: postSealTime, end: fixedTime + preSealTime + fumigationTime + postSealTime },
    { phase: '点検・確認', start: fixedTime + preSealTime + fumigationTime + postSealTime, duration: inspectTime, end: totalMinutes },
  ];

  return {
    openings,
    workers,
    preOpenings,
    postOpenings,
    preSealRate,
    method,
    methodLabel: method === 'gas' ? 'ガス式' : '煙式',
    fixedTime,
    preSealTime,
    fumigationTime,
    fumigationWait,
    postSealTime,
    inspectTime,
    totalMinutes,
    totalHours: (totalMinutes / 60).toFixed(1),
    sameDay,
    timeline,
    remainingBudget: Math.max(0, SAME_DAY_LIMIT_MIN - totalMinutes),
  };
}

/**
 * 建物規模から既定の開口部数を取得
 */
function getOpeningsForBuilding(size) {
  return BUILDING_OPENINGS[size] || BUILDING_OPENINGS.medium;
}

// ─── 出力生成 ─────────────────────────────────────

function generatePlan(openings = 8, workers = 3, method = 'smoke', preSealRate = 0.7) {
  const e = estimate(openings, workers, method, preSealRate);
  const intensity = preSealRate >= 0.8 ? '高' : preSealRate >= 0.6 ? '中' : '低';
  const meeting = e.sameDay
    ? `✅ **同日完了可能**（残り余裕: ${e.remainingBudget}分）`
    : `❌ **同日完了不可**（超過: ${-e.remainingBudget}分）`;

  return `# P-0001 ネズミ駆除 同日完了可否検証計画書

## 検証設定

- **開口部数**: ${e.openings}箇所（事前封鎖: ${e.preOpenings} / 事後封鎖: ${e.postOpenings}）
- **作業員数**: ${e.workers}名
- **くん煙方法**: ${e.methodLabel}
- **事前封鎖率**: ${(e.preSealRate * 100)}%（${intensity}）
- **同日完了基準**: ${SAME_DAY_LIMIT_MIN}分（8時間）

## 時間見積もり詳細

### 総所要時間: ${e.totalMinutes}分（${e.totalHours}時間）

| フェーズ | 作業 | 所要時間（分） |
|----------|------|---------------|
| 準備 | 資材確認・安全装備準備 | ${e.fixedTime} |
| 事前封鎖 | ${e.preOpenings}箇所 × ${PRE_SEAL_PER_OPENING_MIN}分 ÷ ${e.workers}名 | ${e.preSealTime} |
| ${e.methodLabel}くん煙 | 薬剤作用待機（${e.fumigationWait}分） | ${e.fumigationWait} |
| 換気 | 強制換気 | ${VENTILATION_MIN} |
| 事後封鎖 | ${e.postOpenings}箇所 × ${POST_SEAL_PER_OPENING_MIN}分 ÷ ${e.workers}名 | ${e.postSealTime} |
| 点検・確認 | ${e.openings}箇所 × ${INSPECT_PER_OPENING_MIN}分 ÷ ${e.workers}名 | ${e.inspectTime} |
| **合計** | | **${e.totalMinutes}分** |

### タイムライン（分単位）

${e.timeline.map(t => `| ${t.phase.padEnd(16)} | ${t.start}分〜${t.end}分（${t.duration}分） |`).join('\n')}

## 判定

${meeting}

## 推奨事項

${!e.sameDay
  ? `### 人員不足のため同日完了不可 → 以下の対策を推奨

| 対策 | 効果 |
|------|------|
| 作業員を${e.workers + 1}名以上に増やす | 封鎖時間が約${Math.round(e.preSealTime + e.postSealTime - (Math.ceil(e.preOpenings * PRE_SEAL_PER_OPENING_MIN / (e.workers + 1)) + Math.ceil(e.postOpenings * POST_SEAL_PER_OPENING_MIN / (e.workers + 1))))}分短縮 |
| 事前封鎖率を80%以上に向上 | 事後封鎖時間が減少 |
| 煙式くん煙に変更（安全上可能な場合） | 待機時間が${GAS_FUMIGATION_WAIT_MIN - SMOKE_FUMIGATION_WAIT_MIN}分短縮 |
| 前日に事前封鎖の一部を実施 | 当日の負荷を軽減 |`
  : `### 同日完了可能

- **余裕時間**: ${e.remainingBudget}分（休憩・遅延バッファとして活用可能）
- **推奨人員**: ${e.workers}名で十分。予備員1名の確保を推奨`
}
`;
}

function generateChecklist() {
  return `# P-0001 ネズミ駆除 同日完了チェックリスト

## 事前準備（前日〜当日朝）

- [ ] 建物の開口部をすべて調査・リスト化する
- [ ] 開口部のサイズ・種類（出入口/窓/通気口/配管貫通）を記録する
- [ ] 封鎖資材（金網・ウレタンフォーム・パテ・防鼠材）を準備する
- [ ] くん煙器・ガスボンベ・安全装備を点検する
- [ ] 作業員の出欠を確認する
- [ ] ツールでシミュレーションを実行し、人員充足を確認する
- [ ] 天気予報を確認する（雨天時はくん煙中止）

## 事前封鎖（くん煙前）

- [ ] 大部分の開口部を事前封鎖する（くん煙漏れ防止、目標${Math.round(0.7 * 100)}%以上）
- [ ] くん煙用に解放する開口部を確保する（排気口となるべく離れた位置に1〜2箇所）
- [ ] 事前封鎖の完了確認を行う
- [ ] 封鎖時間を計測する（____分）

## くん煙処理

- [ ] くん煙器を設置・点火／ガスを噴射する
- [ ] 作業員は退避する
- [ ] 作用時間を計測する（煙式60分/ガス式120分）
- [ ] 周辺に人が立ち入らないよう警告表示を設置する

## 換気

- [ ] 窓・出入口を開放し強制換気を開始する
- [ ] 換気時間（20分）を計測する
- [ ] ガス検知器で安全を確認する（ガス式の場合）

## 事後封鎖（くん煙後）

- [ ] PPE（マスク・手袋）を着用する
- [ ] くん煙用に開けていた開口部を封鎖する
- [ ] 封鎖が不完全な箇所を補強する
- [ ] 各開口部の封鎖時間を記録する（____分/箇所）

## 点検・確認

- [ ] 全封鎖箇所を点検する（隙間・浮きがないか）
- [ ] 封鎖の写真を撮影する
- [ ] 完了時間を記録する
- [ ] 同日完了したか確認する（基準: 開始から${SAME_DAY_LIMIT_MIN}分以内）

## 事後対応

- [ ] 封鎖後1週間以内に再侵入がないか確認する
- [ ] 問題があれば補修する
- [ ] 次回改善点を記録する
`;
}

function generateTimelineTable(scenario, e) {
  const timeStr = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  };

  return `## シナリオ${scenario.id}: ${scenario.name}

| 項目 | 値 |
|------|-----|
| 建物規模 | ${BUILDING_LABELS[scenario.building]} |
| 開口部数 | ${e.openings}箇所 |
| 事前封鎖対象 | ${e.preOpenings}箇所（${(e.preSealRate * 100)}%） |
| 事後封鎖対象 | ${e.postOpenings}箇所（${((1 - e.preSealRate) * 100)}%） |
| 作業員 | ${e.workers}名 |
| くん煙方法 | ${e.methodLabel} |
| **総所要時間** | **${e.totalMinutes}分（${e.totalHours}時間）** |
| 同日完了 | ${e.sameDay ? '✅ 可' : '❌ 不可'} |
${e.sameDay ? `| 余裕時間 | ${e.remainingBudget}分 |` : `| 超過時間 | ${-e.remainingBudget}分 |`}

### タイムライン

| 時間 | フェーズ |
|------|----------|
| ${timeStr(0)}〜${timeStr(e.fixedTime)} | 準備・資材確認 |
| ${timeStr(e.fixedTime)}〜${timeStr(e.fixedTime + e.preSealTime)} | 事前封鎖（${e.preSealTime}分） |
| ${timeStr(e.fixedTime + e.preSealTime)}〜${timeStr(e.fixedTime + e.preSealTime + e.fumigationWait)} | ${e.methodLabel}くん煙 作用待機（${e.fumigationWait}分） |
| ${timeStr(e.fixedTime + e.preSealTime + e.fumigationWait)}〜${timeStr(e.fixedTime + e.preSealTime + e.fumigationWait + VENTILATION_MIN)} | 換気（${VENTILATION_MIN}分） |
| ${timeStr(e.fixedTime + e.preSealTime + e.fumigationTime)}〜${timeStr(e.fixedTime + e.preSealTime + e.fumigationTime + e.postSealTime)} | 事後封鎖（${e.postSealTime}分） |
| ${timeStr(e.fixedTime + e.preSealTime + e.fumigationTime + e.postSealTime)}〜${timeStr(e.totalMinutes)} | 点検・確認（${e.inspectTime}分） |
`;
}

function generateAllScenarios() {
  let output = '# P-0001 ネズミ駆除 シナリオシミュレーション一覧\n\n';
  for (const s of SCENARIOS) {
    const e = estimate(s.openings, s.workers, s.method, s.preSealRate);
    output += generateTimelineTable(s, e) + '\n---\n\n';
  }

  // 総合比較表
  output += `## 総合比較

| # | シナリオ | 建物 | 開口部 | 作業員 | 方法 | 総時間 | 同日 | 余裕 |
|---|---------|------|--------|--------|------|--------|------|------|\n`;
  for (const s of SCENARIOS) {
    const e = estimate(s.openings, s.workers, s.method, s.preSealRate);
    output += `| ${s.id} | ${s.name} | ${BUILDING_LABELS[s.building]} | ${e.openings} | ${e.workers}名 | ${e.methodLabel} | ${e.totalMinutes}分 | ${e.sameDay ? '✅' : '❌'} | ${e.sameDay ? `+${e.remainingBudget}分` : `-${-e.remainingBudget}分`} |\n`;
  }
  return output;
}

function generateReport() {
  return `# P-0001 ネズミ駆除 同日完了検証結果報告

## 基本情報

| 項目 | 内容 |
|------|------|
| 実施日 | ____年____月____日 |
| 現場住所 | |
| 建物規模 | 小 / 中 / 大 |
| 開口部数 | ____箇所 |
| 作業員数 | ____名 |
| くん煙方法 | 煙式 / ガス式 |
| 事前封鎖率 | ____%（____/____箇所） |
| 検証担当者 | |

## 計測結果

| 計測項目 | 計画値（分） | 実測値（分） | 差分（分） |
|----------|------------|------------|-----------|
| 準備・資材確認 | | | |
| 事前封鎖 | | | |
| くん煙待機 | | | |
| 換気 | | | |
| 事後封鎖 | | | |
| 点検・確認 | | | |
| **総所要時間** | | | |

## 評価

- [ ] 同日完了（くん煙開始から封鎖完了まで同日）
- [ ] シミュレーション誤差が±15%以内
- [ ] 人員に過不足なし
- [ ] 封鎖品質に問題なし

## 問題点・気づき

1.
2.
3.

## 改善提案

1.
2.
3.
`;
}

function generateEstimateOutput(openings = 8, workers = 3) {
  const e = estimate(openings, workers, 'smoke', 0.7);
  return `## ネズミ駆除 時間見積もり

| 項目 | 値 |
|------|-----|
| 開口部数 | ${e.openings}箇所 |
| 作業員数 | ${e.workers}名 |
| くん煙方法 | ${e.methodLabel}（作用待機${e.fumigationWait}分） |
| 事前封鎖率 | ${(e.preSealRate * 100)}%（${e.preOpenings}/${e.openings}箇所） |
| 準備 | ${e.fixedTime}分 |
| 事前封鎖 | ${e.preSealTime}分 |
| くん煙＋換気 | ${e.fumigationTime}分（待機${e.fumigationWait}＋換気${VENTILATION_MIN}） |
| 事後封鎖 | ${e.postSealTime}分 |
| 点検 | ${e.inspectTime}分 |
| **総所要時間** | **${e.totalMinutes}分（${e.totalHours}時間）** |
| 同日完了（${SAME_DAY_LIMIT_MIN}分以内） | ${e.sameDay ? '✅ 可' : '❌ 不可'} |
| ${e.sameDay ? '余裕時間' : '超過時間'} | ${e.sameDay ? `+${e.remainingBudget}分` : `-${-e.remainingBudget}分`} |
`;
}

// ─── CLI ─────────────────────────────────────────

function usage() {
  console.log(`使用方法:
  node tools/p0001-rat-extermination-verify.mjs --plan                    # 検証計画書（標準設定）
  node tools/p0001-rat-extermination-verify.mjs --plan <開口部数> <作業員数> [煙式|ガス式] [事前封鎖率]  # 検証計画書（カスタム）
  node tools/p0001-rat-extermination-verify.mjs --checklist               # チェックリスト
  node tools/p0001-rat-extermination-verify.mjs --estimate [開口部数] [作業員数]  # 時間見積もり（既定: 8箇所・3名）
  node tools/p0001-rat-extermination-verify.mjs --simulate <1-5>          # シナリオシミュレーション（1〜5）
  node tools/p0001-rat-extermination-verify.mjs --simulate all            # 全5シナリオ
  node tools/p0001-rat-extermination-verify.mjs --report                  # 報告テンプレート
  node tools/p0001-rat-extermination-verify.mjs --all                     # すべて出力
`);
}

const args = process.argv.slice(2);
const mode = args[0] || '--help';

switch (mode) {
  case '--plan': {
    const openings = parseInt(args[1], 10) || 8;
    const workers = parseInt(args[2], 10) || 3;
    const method = args[3] === 'ガス式' ? 'gas' : (args[3] === 'gas' ? 'gas' : 'smoke');
    const preSealRate = parseFloat(args[4]) || 0.7;
    console.log(generatePlan(openings, workers, method, preSealRate));
    break;
  }
  case '--checklist':
    console.log(generateChecklist());
    break;
  case '--estimate': {
    const openings = parseInt(args[1], 10) || 8;
    const workers = parseInt(args[2], 10) || 3;
    console.log(generateEstimateOutput(openings, workers));
    break;
  }
  case '--simulate': {
    const which = args[1];
    if (which === 'all') {
      console.log(generateAllScenarios());
    } else {
      const idx = parseInt(which, 10) - 1;
      const scenario = SCENARIOS[idx];
      if (!scenario) {
        console.error(`エラー: シナリオ ${which} は存在しません（1〜5 または all）`);
        process.exit(1);
      }
      const e = estimate(scenario.openings, scenario.workers, scenario.method, scenario.preSealRate);
      console.log(generateTimelineTable(scenario, e));
    }
    break;
  }
  case '--report':
    console.log(generateReport());
    break;
  case '--all':
    console.log(generatePlan());
    console.log('---');
    console.log(generateChecklist());
    console.log('---');
    console.log(generateAllScenarios());
    console.log('---');
    console.log(generateReport());
    break;
  default:
    usage();
    process.exit(1);
}