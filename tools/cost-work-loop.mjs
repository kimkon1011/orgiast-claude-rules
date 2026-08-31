// cost-work-loop.mjs — 「作業量に対する出力トークン」を継続監視し、委譲(安いAIへ逃がす)が実際に効いているかを判定して
// 自己修正の"指示書"を出す閉ループ。放置するとClaude主体に戻るのを防ぐ(kim 2026-08-16)。
//
// 何を測るか(このPCのみ・会話内容は読まない):
//   1) Claude Code のトークン/概算$(直近7日) … ~/.claude/projects/**/*.jsonl の usage だけ
//   2) 安いAI実行者の使用実績 … ~/.claude/executor-usage.jsonl (llm-ask等が追記)
//   3) 作業量プロキシ … 直近7日のgitコミット数(作業ディレクトリ)。無ければ稼働日数。
// 何を判定するか(kimが挙げた2大失敗):
//   A) Claude出力トークンが多い かつ 委譲率低い → 「委譲できていない(Claude主体)」🚨
//   B) Claude出力が前回比↑ なのに 作業量↑でない → 「逃がしたのに利用量増(誤ルーティング/やり直し/呼びすぎ)」🚨
// 出力: ~/.claude/cost-directive.md (SessionStartで毎回私が読む=修正が行動に反映) + 任意でDiscord。
//   実行: node cost-work-loop.mjs [--post] [--days 7]
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recommendations } from './eval-harness.mjs';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { calculateDelegation, calculateLinesDelegation, collectBashProfile, collectClaudeActivityDays, collectClaudeCostStats, collectClaudeStats, collectCodexUsage, collectGitActivity, estimateSpecAuthoringTokens, formatBlockSource } from './usage-stats.mjs';
export { codexSessionDirs, collectCodexUsage } from './usage-stats.mjs';
// 公式 pricing 2026-08-30。Gemini token は 2026-12-31 までのプロモ価格（以降は倍）。
export const EXECUTOR_PRICING = {
  groq: [0.6, 0.8], openrouter: [0.3, 0.6], gemini: [0.75, 3.75], kimi: [3, 15],
  mistral: [2, 6], deepseek: [0.27, 1.1], grok: [3, 15], ollama: [0, 0], codex: [0, 0],
};
export const GEMINI_PRICING = { freeGroundedSearches: 5000, searchUsdPer1000: 14, monthlyLimitJpy: 20000 };

export function summarizeGeminiMonth(rows, { now = new Date(), usdJpy = 150 } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const monthStart = new Date(current.getFullYear(), current.getMonth(), 1).getTime();
  const throughNow = current.getTime();
  let searches = 0, inputTokens = 0, outputTokens = 0;
  for (const row of rows) {
    if (row?.provider !== 'gemini') continue;
    const timestamp = new Date(row.t).getTime();
    if (!Number.isFinite(timestamp) || timestamp < monthStart || timestamp > throughNow) continue;
    if (row.grounded === true) searches += 1;
    inputTokens += Number(row.in) || 0;
    outputTokens += Number(row.out) || 0;
  }
  const [inputPrice, outputPrice] = EXECUTOR_PRICING.gemini;
  const tokenUsd = (inputTokens * inputPrice + outputTokens * outputPrice) / 1e6;
  const billableSearches = Math.max(0, searches - GEMINI_PRICING.freeGroundedSearches);
  const searchUsd = billableSearches * GEMINI_PRICING.searchUsdPer1000 / 1000;
  const totalJpy = (tokenUsd + searchUsd) * usdJpy;
  const flags = [];
  if (searches > GEMINI_PRICING.freeGroundedSearches * 0.8) flags.push(`⚠️ Gemini検索が無料枠の80%超（${searches}/5000）。超過分は $14/1000req`);
  if (totalJpy > GEMINI_PRICING.monthlyLimitJpy * 0.5) flags.push('🚨 Gemini従量が月上限¥20,000の50%超');
  return { searches, remainingFree: Math.max(0, GEMINI_PRICING.freeGroundedSearches - searches), billableSearches, tokenUsd, searchUsd, totalJpy, limitPercent: totalJpy / GEMINI_PRICING.monthlyLimitJpy * 100, usdJpy, flags };
}
const nativeHome = os.homedir();
function defaultHome() { return process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || nativeHome; }
export function decideEnforcement({ delegRatioWithPrep, delegRatio, linesRatio, daysObserved, claudeOut, history, target, targetLines = 0.50, pilot, previousMode }) {
  const useLinesRatio = typeof linesRatio === 'number' && Number.isFinite(linesRatio);
  const enforcementRatio = useLinesRatio ? linesRatio : (delegRatioWithPrep ?? delegRatio ?? 0);
  const enforcementTarget = useLinesRatio ? targetLines : target;
  const decidedBy = useLinesRatio ? 'linesRatio' : 'delegRatioWithPrep';
  const metric = useLinesRatio ? '行ベース委譲率' : '委譲率';
  const fallback = useLinesRatio ? '' : '(行ベース算出不能のためフォールバック)';
  if (!pilot) {
    const demotion = previousMode === 'block' ? '既存blockをwarnへ降格。' : '';
    return { mode: 'warn', reason: `${demotion}block昇格はパイロット機のみ有効(~/.claude/cost-enforce-pilot が無い)。目標50%の指示書と可視化は有効${fallback}`, decidedBy };
  }

  let mode = 'warn', reason = '観察中';
  if (enforcementRatio < enforcementTarget / 3 && daysObserved >= 2 && claudeOut >= 1e6) {
    mode = 'block'; reason = `${metric}${(enforcementRatio * 100).toFixed(1)}%=目標の1/3未満。2日で昇格${fallback}`;
  } else if (daysObserved >= 3 && claudeOut >= 1e6 && enforcementRatio < enforcementTarget / 2) {
    mode = 'block'; reason = `${metric}${(enforcementRatio * 100).toFixed(1)}%=目標の半分未満。3日でトレンドに関わらず昇格${fallback}`;
  } else if (daysObserved >= 7 && claudeOut >= 1e6 && enforcementRatio < enforcementTarget) {
    const avg = a => { const values = useLinesRatio ? a.map(x => x.linesRatio).filter(x => typeof x === 'number' && Number.isFinite(x)) : a.map(x => x.delegRatioWithPrep ?? x.delegRatio ?? 0); return values.length ? values.reduce((s, x) => s + x, 0) / values.length : 0; };
    const early = history.slice(0, Math.max(1, Math.floor(history.length / 2)));
    const recent = history.slice(-3);
    if (avg(recent) <= avg(early) + 0.05) {
      mode = 'block'; reason = `${daysObserved}日観察して${metric}が改善せず(${(avg(early) * 100).toFixed(0)}%→${(avg(recent) * 100).toFixed(0)}%)。ハードブロック昇格${fallback}`;
    } else {
      reason = `${metric}に改善傾向あり(${(avg(early) * 100).toFixed(0)}%→${(avg(recent) * 100).toFixed(0)}%)=警告継続${fallback}`;
    }
  }
  return { mode, reason, decidedBy };
}
const HOME = defaultHome();
const DAYS = parseInt((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1] || '7', 10) || 7;
const POST = process.argv.includes('--post');
const since = Date.now() - DAYS * 864e5;
// 概算単価($/1M tok) — 傾向把握用の粗い値
const PRICE = { opus: [5, 25], sonnet: [3, 15], haiku: [0.8, 4], default: [3, 15] };
function tier(m) { m = (m || '').toLowerCase(); if (m.includes('fable')) return 'fable'; if (m.includes('opus')) return 'opus'; if (m.includes('haiku')) return 'haiku'; if (m.includes('sonnet')) return 'sonnet'; return 'default'; }

// ---- 1) Claude Code トークン/$ ----
function walk(dir, out) { let e = []; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const d of e) { const p = path.join(dir, d.name); if (d.isDirectory()) walk(p, out); else if (d.name.endsWith('.jsonl')) out.push(p); } }
const isMain = isEntry(import.meta.url);
if (isMain) {
let claudeOut = 0, claudeUSD = 0, claudeByModel = {}, cacheBase = 0, cacheRead = 0, cacheWrite = 0, topFableSource = null;
{
  const cost = collectClaudeCostStats({ home: HOME, days: DAYS });
  claudeOut = cost.outputTokens; claudeByModel = cost.byModel; cacheBase = cost.cacheBase; cacheRead = cost.cacheRead; cacheWrite = cost.cacheWrite; topFableSource = cost.topFableSource;
  for (const [model, usage] of Object.entries(cost.usageByModel)) { const [pi, po] = PRICE[model] || PRICE.default; claudeUSD += (usage.input * pi + usage.cacheWrite * pi * 1.25 + usage.cacheRead * pi * 0.1 + usage.output * po) / 1e6; }
}
// ---- 2) Codex(定額枠) ----
const codexUsage = collectCodexUsage({ home: HOME, days: DAYS, includePatchLines: true });
const { outputTokens: codexOut, sessions: codexSessions } = codexUsage;
const repoDirs = (process.env.COST_WORK_REPOS || '').split(path.delimiter).filter(Boolean);
const workRepos = repoDirs.length ? repoDirs : [process.cwd()];
const gitActivity = collectGitActivity({ repos: workRepos, days: DAYS });
const codexLines = codexUsage.added + codexUsage.deleted;
const landedLines = gitActivity.added + gitActivity.deleted;
const claudeStats = collectClaudeStats({ home: HOME, days: DAYS });
const claudeLines = claudeStats.authoredLines;
const linesRatio = calculateLinesDelegation({ codexLines, claudeLines });
// ---- 3) 安いAI実行者 台帳 ----
let execOut = 0, execUSD = 0, execByProv = {}, ledgerRows = [];
{
  const led = path.join(HOME, '.claude', 'executor-usage.jsonl');
  let lines = []; try { lines = fs.readFileSync(led, 'utf-8').split('\n'); } catch { }
  for (const ln of lines) { if (!ln.trim()) continue; let r; try { r = JSON.parse(ln); } catch { continue; } ledgerRows.push(r); if (new Date(r.t).getTime() < since) continue; const [pi, po] = EXECUTOR_PRICING[r.provider] || [1, 3]; execUSD += ((r.in || 0) * pi + (r.out || 0) * po) / 1e6; execOut += (r.out || 0); execByProv[r.provider] = (execByProv[r.provider] || 0) + 1; }
}
// ---- 4) 作業量プロキシ(gitコミット) ----
let work = 0, workKind = 'commits';
work = gitActivity.commits;
if (work === 0) { workKind = 'sessions(代替)'; try { work = collectClaudeActivityDays({ home: HOME, days: DAYS }); } catch { } }

// ---- 判定 ----
const totalUSD = claudeUSD + execUSD;
const bashProfile = collectBashProfile({ home: HOME, days: DAYS });
const specAuthoringOut = estimateSpecAuthoringTokens({ blocks: claudeStats.blocks, profile: bashProfile });
const delegation = calculateDelegation({ execOut, codexOut, byModel: claudeByModel, specAuthoringOut });
const { delegRatio, delegRatioWithPrep } = delegation;
const outPerWork = claudeOut / Math.max(work, 1);
// 前回スナップショットで傾向
const stateF = path.join(HOME, '.claude', 'cost-loop-state.json');
let prev = null; try { prev = JSON.parse(fs.readFileSync(stateF, 'utf-8')); } catch { }
const flags = [];
const parsedUsdJpy = Number(process.env.ORGIAST_USDJPY);
const geminiMonth = summarizeGeminiMonth(ledgerRows, { usdJpy: Number.isFinite(parsedUsdJpy) && parsedUsdJpy > 0 ? parsedUsdJpy : 150 });
flags.push(...geminiMonth.flags);
// 日次ループのたびにschedule実績を更新する。gh未導入・認証失敗・cron停止でも本体は継続する。
spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'cron-liveness-check.mjs')], {
  env: { ...process.env, ORGIAST_HOME: HOME }, stdio: 'ignore',
});
const cronLivenessFile = path.join(HOME, '.claude', 'cron-liveness.json');
let cronLiveness = null;
try { cronLiveness = JSON.parse(fs.readFileSync(cronLivenessFile, 'utf8')); } catch { }
const cronCheckedAt = Date.parse(cronLiveness?.t || '');
if (!Number.isFinite(cronCheckedAt) || Date.now() - cronCheckedAt >= 2 * 864e5) {
  flags.push('⚠️ cron生存点検が未実行(node tools/cron-liveness-check.mjs)');
} else {
  for (const result of cronLiveness?.results || []) {
    if (result.status === 'never') flags.push(`🚨 cron停止: ${result.label} — schedule の成功履歴なし。gh run list --event=schedule で確認し permissions:{actions:read} を点検`);
    if (result.status === 'stale') flags.push(`🚨 cron停止: ${result.label} — schedule の最終成功 ${String(result.lastSuccess).slice(0, 10)}(${Math.floor(result.ageDays)}日前)。gh run list --event=schedule で確認し permissions:{actions:read} を点検`);
  }
}
const TARGET_DELEG = 0.50;
const TARGET_LINES = 0.50;
if (claudeByModel.fable > 0) {
  const latest = new Date(topFableSource?.latest || Date.now()); const pad = (n) => String(n).padStart(2, '0');
  const latestText = `${latest.getFullYear()}-${pad(latest.getMonth() + 1)}-${pad(latest.getDate())} ${pad(latest.getHours())}:${pad(latest.getMinutes())}`;
  flags.push(`🚨 Fable5使用を検出(out ${(claudeByModel.fable / 1000).toFixed(0)}k tok)=§1.16 全用途禁止(別課金枠)。発生元: ${topFableSource?.sessionId || '特定不能'}（最終 ${latestText}）— そのセッションで /model opus か /session-close。user明示指定が無ければ即停止`);
}
if (claudeOut >= 1e6 && typeof linesRatio === 'number' && Number.isFinite(linesRatio) && linesRatio < TARGET_LINES) flags.push(`🚨 実装の委譲不足: 行ベース委譲率${(linesRatio * 100).toFixed(0)}%(目標${TARGET_LINES * 100}%↑)。実装→Codex/量産→Groq/汎用安→OpenRouter/中量級→Kimi K3 へ回す`);
else if (claudeOut >= 1e6 && typeof linesRatio === 'number' && Number.isFinite(linesRatio) && linesRatio >= TARGET_LINES && delegRatio < TARGET_DELEG) flags.push(`ℹ️ 実装は委譲できている(行ベース${(linesRatio * 100).toFixed(0)}%)が、監督の出力量自体が大きい(トークン委譲率${(delegRatio * 100).toFixed(0)}% / 監督out ${(claudeOut / 1000).toFixed(0)}k tok)。thinking と報告文が主因で、これは品質を削らない限り下がらない — 判定には使わない`);
else if (claudeOut >= 1e6 && delegRatio < TARGET_DELEG) flags.push(`🚨 委譲不足: Claude出力${(claudeOut / 1000).toFixed(0)}k tokなのに委譲率${(delegRatio * 100).toFixed(0)}%(目標${TARGET_DELEG * 100}%↑、Codex分は計上済み。行ベース算出不能のためフォールバック)。実装→Codex/量産→Groq/汎用安→OpenRouter/中量級の生成・推論→Kimi K3(別課金プール) へ回す`);
if (codexSessions === 0) flags.push('⚠️ Codex未使用=実装を監督が抱えている疑い。実装はCodexへ委譲する');
if (prev && typeof prev.claudeOut === 'number' && claudeOut > prev.claudeOut * 1.15 && work <= prev.work) flags.push(`🚨 利用効率悪化: Claude出力 ${(prev.claudeOut / 1000).toFixed(0)}k→${(claudeOut / 1000).toFixed(0)}k tok 増だが作業量(${workKind}) ${prev.work}→${work} 増えず。誤ルーティング/やり直し/呼びすぎを点検`);
if (claudeByModel.opus && claudeOut && (claudeByModel.opus / claudeOut) > 0.5) flags.push(`⚠️ Opus比率高(${((claudeByModel.opus / claudeOut) * 100).toFixed(0)}%)。監督は最小限に、実装/生成は委譲(§1.18)`);
const unused = [];
if (!execByProv.kimi) unused.push('kimi(中量級生成)');
if (!execByProv.groq) unused.push('groq(量産分類)');
if (!execByProv.gemini) unused.push('gemini(長文脈)');
let batchUsed = false;
try {
  const queueDir = path.join(HOME, '.claude', 'batch-queue');
  for (const name of fs.readdirSync(queueDir)) {
    if (name !== 'pending.jsonl' && !/^results-.*\.jsonl$/.test(name)) continue;
    const file = path.join(queueDir, name);
    if (fs.statSync(file).mtimeMs >= since && fs.readFileSync(file, 'utf8').trim()) { batchUsed = true; break; }
  }
} catch {}
if (!batchUsed) unused.push('夜間バッチ(batch-enqueue)');
flags.push(`⚠️ 未活用: ${unused.length ? unused.join(' / ') : 'なし'} — 該当作業が来たらここへ流す`);
if (!flags.length) flags.push('✅ 委譲・コスト効率は許容範囲。この調子で。');

const arrow = prev && typeof prev.claudeOut === 'number' ? (claudeOut > prev.claudeOut ? '↑' : claudeOut < prev.claudeOut ? '↓' : '→') : '';
const execLine = Object.keys(execByProv).length ? Object.entries(execByProv).map(([k, v]) => `${k}:${v}回`).join(' / ') : '(なし=安いAI未使用)';
const claudeModelLine = Object.keys(claudeByModel).length ? Object.entries(claudeByModel).map(([k, v]) => k + ' ' + (v / 1000).toFixed(0) + 'k').join('/') : '内訳なし';
const cacheTarget = cacheRead + cacheWrite + cacheBase, cacheRate = cacheTarget ? cacheRead / cacheTarget : 0;
const cacheLine = `${cacheTarget > 1_000_000 ? (cacheRate < 0.2 ? '🚨 ' : cacheRate < 0.5 ? '⚠️ ' : '✅ ') : ''}プロンプトキャッシュヒット率 ${(cacheRate * 100).toFixed(1)}% (対象 ${(cacheTarget / 1e6).toFixed(1)}M${cacheTarget <= 1_000_000 ? '・判定対象外' : ''})${cacheTarget > 1_000_000 && cacheRate < 0.2 ? ' — system 内に日時/ID などの動的値が入っている・JSON が非ソート・tools 定義が毎回変わる、を疑う' : ''}`;
const qualityLines = recommendations();
const blockSourceLine = formatBlockSource(claudeStats.blocks);
const linesDelegationLine = linesRatio === null
  ? '計測不能(Codex/Claudeともに実装行なし)'
  : `**${(linesRatio * 100).toFixed(1)}%** (Codex ±${codexLines.toLocaleString('ja-JP')}行 / Claude手打ち ±${claudeLines.toLocaleString('ja-JP')}行)`;
if (!qualityLines.length) qualityLines.push(fs.existsSync(path.join(HOME, '.claude', 'eval-results.jsonl')) ? '有効な計測なし（再計測が必要）' : 'eval 未実行 (node tools/eval-harness.mjs --all で計測)');
const md = `<!-- COST-DIRECTIVE-START -->
## 📊 Claude Code out ${(claudeOut / 1000).toFixed(0)}k tok / 委譲率 ${(delegRatio * 100).toFixed(1)}% (直近${DAYS}日 / このPC)
- Claude Code利用: **out ${(claudeOut / 1000).toFixed(0)}k tok** ${arrow} (${claudeModelLine}) ※定額シート課金＝請求$は発生しない
- (参考: list価格換算 $${claudeUSD.toFixed(1)} — 実請求ではない)
- 安いAI実行者: **実額 $${execUSD.toFixed(2)}**（従量課金）— ${execLine}
- Gemini 従量: 検索 ${geminiMonth.searches.toLocaleString('ja-JP')}回 / 無料枠5,000（残り ${geminiMonth.remainingFree.toLocaleString('ja-JP')}回） / トークン実費 $${geminiMonth.tokenUsd.toFixed(2)}（≒¥${Math.round(geminiMonth.tokenUsd * geminiMonth.usdJpy).toLocaleString('ja-JP')}） / 検索超過 $${geminiMonth.searchUsd.toFixed(2)} / 月上限¥20,000 に対し ${geminiMonth.limitPercent.toFixed(1)}%（$1=¥${geminiMonth.usdJpy}）
- Gemini MCP 経由分は未計測（gemini-mcp-tool の ask-gemini は台帳対象外のため、この金額は過小評価）
- Codex(定額枠・実装の主経路): **out ${codexOut.toLocaleString('ja-JP')} tok** / ${codexSessions}セッション ※従量課金なし
- 作業量(${workKind}): ${work} / **作業あたり 出力 ${(outPerWork / 1000).toFixed(0)}k tok**
- 委譲率(Codex/Sonnet/Haiku/安いAIへ逃がせた割合): **${(delegRatio * 100).toFixed(1)}%**
- 委譲率(委譲の準備込み・参考): **${(delegRatioWithPrep * 100).toFixed(1)}%**
- うち委譲の準備(仕様書執筆): **${specAuthoringOut.toLocaleString('ja-JP', { maximumFractionDigits: 0 })} tok**
- 委譲率(行ベース・**強制判定に使う値**): ${linesDelegationLine}
- 内訳 codex ${(codexOut / 1000).toFixed(0)}k / sonnet+haiku ${(delegation.sonnetHaikuOut / 1000).toFixed(0)}k / 安いAI ${(execOut / 1000).toFixed(0)}k / 監督(opus+fable+default) ${(delegation.supervisorOut / 1000).toFixed(0)}k
- 🔍 監督の出力の出どころ: ${blockSourceLine}
- ${cacheLine}
### 指示
${flags.map(f => '- ' + f).join('\n')}
### 品質ゲート
${qualityLines.map((x) => '- ' + x).join('\n')}
<!-- COST-DIRECTIVE-END -->
`;
try {
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'cost-directive.md'), md);
} catch { }

// --- 1週間観察→改善しなければハードブロックへ昇格(kim 2026-08-16) ---
const today = new Date().toISOString().slice(0, 10);
let hist = (prev && Array.isArray(prev.history)) ? prev.history : [];
if (!hist.length || hist[hist.length - 1].date !== today) hist.push({ date: today, delegRatio, delegRatioWithPrep, linesRatio, codexLines, claudeLines, claudeOut }); else hist[hist.length - 1] = { date: today, delegRatio, delegRatioWithPrep, linesRatio, codexLines, claudeLines, claudeOut };
while (hist.length > 14) hist.shift();
const obsStart = (prev && prev.obsStart) ? prev.obsStart : today;
const daysObserved = Math.round((Date.now() - new Date(obsStart + 'T00:00:00Z').getTime()) / 864e5);
const enforceFile = path.join(HOME, '.claude', 'cost-enforce.json');
let previousMode = 'warn';
try { previousMode = String(JSON.parse(fs.readFileSync(enforceFile, 'utf8')).mode || 'warn'); } catch { }
const { mode: enforce, reason: ereason, decidedBy } = decideEnforcement({
  delegRatioWithPrep, linesRatio, daysObserved, claudeOut, history: hist, target: TARGET_DELEG, targetLines: TARGET_LINES,
  pilot: fs.existsSync(path.join(HOME, '.claude', 'cost-enforce-pilot')), previousMode,
});
try { fs.writeFileSync(enforceFile, JSON.stringify({ mode: enforce, reason: ereason, since: obsStart, daysObserved, delegRatio, delegRatioWithPrep, linesRatio, codexLines, claudeLines, decidedBy, target: TARGET_DELEG, targetLines: TARGET_LINES }, null, 2)); } catch { }
try { fs.writeFileSync(stateF, JSON.stringify({ t: new Date().toISOString(), totalUSD, claudeUSD, claudeOut, codexOut, codexSessions, execUSD, work, delegRatio, delegRatioWithPrep, linesRatio, codexLines, claudeLines, landedLines, obsStart, history: hist })); } catch { }
if (enforce === 'block') console.log(`\n🔒 ハードブロック昇格: ${ereason}（アプリ実装コードの直接編集をpretooluseフックが拒否します）`);
console.log(md);

if (POST) {
  const wh = readEnvValue(path.join(HOME, '.claude', 'cost-reporter.env'), 'COST_WEBHOOK') || readEnvValue(path.join(HOME, '.claude', 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK') || process.env.COST_WEBHOOK || '';
  if (wh) { const label = process.env.REPORTER_LABEL || os.hostname(); try { await fetch(wh, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${label}** コスト×作業量ループ\n${md.replace(/<!--.*?-->/g, '').trim()}` }) }); console.error('Discord送信OK'); } catch (e) { console.error('Discord送信失敗:', e.message); } }
  else console.error('COST_WEBHOOK未設定=送信スキップ');
}
}
