#!/usr/bin/env node
/**
 * benchmark-20tasks.mjs — 自社20タスクコストベンチマーク [X-0096]
 *
 * 株式会社オージャストの過去ブース提案・イベント企画から抽出した20の実タスクを、
 * 同一プロンプト・同一評価基準で複数LLMプロバイダで実行し、
 * cost per passed task でランク付けする。
 *
 * 使い方:
 *   node tools/benchmark-20tasks.mjs --quick        # 9 calls (1 provider × 9 tasks)
 *   node tools/benchmark-20tasks.mjs --quick --all   # 20 calls (1 provider × all tasks)
 *   node tools/benchmark-20tasks.mjs --full          # 全プロバイダ × 全タスク
 *   node tools/benchmark-20tasks.mjs --provider gemini  # 特定プロバイダのみ
 *   node tools/benchmark-20tasks.mjs --provider groq --task booth-plan-01  # 特定タスクのみ
 *
 * 出力: CSV + サマリ（stdout） + 詳細ログ（stderr）
 */

import { isEntry } from './is-entry.mjs';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

const LLM_ASK = fileURLToPath(new URL('./llm-ask.mjs', import.meta.url));
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// プロバイダ定義 (llm-ask.mjs と整合)
// ============================================================
const PROVIDERS = {
  gemini:  { provider: 'gemini',  model: 'gemini-3.6-flash',   label: 'Gemini 3.6 Flash' },
  groq:    { provider: 'groq',    model: 'openai/gpt-oss-120b',label: 'Groq (OSS 120B)' },
  openrouter: { provider: 'openrouter', model: 'openai/gpt-oss-120b', label: 'OpenRouter GPT OSS 120B' },
  deepseek: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  kimi:    { provider: 'openrouter', model: 'moonshotai/kimi-k3', label: 'Kimi K3' },
  mistral: { provider: 'openrouter', model: 'mistralai/mistral-medium-3.1', label: 'Mistral Medium 3.1' },
  claude_haiku: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
};

const DEFAULT_PROVIDERS = ['gemini', 'groq', 'deepseek', 'kimi'];

// ============================================================
// 20タスク定義（オージャスト実業務ベース）
// ============================================================
function makeJudge(keyword, minLen = 30) {
  return (text) => text.toLowerCase().includes(keyword.toLowerCase()) && text.trim().length > minLen;
}

const TASKS = [
  // -------- ブース企画（creative）: 6 tasks --------
  {
    id: 'booth-plan-01',
    category: 'creative',
    prompt: `あなたは展示会ブースデザイナーで���。IT企業（製品: AIチャットボット）の3m×3mブースのコンセプトを考えてください。以下の要素を含めて: ブース全体のテーマ（1文）、来場者の導線設計（ゾーニング）、使用する展示機材・備品、グラフィックパネルの構成、予算感（150-200万円想定）。200字程度で簡潔に。`,
    expected: 'ブース',
    evalFn: (t) => t.includes('ブース') && t.includes('展示') && t.length > 80,
  },
  {
    id: 'booth-plan-02',
    category: 'creative',
    prompt: `食品メーカー（発酵食品）の6m×3mブース企画を考えてください。来場者を引きつける仕掛け（演出要素）、商談スペースと展示ゾーンのバランス、試食コーナーの衛生設計、予算250-350万円の配分案。200字程度で。`,
    expected: 'ブース',
    evalFn: (t) => t.includes('ブース') && t.length > 80,
  },
  {
    id: 'booth-plan-03',
    category: 'creative',
    prompt: `産業機械メーカー（工作機械）の9m×6mブース企画です。実機デモを安全に見せる動線計画、商談スペース（6席以上）の配置、安全柵とデモエリアのゾーニング、搬入搬出ルートの考慮。予算500-700万円。250字程度で。`,
    expected: 'デモ',
    evalFn: (t) => t.includes('デモ') && t.includes('安全') && t.length > 100,
  },
  {
    id: 'booth-plan-04',
    category: 'creative',
    prompt: `環境素材メーカーの6m×6mブース企画です。サステナビリティをテーマに、再利用可能な部材を使用した展示空間。来場者が素材の循環プロセスを体験できる回遊型展示、実物サンプルと映像の連動。予算300-400万円。200字程度で。`,
    expected: '素材',
    evalFn: (t) => t.includes('展示') && t.length > 80,
  },
  {
    id: 'booth-plan-05',
    category: 'creative',
    prompt: `スタートアップ（VR/AR製品）の2小間（6m×3m）ブース企画。製品体験を主役にしたレイアウト、待機列と体験エリアの分離、商談スペースの効率的配置、限られた予算150-200万円での最大効果。150字程度で。`,
    expected: '体験',
    evalFn: (t) => t.includes('体験') && t.includes('ブース') && t.length > 60,
  },
  {
    id: 'booth-plan-06',
    category: 'creative',
    prompt: `医療機器メーカーの小規模ブース（3m×3m）企画。限られたスペースで製品の精度・信頼性を伝える展示デザイン、清潔感のある色調・素材選び、商談1〜2席の配置。予算100-150万円。150字程度で。`,
    expected: 'ブース',
    evalFn: (t) => t.includes('ブース') && t.length > 60,
  },

  // -------- 分類・抽出（extraction）: 5 tasks --------
  {
    id: 'extract-01',
    category: 'extraction',
    prompt: `次のヒアリングメモから、以下の��目を抽出してJSONで出力してください:
- 要望: リスト
- 予算感: 文字列
- 希望時期: 文字列
- 懸念点: リスト
メモ: 「展示会のブースを新しくしたい。今使っているのは10年前のもので古臭い。予算は200-300万円。来年3月の展示会に間に合えばいい。予算が限られているのでコストを抑えたい。前回はデザインがイマイチだったのでモダンにしたい。あと、隣のブースより目立ちたい。」
回答はJSONのみ。`,
    expected: '要望',
    evalFn: (t) => t.includes('予算') && t.includes('要望') && t.includes('希望時期'),
  },
  {
    id: 'extract-02',
    category: 'extraction',
    prompt: `以下の展示会出展検討メールから、要件を抽出してJSONで出力:
- company: 会社名
- event: 展示会名
- booth_size: 希望ブースサイズ
- budget_range: 予算範囲
- timeline: スケジュール
メール: 「株式会社テクノスの中村です。来年10月の国際ロボット展に出展を検討しています。ブースは6m×9m程度、予算は600-800万円を想定。企画提案を8月末までにいただきたいです。実機デモを中心にしたブースを希望しています。」
回答はJSONのみ。`,
    expected: '展示会',
    evalFn: (t) => t.includes('company') && t.includes('event') && t.includes('budget'),
  },
  {
    id: 'extract-03',
    category: 'extraction',
    prompt: `次のブース写真のメモから問題点を抽出しJSONで報告:
- good_points: リスト（良い点）
- issues: リスト（問題点）
- priority: high/medium/low
- suggestions: リスト（改善案）
メモ: 「写真1: 正面パネルが白一色で印象が薄い。写真2: 商談スペースと通路の区別が曖昧。写真3: 照明が暗く製品が目立たない。写真4: 受付カウンター前に人が溜まって動線を塞いでいる。」
回答はJSONのみ。`,
    expected: 'good_points',
    evalFn: (t) => t.includes('issues') && t.includes('priority') && t.includes('suggestions'),
  },
  {
    id: 'extract-04',
    category: 'extraction',
    prompt: `以下の展示会出展計画から、必要なアクションアイテムを抽出してJSONで出力:
- deadline: 最も早い締切
- action_items: リスト（各項目に担当者と期限）
- budget_items: 主要費用項目（金額）
計画: 「2027年4月の制造ワールドに出展。ブース申込締切は2月末。企画提案書は1月末までに提出。予算総額450万円（ブース代250万、備品100万、グラフィック50万、その他50万）。搬入は4/12、実施4/13-15、撤去4/16。」
回答はJSONのみ。`,
    expected: 'action_items',
    evalFn: (t) => t.includes('deadline') && t.includes('action_items') && t.includes('budget_items'),
  },
  {
    id: 'extract-05',
    category: 'extraction',
    prompt: `次の競合他社の展示レポートから、差別化ポイントを抽出してJSONで出力:
- competitors: リスト（各社の特徴・強み）
- our_advantage: 当社の差別化できる点
- risk: リスク要因
- recommendation: 推奨戦略
レポート: 「A社は大型モニターと体験型デモで集客。B社は商談ブースで落ち着いた対応。C社は目立つブースデザイン。当社は実績パネルとカタログ中心だが、他社と差がついていない。予算的に大規模改装は難しいが、デジタルサイネージ導入と実機デモ追加は可能。」
回答はJSONのみ。`,
    expected: 'competitors',
    evalFn: (t) => t.includes('competitors') && t.includes('recommendation'),
  },

  // -------- 文書生成（document）: 5 tasks --------
  {
    id: 'doc-gen-01',
    category: 'document',
    prompt: `展示会ブースの見積書に含むべき項目リストを簡潔に箇条書きで5項目挙げてください。各項目に簡単な説明（1行）を付けて。`,
    expected: '項目',
    evalFn: (t) => t.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•') || l.trim().startsWith('*') || /^\d+[\.\)]/.test(l.trim())).length >= 4,
  },
  {
    id: 'doc-gen-02',
    category: 'document',
    prompt: `展示会ブース制作のスケジュール表をマークダウン形式で作成してください。期間: 2027年1月〜3月（3ヶ月間）。必要なフェーズ: 企画→設計→制作→設置→撤去。マイルストーンを月単位で。`,
    expected: '月',
    evalFn: (t) => t.includes('月') && t.length > 100,
  },
  {
    id: 'doc-gen-03',
    category: 'document',
    prompt: `展示会終了後の報告書（事後レポート）のテンプレートを作成してください。含むべきセクション: イベント概要、来場者数・商談数、獲得リード数、写真・動画記録、良かった点・改善点、次回へのアクション。各セクションの説明を1〜2行で。`,
    expected: 'レポート',
    evalFn: (t) => t.includes('セクション') && t.length > 120,
  },
  {
    id: 'doc-gen-04',
    category: 'document',
    prompt: `ブース施工の安全計画書を簡潔に作成してください。項目: 作業手順、安全装備一覧、緊急時対応、役割分担、作業前点検リスト。施工場所: 東京ビッグサイト。期間: 3日間。`,
    expected: '安全',
    evalFn: (t) => t.includes('安全') && t.length > 100,
  },
  {
    id: 'doc-gen-05',
    category: 'document',
    prompt: `展示会用のプレスリリース案を簡潔に作成してください。この展示会で新しい製品ラインを発表する想定です。含める要素: 発表内容の概要、製品の特長（3点）、展示ブースの見どころ、会社概要。150-200字程度。`,
    expected: '展示',
    evalFn: (t) => t.includes('展示') && t.length > 80,
  },

  // -------- イベント運営（operations）: 4 tasks --------
  {
    id: 'ops-01',
    category: 'operations',
    prompt: `展示会3日間の運営シフト表を作成してください。スタッフ6名、9:00-18:00（最終日は17:00まで）。必要な役割: 受付担当、デモ実演担当、商談対応、案内誘導。休憩時間のローテーションも含めて。`,
    expected: '担当',
    evalFn: (t) => t.includes('担当') && t.length > 100,
  },
  {
    id: 'ops-02',
    category: 'operations',
    prompt: `展示会ブースの搬入計画を簡潔に作成してください。搬入日: 4月12日（9:00-18:00）。搬入物: 造作パネル、展示ケース、モニター3台、カタログ500部、備品類。車両: 2トン車1台。搬入経路: 東ホール搬入口B。注意点も含めて。`,
    expected: '搬入',
    evalFn: (t) => t.includes('搬入') && t.length > 80,
  },
  {
    id: 'ops-03',
    category: 'operations',
    prompt: `展示会のリード獲得後のフォローアップ計画を簡潔に作成してください。目標: 獲得した名刺200件を1週間以内にフォロー。フェーズ: 初日メール、3日後電話、1週間後資料送付、2週間後訪問調整。メールの要点と電話トークのポイントも含めて。`,
    expected: 'フォロー',
    evalFn: (t) => (t.includes('フォロー') || t.includes('follow')) && t.length > 80,
  },
  {
    id: 'ops-04',
    category: 'operations',
    prompt: `展示会出展のチェックリストを作成してください。期間: 出展3ヶ月前〜当日。カテゴリ別に: 企画・申込、デザイン設計、制作発注、会場手配、運用準備、事後対応。各項目に期限を付けて。`,
    expected: 'チェック',
    evalFn: (t) => (t.includes('チェック') || t.includes('確認')) && t.length > 100,
  },
];

// ============================================================
// 実行エンジン
// ============================================================
const DEFAULT_TIMEOUT_MS = 45000;

async function runTask(providerKey, task, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const p = PROVIDERS[providerKey];
  if (!p) return { task_id: task.id, provider: providerKey, passed: 0, error: `Unknown provider: ${providerKey}` };

  const start = Date.now();
  try {
    const args = [
      LLM_ASK, '--provider', p.provider, '--model', p.model,
      '--max', '800', '--no-fallback',
      task.prompt,
    ];
    const { stdout, stderr } = await execute(process.execPath, args, {
      env: process.env, maxBuffer: 1024 * 100, timeout: timeoutMs,
    });
    const content = stdout || '';
    const passed = task.evalFn(content) ? 1 : 0;
    const tokMatch = stderr.match(/in=(\d+)\s+out=(\d+)/);
    const inTok = tokMatch ? parseInt(tokMatch[1]) : 0;
    const outTok = tokMatch ? parseInt(tokMatch[2]) : 0;
    return {
      task_id: task.id, category: task.category, provider: providerKey,
      label: p.label, model: p.model,
      passed, content_length: content.length,
      input_tokens: inTok, output_tokens: outTok,
      elapsed_ms: Date.now() - start,
      preview: content.slice(0, 60).replace(/\n/g, ' '),
    };
  } catch (err) {
    return {
      task_id: task.id, category: task.category, provider: providerKey,
      label: p.label, model: p.model,
      passed: 0, content_length: 0,
      input_tokens: 0, output_tokens: 0,
      elapsed_ms: Date.now() - start,
      error: err.message?.slice(0, 100) || String(err).slice(0, 100),
    };
  }
}

// ============================================================
// コスト推定（OpenRouterベース参考値）
// ============================================================
function estimateCost(inTok, outTok, provider) {
  const rates = {
    gemini:  { in: 0.10e-6, out: 0.40e-6 },   // Gemini Flash ~$0.10/M in
    groq:    { in: 0,       out: 0 },           // 無料枠
    openrouter: { in: 3e-6, out: 15e-6 },       // 汎用モデル参考
    deepseek: { in: 0.50e-6, out: 2e-6 },       // DeepSeek via OR
    kimi:    { in: 1.50e-6, out: 6e-6 },        // Kimi via OR
    mistral: { in: 2e-6, out: 8e-6 },           // Mistral via OR
    claude_haiku: { in: 2.50e-6, out: 10e-6 },  // Claude Haiku via OR
  };
  const r = rates[provider] || rates.openrouter;
  return inTok * r.in + outTok * r.out;
}

// ============================================================
// サマリ生成
// ============================================================
function formatCSV(results) {
  const header = 'task_id,category,provider,model,passed,content_length,input_tokens,output_tokens,elapsed_ms,cost_est';
  const rows = results.map(r => {
    const cost = estimateCost(r.input_tokens || 0, r.output_tokens || 0, r.provider);
    return `"${r.task_id}","${r.category}","${r.provider}","${r.label}",${r.passed || 0},${r.content_length || 0},${r.input_tokens || 0},${r.output_tokens || 0},${r.elapsed_ms || 0},${cost.toFixed(8)}`;
  });
  return header + '\n' + rows.join('\n');
}

function summarize(results) {
  const byProvider = {};
  for (const r of results) {
    if (!r.provider) continue;
    byProvider[r.provider] = byProvider[r.provider] || [];
    byProvider[r.provider].push(r);
  }

  const lines = ['\n' + '='.repeat(70)];
  lines.push('  自社20タスク コストベンチマーク結果 [X-0096]');
  lines.push('='.repeat(70) + '\n');

  // プロバイダ別集計
  lines.push('【プロバイダ別パフォーマンス】');
  lines.push('プロバイダ | モデル | タスク数 | pass(率) | 総トークン | 推定コスト($) | 平均応答(ms) | cost/passed($)');
  lines.push('---');

  const providerOrder = Object.keys(byProvider).sort();
  const costPerPassed = [];

  for (const pk of providerOrder) {
    const items = byProvider[pk];
    const total = items.length;
    const passed = items.filter(i => i.passed).length;
    const rate = total > 0 ? (passed / total * 100).toFixed(0) : '-';
    const inToks = items.reduce((s, i) => s + (i.input_tokens || 0), 0);
    const outToks = items.reduce((s, i) => s + (i.output_tokens || 0), 0);
    const totalToks = inToks + outToks;
    const cost = items.reduce((s, i) => s + estimateCost(i.input_tokens || 0, i.output_tokens || 0, pk), 0);
    const avgMs = total > 0 ? (items.reduce((s, i) => s + (i.elapsed_ms || 0), 0) / total).toFixed(0) : '-';
    const cpp = passed > 0 ? (cost / passed) : cost > 0 ? Infinity : 0;
    const label = items[0]?.label || pk;
    lines.push(`${pk} | ${label} | ${total} | ${passed}/${total} (${rate}%) | ${totalToks} | $${cost.toFixed(6)} | ${avgMs}ms | $${cpp.toFixed(8)}`);
    if (passed > 0) costPerPassed.push({ provider: pk, label, cpp, rate: passed / total, cost });
    else costPerPassed.push({ provider: pk, label, cpp: Infinity, rate: 0, cost });
  }

  // cost per passed 順ランキング
  lines.push('\n【コストパフォーマンスランキング (cost per passed task)】');
  lines.push('安い順:');
  const ranked = costPerPassed
    .filter(p => p.cpp < Infinity)
    .sort((a, b) => a.cpp - b.cpp);
  if (ranked.length > 0) {
    ranked.forEach((p, i) => {
      const label = byProvider[p.provider]?.[0]?.label || p.label;
      lines.push(`  ${i + 1}. ${label}: $${p.cpp.toFixed(8)} (pass率 ${(p.rate * 100).toFixed(0)}%)`);
    });
  }
  const freebies = costPerPassed.filter(p => p.cpp === 0);
  if (freebies.length > 0) {
    lines.push('\n  ★ 無料枠プロバイダ:');
    freebies.forEach(p => {
      lines.push(`    ${p.label}: コスト0 (pass率 ${(p.rate * 100).toFixed(0)}%)`);
    });
  }
  const failures = costPerPassed.filter(p => p.cpp === Infinity);
  if (failures.length > 0) {
    lines.push('\n  ⚠ 1件もpassしなかったプロバイダ:');
    failures.forEach(p => lines.push(`    ${p.label}: 総コスト $${p.cost.toFixed(6)}（全タスクnon-pass）`));
  }

  // カテゴリ別
  lines.push('\n【カテゴリ別 pass率】');
  const cats = ['creative', 'extraction', 'document', 'operations'];
  for (const pk of providerOrder) {
    const items = byProvider[pk] || [];
    lines.push(`\n${pk} (${items[0]?.label || ''}):`);
    for (const cat of cats) {
      const catItems = items.filter(i => i.category === cat);
      if (catItems.length === 0) continue;
      const passed = catItems.filter(i => i.passed).length;
      const total = catItems.length;
      const rate = total > 0 ? (passed / total * 100).toFixed(0) : '-';
      lines.push(`  ${cat}: ${passed}/${total} (${rate}%)`);
    }
  }

  // タスク別結果
  lines.push('\n【タスク別詳細】');
  lines.push('task_id | category | pass/fail | input_tok | output_tok | ms');
  lines.push('---');
  for (const r of results) {
    if (!r.task_id) continue;
    const mark = r.passed ? '✅' : r.error ? '💥' : '❌';
    lines.push(`${r.task_id} | ${r.category} | ${mark} | ${r.input_tokens || 0} | ${r.output_tokens || 0} | ${r.elapsed_ms || 0}ms`);
    if (r.error) lines.push(`  → error: ${r.error.slice(0, 80)}`);
  }

  lines.push('\n' + '='.repeat(70));
  return lines.join('\n');
}

// ============================================================
// メインエントリ
// ============================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const isQuick = args.includes('--quick');
  const isFull = args.includes('--full');
  const specificProvider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null;
  const specificTask = args.includes('--task') ? args[args.indexOf('--task') + 1] : null;
  const outputPath = args.includes('--output') ? args[args.indexOf('--output') + 1] : '';
  return { isQuick, isFull, specificProvider, specificTask, outputPath };
}

if (isEntry(import.meta.url)) {
  const opts = parseArgs();

  // 実行するプロバイダ
  let providersToRun;
  if (opts.specificProvider) {
    providersToRun = PROVIDERS[opts.specificProvider] ? [opts.specificProvider] : DEFAULT_PROVIDERS;
  } else if (opts.isQuick) {
    providersToRun = ['gemini']; // Quick = one cheap provider
  } else if (opts.isFull) {
    providersToRun = Object.keys(PROVIDERS);
  } else {
    providersToRun = DEFAULT_PROVIDERS;
  }

  // 実行するタスク
  let tasksToRun;
  if (opts.specificTask) {
    tasksToRun = TASKS.filter(t => t.id === opts.specificTask);
    if (tasksToRun.length === 0) {
      console.error(`Task not found: ${opts.specificTask}`);
      process.exit(1);
    }
  } else if (opts.isQuick) {
    tasksToRun = TASKS.slice(0, 9); // 9 tasks for quick mode
  } else {
    tasksToRun = TASKS; // all 20
  }

  const totalCalls = providersToRun.length * tasksToRun.length;
  process.stderr.write(`[benchmark-20tasks] プロバイダ: ${providersToRun.join(', ')} (${providersToRun.length}件)\n`);
  process.stderr.write(`[benchmark-20tasks] タスク: ${tasksToRun.length}件 (全タスク${TASKS.length}件中)\n`);
  process.stderr.write(`[benchmark-20tasks] 合計APIコール数: ${totalCalls}\n`);
  process.stderr.write(`[benchmark-20tasks] 開始: ${new Date().toISOString()}\n\n`);

  const results = [];
  for (const pk of providersToRun) {
    process.stderr.write(`\n--- ${pk} (${PROVIDERS[pk]?.label || pk}) ---\n`);
    for (const task of tasksToRun) {
      const result = await runTask(pk, task);
      results.push(result);
      const mark = result.passed ? '✅' : result.error ? '💥' : '❌';
      process.stderr.write(`  ${mark} ${result.task_id} (${result.elapsed_ms}ms) ${result.error ? 'ERR: ' + result.error.slice(0, 50) : ''}\n`);
    }
  }

  const csv = formatCSV(results);
  if (opts.outputPath) {
    fs.writeFileSync(opts.outputPath, csv);
    process.stderr.write(`\nCSV saved: ${opts.outputPath}\n`);
  }
  process.stdout.write(csv);
  process.stderr.write(summarize(results));

  process.stderr.write(`\n[benchmark-20tasks] 完了: ${new Date().toISOString()}\n`);
}
