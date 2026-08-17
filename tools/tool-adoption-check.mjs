// ツール採用チェッカー: Codex / Gemini / Kimi が「実際に使われているか」を各PCで定期点検し、
// 未導入・未認証・未設定・未使用を検出して、自動修復できるものは直し、Discordに報告する。
//
// なぜ: 「Codex/Gemini を使え」というルールは"実際に使われて"初めてコスト削減になる。導入したのに
// 使われず Claude の従量トークンを燃やし続ける状態を早期検知し、原因(未認証/MCP未接続/ルール未遵守)を潰す。
//
// 何をしないか: 会話内容は読まない。ツールの使用痕跡(セッションファイルのmtime・キー有無・MCP登録)と
// Claude transcript 内の"ツール名シグネチャだけ"を見る。送信は集計/健全性フラグのみ。
//
// 実行: node tool-adoption-check.mjs           → Discord送信
//       node tool-adoption-check.mjs --dry-run  → 表示のみ
//       node tool-adoption-check.mjs --fix      → 自動修復も実行(既定はcheckのみ、fix指定で修復)
//
// 設定: ~/.claude/cost-reporter.env の DISCORD_COST_WEBHOOK / REPORTER_LABEL を流用。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');
const DO_FIX = process.argv.includes('--fix');
const HOME = os.homedir();

// 日次ガード(SessionStartフックから毎回呼ばれても送信は最大1日1回)。--dry-run/--fix時はスキップしない。
const GUARD_HOURS = 20;
const statePath = path.join(HOME, '.claude', '.tool-adoption-state.json');
if (!DRY_RUN && !process.argv.includes('--force')) {
  try { const s = JSON.parse(fs.readFileSync(statePath, 'utf-8')); if (s.last && (Date.now() - new Date(s.last).getTime()) < GUARD_HOURS * 3600000) process.exit(0); } catch {}
  // 競合防止: ガード通過直後に即座に状態を書く(近接して複数回発火しても2回目以降はここで弾かれ、重複投稿しない)
  try { fs.writeFileSync(statePath, JSON.stringify({ last: new Date().toISOString() })); } catch {}
}
const USAGE_WINDOW_DAYS = 7;
const now = Date.now();
const daysAgo = (ms) => (now - ms) / 86400000;

function loadEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const i = line.indexOf('='); if (i > 0 && !line.trim().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch { /* no file */ }
  return env;
}

function cmdOk(cmd) { try { execSync(cmd, { stdio: 'pipe', timeout: 15000 }); return true; } catch { return false; } }
function cmdOut(cmd) { try { return execSync(cmd, { stdio: 'pipe', timeout: 15000 }).toString().trim(); } catch { return ''; } }

// 再帰で最新mtime(ms)を返す。無ければ0。
function newestMtime(dir, filterExt) {
  let newest = 0;
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!filterExt || e.name.endsWith(filterExt)) { try { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch {} }
    }
  })(dir);
  return newest;
}

// Claude transcript(~/.claude/projects/**/*.jsonl)を直近N日分だけ開き、シグネチャ正規表現の有無を返す。
function transcriptHits(regex, windowDays) {
  const root = path.join(HOME, '.claude', 'projects');
  const cutoff = now - windowDays * 86400000;
  let hit = false;
  (function walk(d) {
    if (hit) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs < cutoff) continue; const t = fs.readFileSync(p, 'utf-8'); if (regex.test(t)) { hit = true; return; } } catch {}
      }
    }
  })(root);
  return hit;
}

const ledgerPath = path.join(HOME, '.claude', 'executor-usage.jsonl');
function readLedger(windowDays) {
  if (!fs.existsSync(ledgerPath)) return null;
  const cutoff = now - windowDays * 86400000;
  let fallbackTime = 0;
  try { fallbackTime = fs.statSync(ledgerPath).mtimeMs; } catch {}
  const rows = [];
  let raw; try { raw = fs.readFileSync(ledgerPath, 'utf-8'); } catch { return []; }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const value = row.t ?? row.ts ?? row.time ?? row.timestamp;
    const parsed = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
    const time = Number.isFinite(parsed) ? parsed : fallbackTime;
    if (time >= cutoff) rows.push(row);
  }
  return rows;
}
function ledgerUsed(providerRegex, windowDays) {
  const rows = readLedger(windowDays);
  if (rows === null) return null;
  return rows.some((row) => providerRegex.test(String(row.provider ?? row.tool ?? '')));
}
function ledgerCount(providerRegex, windowDays) {
  const rows = readLedger(windowDays);
  if (rows === null) return null;
  return rows.filter((row) => providerRegex.test(String(row.provider ?? row.tool ?? ''))).length;
}
function ledgerCounts(windowDays) {
  const rows = readLedger(windowDays);
  if (rows === null) return null;
  const counts = {};
  for (const row of rows) {
    const provider = String(row.provider ?? row.tool ?? '').trim().toLowerCase();
    if (provider) counts[provider] = (counts[provider] || 0) + 1;
  }
  return counts;
}

const fixes = [];   // 自動適用した修復
const human = [];   // 人手が要る残タスク(最小1操作)

// ---- Codex ----
function checkCodex() {
  const installed = cmdOk('codex --version');
  const version = installed ? cmdOut('codex --version') : '';
  const authed = fs.existsSync(path.join(HOME, '.codex', 'auth.json'));
  const lastUsed = newestMtime(path.join(HOME, '.codex', 'sessions'), '.jsonl');
  const usedDays = lastUsed ? daysAgo(lastUsed) : Infinity;
  const used = usedDays <= USAGE_WINDOW_DAYS;
  if (!installed && DO_FIX) { if (cmdOk('npm i -g @openai/codex')) fixes.push('Codex CLI を npm install'); else human.push('Codex CLI 導入失敗→手動 `npm i -g @openai/codex`'); }
  if (installed && !authed) human.push('Codex 未認証→`codex` 実行しChatGPTでログイン(1回)');
  return { name: 'Codex', installed, version, authed, used, usedDays, role: 'コード実装の主経路(定額枠)' };
}

// ---- Gemini ----
function ensureGeminiMcp() {
  // ~/.claude.json の mcpServers.gemini-cli を保証(無ければ追加)。env で GEMINI_API_KEY を渡す。
  const p = path.join(HOME, '.claude.json');
  let d; try { d = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return false; }
  const key = loadEnv(path.join(HOME, '.gemini', '.env')).GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
  const mcp = d.mcpServers = d.mcpServers || {};
  const want = { type: 'stdio', command: 'npx', args: ['-y', '@choplin/mcp-gemini-cli', '--allow-npx'], env: { GEMINI_API_KEY: key, GEMINI_CLI_TRUST_WORKSPACE: 'true' } };
  const cur = mcp['gemini-cli'];
  const ok = cur && cur.command === 'npx' && cur.env && cur.env.GEMINI_API_KEY;
  if (ok) return false;
  if (!key) { human.push('Gemini APIキー未設定→https://aistudio.google.com/apikey で発行し ~/.gemini/.env に GEMINI_API_KEY= 保存'); return false; }
  if (DO_FIX) {
    try { fs.copyFileSync(p, p + '.bak.adoption-' + new Date(now).toISOString().slice(0,10)); } catch {}
    mcp['gemini-cli'] = want;
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
    fixes.push('Gemini MCP を ~/.claude.json に登録/修復(要Claude Code再起動で有効化)');
    return true;
  }
  return false;
}
function checkGemini() {
  const installed = cmdOk('gemini --version');
  const version = installed ? cmdOut('gemini --version') : '';
  const key = loadEnv(path.join(HOME, '.gemini', '.env')).GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
  const keyed = !!key;
  let mcpReg = false;
  try { const d = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf-8')); mcpReg = !!(d.mcpServers && d.mcpServers['gemini-cli'] && d.mcpServers['gemini-cli'].env && d.mcpServers['gemini-cli'].env.GEMINI_API_KEY); } catch {}
  if (!installed && DO_FIX) { if (cmdOk('npm i -g @google/gemini-cli')) fixes.push('Gemini CLI を npm install'); else human.push('Gemini CLI 導入失敗→手動 `npm i -g @google/gemini-cli`'); }
  if (keyed && !mcpReg) ensureGeminiMcp();
  else if (!keyed) ensureGeminiMcp(); // human タスク追加のため
  // 使用痕跡: gemini tmp のmtime or transcript の MCP呼び出し
  const tmpUsed = newestMtime(path.join(HOME, '.gemini', 'tmp'));
  const trUsed = transcriptHits(/gemini-cli|geminiChat|googleSearch|"gemini"\s*-p|gemini\s+-p/, USAGE_WINDOW_DAYS);
  const lastUsed = tmpUsed;
  const usedDays = lastUsed ? daysAgo(lastUsed) : Infinity;
  const used = trUsed || usedDays <= USAGE_WINDOW_DAYS;
  return { name: 'Gemini', installed, version, keyed, mcpReg: mcpReg || (DO_FIX && keyed), used, usedDays, role: '超大規模文脈・Google検索(無料枠でトークン節約)' };
}

// ---- Kimi ----
function checkKimi() {
  const key = loadEnv(path.join(HOME, '.claude', 'kimi-api.env')).MOONSHOT_API_KEY || '';
  const keyed = !!key;
  const count = ledgerCount(/kimi|moonshot/i, USAGE_WINDOW_DAYS);
  const traceUsed = count === null && transcriptHits(/moonshot|kimi-k[23]|MOONSHOT_API_KEY/, USAGE_WINDOW_DAYS);
  const used = count === null ? traceUsed : count > 0;
  return { name: 'Kimi', installed: keyed, version: keyed ? 'key有' : '', keyed, used, count, traceOnly: traceUsed, usedDays: used ? 0 : Infinity, role: '中量級の生成・推論の逃がし先(別課金プール・K3/reasoning_effort=none)' };
}

// ---- Manus (アプリ埋め込み型: aujust の src/lib/manus.ts 経由。CLI/セッションdirは無い) ----
function checkManus() {
  // 使用痕跡: transcript内の manus 呼び出し or manus-poll cron 言及
  const ledger = ledgerUsed(/manus/i, USAGE_WINDOW_DAYS);
  const used = ledger === null ? transcriptHits(/manus|MANUS_API|createEnrichmentTask|manus-poll/i, USAGE_WINDOW_DAYS) : ledger;
  // 健全性: 環境に MANUS の鍵/参照があるか(アプリ側 .env は各リポなのでPCローカルの痕跡のみ緩く判定)
  const envHit = !!(process.env.MANUS_API_KEY);
  return { name: 'Manus', installed: true, version: 'アプリ埋込', keyed: true, used, traceOnly: ledger === null && used, usedDays: used ? 0 : Infinity,
    role: 'Web調査・属性エンリッチ(多段・根拠URL要/aujust埋込・専用枠)', appEmbedded: true, envHit };
}

// ---- 監督(Opus)委譲規律チェック(§1.18): Opus高消費なのにCodex未使用=監督が実装を抱えている疑い ----
function modelFamily(m) { m = String(m || ''); if (/opus/i.test(m)) return 'opus'; if (/sonnet/i.test(m)) return 'sonnet'; if (/haiku/i.test(m)) return 'haiku'; if (/fable/i.test(m)) return 'fable'; return null; }
function mtdOutputByModel() {
  const root = path.join(HOME, '.claude', 'projects');
  const d = new Date(now); const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const by = {};
  (function walk(dir) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        let raw; try { raw = fs.readFileSync(p, 'utf-8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          if (line.indexOf('"usage"') < 0) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
          if (!o.timestamp || o.timestamp < monthStart) continue;
          const fam = modelFamily(o.message.model); if (!fam) continue;
          const u = o.message.usage;
          by[fam] = (by[fam] || 0) + (u.output_tokens || 0);
        }
      }
    }
  })(root);
  return by;
}
function formatTokens(value) { return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M tok` : `${Math.round(value / 1000)}k tok`; }
function supervisorDiscipline(codexUsed) {
  const by = mtdOutputByModel();
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const opus = by.opus || 0; const share = total > 0 ? opus / total : 0;
  const pct = Math.round(share * 100);
  if (total < 100000) return { icon: '☑️', note: `当月の出力が少ない(${formatTokens(total)})ため判定保留` };
  if (opus >= 3000000 && (share >= 0.5 || !codexUsed)) return { icon: '🚨', note: `Opus当月出力 ${formatTokens(opus)}(全体の${pct}%)=最小限監督の水準を大きく超過。監督が実装を挽いている。実装を即Codexへ委譲(§1.17/§1.18)${codexUsed ? '' : `／かつ直近${USAGE_WINDOW_DAYS}日Codex未使用`}` };
  if (!codexUsed && opus >= 500000) return { icon: '🚨', note: `Opus出力 ${formatTokens(opus)} だが直近${USAGE_WINDOW_DAYS}日Codex未使用=委譲されていない疑い。実装はCodexへ(§1.17/§1.18)` };
  if (opus >= 1000000 || share >= 0.7) return { icon: '⚠️', note: `Opus当月出力 ${formatTokens(opus)}・比率${pct}%=監督が挽き気味の可能性。実装のCodex委譲を確認(§1.18)` };
  return { icon: '✅', note: `委譲規律OK (Opus出力 ${formatTokens(opus)}/${pct}%・Codex${codexUsed ? '使用あり' : '低Opusで問題なし'})` };
}

const checks = [checkCodex(), checkGemini(), checkKimi(), checkManus()];

// ---- レポート組み立て ----
const label = loadEnv(path.join(HOME, '.claude', 'cost-reporter.env')).REPORTER_LABEL || os.hostname();
let msg = `**🛠️ ツール採用チェック** — ${label} (直近${USAGE_WINDOW_DAYS}日)\n`;
for (const c of checks) {
  let icon, note;
  if (c.name === 'Kimi' && !c.keyed) { icon = '🚨'; note = 'APIキー未設定→~/.claude/kimi-api.env に MOONSHOT_API_KEY= を設定'; }
  else if (c.name === 'Kimi' && c.used) { icon = '✅'; note = c.count === null ? '使用あり(痕跡のみ)' : `使用あり(${c.count}回)`; }
  else if (c.name === 'Kimi') { icon = '⚠️'; note = '未使用=Claude従量を別課金プールへ逃がせていない(§1.13)。量産・分類・中量級生成は `node tools/llm-ask.mjs --provider kimi "…"` へ'; }
  else if (c.appEmbedded) { icon = c.used ? '✅' : '☑️'; note = c.used ? `使用あり(直近)${c.traceOnly ? '(痕跡のみ)' : ''}` : '未使用(aujust未実行なら想定内)'; }
  else if (!c.installed) { icon = '🚨'; note = '未導入'; }
  else if (c.name === 'Codex' && !c.authed) { icon = '🚨'; note = '未認証'; }
  else if (c.name === 'Gemini' && !c.keyed) { icon = '🚨'; note = 'APIキー未設定'; }
  else if (c.name === 'Gemini' && !c.mcpReg) { icon = '⚠️'; note = 'MCP未登録(修復対象)'; }
  else if (!c.used) { icon = '⚠️'; note = `導入OKだが直近${USAGE_WINDOW_DAYS}日未使用=ルーティング未活用の可能性`; }
  else { icon = '✅'; note = `使用あり(${Number.isFinite(c.usedDays) ? Math.floor(c.usedDays) + '日前' : '痕跡あり'})`; }
  msg += `${icon} **${c.name}** ${c.version} — ${note}\n   用途: ${c.role}\n`;
}
// 監督(Opus)委譲規律
const codexUsed = (checks.find((c) => c.name === 'Codex') || {}).used;
const disc = supervisorDiscipline(codexUsed);
msg += `${disc.icon} **監督委譲規律(§1.18)** — ${disc.note}\n`;
msg += `※料金の正本は同時投稿の「Claude Code ローカル利用トークン」(list価格換算)を参照\n`;
const providerCounts = ledgerCounts(USAGE_WINDOW_DAYS);
const ledgerSummary = providerCounts === null ? '台帳なし' : (Object.entries(providerCounts).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(' / ') || '呼び出しなし');
msg += `📒 安いAI実行者(直近${USAGE_WINDOW_DAYS}日・実呼び出し): ${ledgerSummary}\n`;

if (fixes.length) msg += `\n🔧 自動修復: ${fixes.join(' / ')}\n`;
if (human.length) msg += `\n🙋 要人手(最小1操作): ${human.join(' / ')}\n`;
if (!fixes.length && !human.length) msg += `\n(健全性OK。未使用⚠️があればルーティング(§1.13)を意識)\n`;
msg += `※使用痕跡はセッションファイル/キー/MCP登録のみ判定。会話内容は読んでいません。`;

console.log(msg);
if (DRY_RUN) { console.log('\n--dry-run: Discord未送信'); process.exit(0); }
try { fs.writeFileSync(statePath, JSON.stringify({ last: new Date(now).toISOString() })); } catch {}
const webhook = loadEnv(path.join(HOME, '.claude', 'cost-reporter.env')).DISCORD_COST_WEBHOOK;
if (!webhook) { console.error('DISCORD_COST_WEBHOOK未設定'); process.exit(1); }
fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msg.slice(0, 1950) }) })
  .then((r) => console.log(r.ok ? 'posted' : `discord ${r.status}`)).catch((e) => console.error(e.message));
