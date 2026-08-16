// Claude Code ローカル利用トークンレポーター（list価格換算は相対指標として併記）。
//
// 何をするか: このPC上の ~/.claude/projects/**/*.jsonl (Claude Code のセッション記録) から
// トークン使用量とモデル名「だけ」を読み、利用量を集計して Discord に通知する。
//
// 何をしないか: 会話内容(message.content / thinking / tool_use 等)は一切読まない・送らない。
// 送信されるのは「PC名・当月トークン量・モデル別内訳・list価格換算」という集計値のみ。
//
// 実行: node claude-cost-reporter.mjs           → 実際に Discord へ送信
//       node claude-cost-reporter.mjs --dry-run  → 送信内容を表示するだけ(送信しない)
//
// 設定: ~/.claude/cost-reporter.env に以下を書く(このファイルは配布物に含めない、各PC個別設定):
//   DISCORD_COST_WEBHOOK=https://discord.com/api/webhooks/...
//   REPORTER_LABEL=任意のPC識別名(省略時はOSのホスト名)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DRY_RUN = process.argv.includes('--dry-run');

// --- 設定読み込み (~/.claude/cost-reporter.env) ---
function loadEnv() {
  const envPath = path.join(os.homedir(), '.claude', 'cost-reporter.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return env;
}

// --- 料金表 (USD / 1M tokens)。2026-07時点の公開価格。新モデルが出たら追記する ---
const PRICING = {
  'claude-haiku-4-5': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-5': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4-7': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-5': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },   // Opus5(GA・Opus4.8と同単価)
  'claude-fable-5': { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1.0 }, // §1.16禁止、検出したら警告
};
function priceOf(model) {
  if (PRICING[model]) return PRICING[model];
  // 日付サフィックス付きID(例: claude-haiku-4-5-20251001)は末尾-YYYYMMDDを剥がして再照合
  const stripped = String(model).replace(/-\d{8}$/, '');
  return PRICING[stripped] || null; // それでも未知ならコスト$0扱い(クラッシュさせない)、レポートに「未知」として出す
}

// --- ~/.claude/projects 配下の *.jsonl を再帰列挙 ---
function findTranscripts(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  walk(root);
  return out;
}

// --- 1ファイルを1行ずつ処理。usage/model/timestamp だけ抜き、contentは触らない ---
function processFile(filePath, monthStart, byModel, unknownModels) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
  for (const line of raw.split('\n')) {
    if (!line || line.indexOf('"usage"') < 0) continue; // 早期スキップ(パース回数を減らす)
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
    const ts = obj.timestamp;
    if (!ts || ts < monthStart) continue;
    const model = obj.message.model || 'unknown';
    const u = obj.message.usage;
    const price = priceOf(model);
    const inTok = u.input_tokens || 0;
    const outTok = u.output_tokens || 0;
    const cacheWriteTok = u.cache_creation_input_tokens || 0;
    const cacheReadTok = u.cache_read_input_tokens || 0;
    let cost = 0;
    if (price) {
      cost =
        (inTok / 1e6) * price.in +
        (outTok / 1e6) * price.out +
        (cacheWriteTok / 1e6) * price.cacheWrite +
        (cacheReadTok / 1e6) * price.cacheRead;
    } else {
      unknownModels.add(model);
    }
    const usage = byModel[model] || { cost: 0, inTok: 0, outTok: 0 };
    usage.cost += cost;
    usage.inTok += inTok + cacheWriteTok + cacheReadTok;
    usage.outTok += outTok;
    byModel[model] = usage;
  }
}

const GUARD_HOURS = 6;
function statePath() { return path.join(os.homedir(), '.claude', '.cost-reporter-state.json'); }
function shouldSkipByGuard() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    if (s.lastRun && Date.now() - new Date(s.lastRun).getTime() < GUARD_HOURS * 3600 * 1000) return true;
  } catch { /* no state yet */ }
  return false;
}
function saveGuardState() {
  try { fs.writeFileSync(statePath(), JSON.stringify({ lastRun: new Date().toISOString() })); } catch { /* ignore */ }
}

function main() {
  const env = loadEnv();
  const webhook = env.DISCORD_COST_WEBHOOK;
  const label = env.REPORTER_LABEL || os.hostname();

  if (!DRY_RUN && shouldSkipByGuard()) {
    console.log(`前回実行から${GUARD_HOURS}時間未満のためスキップ`);
    return;
  }
  // 競合防止: ガード通過直後に即座に状態を書く(近接して複数回発火しても2回目以降はスキップされ重複投稿しない)
  if (!DRY_RUN) saveGuardState();

  if (!webhook && !DRY_RUN) {
    console.error('DISCORD_COST_WEBHOOK が未設定です。~/.claude/cost-reporter.env を作成してください。');
    process.exit(1);
  }

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const root = path.join(os.homedir(), '.claude', 'projects');
  const files = findTranscripts(root);

  const byModel = {};
  const unknownModels = new Set();
  for (const f of files) processFile(f, monthStart, byModel, unknownModels);

  const total = Object.values(byModel).reduce((a, b) => a + b.cost, 0);
  const totalIn = Object.values(byModel).reduce((a, b) => a + b.inTok, 0);
  const totalOut = Object.values(byModel).reduce((a, b) => a + b.outTok, 0);
  const sorted = Object.entries(byModel).sort((a, b) => b[1].outTok - a[1].outTok);
  const fableUsed = sorted.some(([m]) => /fable/i.test(m));
  const opusOut = sorted.filter(([m]) => /opus/i.test(m)).reduce((a, [, v]) => a + v.outTok, 0);
  const opusRatio = totalOut ? opusOut / totalOut : 0;

  let msg = `**💻 Claude Code ローカル利用トークン** — ${label}\n`;
  msg += `対象: ${monthStart} 〜 現在\n`;
  msg += `MTD 出力トークン: **${(totalOut / 1e6).toFixed(1)}M** / 入力(cache込) **${(totalIn / 1e6).toFixed(1)}M**\n`;
  msg += `参考: list価格換算 $${total.toFixed(2)} ※Claude Codeは定額シート課金のため請求書には乗りません。実額の正本は console.anthropic.com(Dev API) / claude.ai 請求(シート)\n`;
  if (opusRatio > 0.5) msg += `⚠️ Opus比率高(${(opusRatio * 100).toFixed(0)}%)。監督は最小限に、実装/生成は委譲(§1.18)\n`;
  if (fableUsed) msg += `🚨 このPCでFable5(§1.16禁止)の使用を検出しました\n`;
  if (sorted.length > 0) {
    msg += `__モデル別__\n`;
    for (const [m, v] of sorted) msg += `- ${m}: 出力 ${(v.outTok / 1000).toFixed(0)}k tok (参考: list価格換算 $${v.cost.toFixed(2)})\n`;
  } else {
    msg += `(今月の利用記録なし)\n`;
  }
  if (unknownModels.size > 0) msg += `※ 料金表未登録モデル(コスト$0扱い): ${[...unknownModels].join(', ')}\n`;
  msg += `※ 会話内容は一切送信していません。トークン数とモデル名から算出した推定値のみです。`;

  console.log(msg);

  if (DRY_RUN) {
    console.log('\n--dry-run のため Discord へは送信していません。');
    return;
  }

  fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: msg.slice(0, 1950) }),
  })
    .then((r) => console.log(r.ok ? 'posted to Discord' : `Discord POST failed ${r.status}`))
    .catch((e) => console.error('Discord POST error:', e.message))
    .finally(() => saveGuardState());
}

main();
