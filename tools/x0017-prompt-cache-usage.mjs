#!/usr/bin/env node
// X-0017: プロンプトキャッシュユーティリティ
// キャッシュ状態のチェック、ヒット率の記録・レポート

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DB = join(__dirname, '..', 'outputs', 'X-0017', 'cache-records.jsonl');

function ensureDb() {
  const dir = dirname(CACHE_DB);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadRecords() {
  ensureDb();
  if (!existsSync(CACHE_DB)) return [];
  return readFileSync(CACHE_DB, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function saveRecord(record) {
  ensureDb();
  writeFileSync(CACHE_DB, JSON.stringify(record) + '\n', { flag: 'a' });
}

// --- チェックリスト ---
function checkCacheStatus() {
  const checks = [
    {
      id: 'model_switch',
      label: 'モデル切替',
      description: 'セッション中にモデルを切り替えていないか',
      severity: 'high',
      recommendation: 'セッション開始時にモデルを決定し、終了まで変更しない。切替は会話ID再生成＝全キャッシュ消失。',
    },
    {
      id: 'idle_time',
      label: '長時間中断',
      description: '1時間以上の休憩が入っていないか',
      severity: 'high',
      recommendation: 'キャッシュTTLは約1時間。休憩前は /compact で要約保存。',
    },
    {
      id: 'compact_timing',
      label: 'コンパクトのタイミング',
      description: 'コンパクトを自然な区切りで実行しているか',
      severity: 'medium',
      recommendation: 'コンパクトはPR作成後・タスク完了時など自然な区切りでのみ実行。「とりあえずコンパクト」は禁止。',
    },
    {
      id: 'system_prompt',
      label: 'システムプロンプトの活用',
      description: 'CLAUDE.md/memoryに恒久設定を移せているか',
      severity: 'medium',
      recommendation: '毎回のプロンプト冒頭の前提説明はCLAUDE.mdに移す。システムプロンプトのキャッシュはモデル変更でのみ無効化。',
    },
    {
      id: 'session_purpose',
      label: 'セッション1目的',
      description: '1つのセッションで1つの目的に集中しているか',
      severity: 'low',
      recommendation: '複数目的は別セッションに分割。セッション開始時の目的設定を守る。',
    },
    {
      id: 'check_usage',
      label: 'ヒット率確認',
      description: '/usageでヒット率を定期的に確認しているか',
      severity: 'low',
      recommendation: '2時間ごとに /usage を実行し、ヒット率が50%未満なら改善アクション。',
    },
  ];

  const passed = checks.filter(c => c.severity === 'low').length;
  const failed = checks.length - passed;

  return { checks, passed: 0, total: checks.length };
}

// --- レポート生成 ---
function generateReport() {
  const records = loadRecords();
  if (records.length === 0) {
    return { summary: '記録なし', records: [] };
  }

  const hitRates = records.filter(r => r.hitRate != null).map(r => r.hitRate);
  const avgHitRate = hitRates.length > 0
    ? (hitRates.reduce((a, b) => a + b, 0) / hitRates.length).toFixed(1)
    : null;

  return {
    summary: `全${records.length}件の記録 | 平均ヒット率: ${avgHitRate ?? 'N/A'}%`,
    records,
    avgHitRate: avgHitRate ? parseFloat(avgHitRate) : null,
  };
}

// --- アクション提案 ---
function suggestActions(hitRate) {
  const actions = [];
  if (hitRate == null) {
    actions.push('/usage を実行してヒット率を確認してください');
    return actions;
  }
  if (hitRate < 50) {
    actions.push('🔴 キャッシュが機能していません。モデル切替・長時間中断の履歴を確認。');
    actions.push('→ 同一セッション内でのモデル切替は禁止。別のモデルは別セッションで。');
    actions.push('→ 1時間以上の休憩は /compact してから。');
  } else if (hitRate < 80) {
    actions.push('🟡 改善余地あり。以下の項目を確認：');
    actions.push('→ セッション開始時にモデルを固定しているか');
    actions.push('→ 作業中の自然な区切りで /compact を実行しているか');
    actions.push('→ CLAUDE.md に恒久設定を移行し、毎回の再説明を減らしているか');
  } else {
    actions.push('🟢 良好なキャッシュ利用率です。現在の運用を維持してください。');
  }
  return actions;
}

// --- CLI ---
function usage() {
  console.log(`
使用方法:
  node tools/x0017-prompt-cache-usage.mjs --check      キャッシュ状態のチェックリスト
  node tools/x0017-prompt-cache-usage.mjs --record ... ヒット率を記録
  node tools/x0017-prompt-cache-usage.mjs --report     レポート表示

--record の追加引数:
  --hit-rate <数値>   /usage で確認したヒット率（%）
  --session <ID>      セッションID
  --note <文字列>     備考（モデル切替や中断の有無など）
`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const { checks, total } = checkCacheStatus();
    console.log('=== キャッシュ状態チェックリスト ===\n');
    for (const c of checks) {
      const mark = c.severity === 'high' ? '🔴' : c.severity === 'medium' ? '🟡' : '🟢';
      console.log(`${mark} [${c.id}] ${c.label}`);
      console.log(`   説明: ${c.description}`);
      console.log(`   推奨: ${c.recommendation}`);
      console.log();
    }
    console.log(`全${total}項目 | 推奨アクションは各項目を参照`);
    return;
  }

  if (args.includes('--record')) {
    const hitRateIdx = args.indexOf('--hit-rate');
    const sessionIdx = args.indexOf('--session');
    const noteIdx = args.indexOf('--note');

    const record = {
      timestamp: new Date().toISOString(),
      hitRate: hitRateIdx >= 0 ? parseFloat(args[hitRateIdx + 1]) : undefined,
      session: sessionIdx >= 0 ? args[sessionIdx + 1] : undefined,
      note: noteIdx >= 0 ? args[noteIdx + 1] : undefined,
    };

    if (record.hitRate != null) {
      const actions = suggestActions(record.hitRate);
      saveRecord(record);
      console.log(`記録完了: ${JSON.stringify(record)}`);
      console.log('\n改善アクション:');
      for (const a of actions) console.log(`  ${a}`);
    } else {
      console.error('エラー: --record には --hit-rate が必須です');
      usage();
      process.exit(1);
    }
    return;
  }

  if (args.includes('--report')) {
    const report = generateReport();
    console.log(`=== キャッシュレポート ===`);
    console.log(report.summary);
    if (report.records.length > 0) {
      console.log(`\n記録一覧（降順）:`);
      for (const r of report.records.slice().reverse()) {
        const hitStr = r.hitRate != null ? `${r.hitRate}%` : 'N/A';
        const sessionStr = r.session ? ` (${r.session})` : '';
        console.log(`  ${r.timestamp.slice(0, 16)} | ヒット率: ${hitStr}${sessionStr}${r.note ? ` | ${r.note}` : ''}`);
      }
      if (report.avgHitRate != null) {
        console.log(`\n改善アクション（平均ヒット率 ${report.avgHitRate}% 基準）:`);
        for (const a of suggestActions(report.avgHitRate)) console.log(`  ${a}`);
      }
    }
    return;
  }

  usage();
}

main();