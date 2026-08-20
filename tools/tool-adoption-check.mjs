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
import { execSync, execFileSync, spawn } from 'node:child_process';
import { parseEnvText } from './env-kv.mjs';
import { codexSessionDirs } from './cost-work-loop.mjs';
import { checkVersionDrift, formatDriftLine } from './version-drift.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DO_FIX = process.argv.includes('--fix');
const HOME = process.env.ORGIAST_HOME || os.homedir();
const FORCE_MISSING = new Set((process.env.TOOL_ADOPTION_FORCE_MISSING || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const FORCE_TIMEOUT = new Set((process.env.TOOL_ADOPTION_FORCE_TIMEOUT || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const FORCE_ABSENT = new Set((process.env.TOOL_ADOPTION_FORCE_ABSENT || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const FORCE_PRESENT = new Set((process.env.TOOL_ADOPTION_FORCE_PRESENT || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

const LOCAL_TIMEOUT_MS = 15000;
const NODE_CLI_TIMEOUT_MS = 30000;
const WSL_TIMEOUT_MS = 60000;
const STARTED_AT = Date.now();
const parsedDeadline = Number(process.env.TOOL_ADOPTION_DEADLINE_MS || 20000);
const DEADLINE_MS = Number.isFinite(parsedDeadline) && parsedDeadline >= 0 ? parsedDeadline : 20000;
// レポート組み立て・stdout/Discord投稿へ必ず到達するため、全体期限の末尾を外部プローブに使わない。
const REPORT_RESERVE_MS = Math.min(1500, DEADLINE_MS);
let deadlineSkipped = false;
function remainingMs() { return Math.max(0, DEADLINE_MS - REPORT_RESERVE_MS - (Date.now() - STARTED_AT)); }
function deadlineExceeded() { if (remainingMs() > 0) return false; deadlineSkipped = true; return true; }

// 日次ガード(SessionStartフックから毎回呼ばれても送信は最大1日1回)。--dry-run/--fix時はスキップしない。
const GUARD_HOURS = 20;
const statePath = path.join(HOME, '.claude', '.tool-adoption-state.json');
const installStatePath = path.join(HOME, '.claude', 'tool-adoption-install.state');
const installLogPath = path.join(HOME, '.claude', 'tool-adoption-install.log');
const INSTALL_DEDUP_MS = 30 * 60 * 1000;
if (!DRY_RUN && !process.argv.includes('--force')) {
  try { const s = JSON.parse(fs.readFileSync(statePath, 'utf-8')); if (s.last && (Date.now() - new Date(s.last).getTime()) < GUARD_HOURS * 3600000) process.exit(0); } catch {}
  // 競合防止: ガード通過直後に即座に状態を書く(近接して複数回発火しても2回目以降はここで弾かれ、重複投稿しない)
  try {
    let current = {}; try { current = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    fs.writeFileSync(statePath, JSON.stringify({ ...current, last: new Date().toISOString() }));
  } catch {}
}
const USAGE_WINDOW_DAYS = 7;
const now = Date.now();
const daysAgo = (ms) => (now - ms) / 86400000;

function loadEnv(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function failureReason(error) {
  const detail = `${error?.message || ''}\n${error?.stderr?.toString?.() || ''}`;
  if (error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT' || error?.killed) return 'timeout';
  if (error?.code === 'ENOENT' || error?.status === 127 || /is not recognized|command not found|not found/i.test(detail)) return 'notfound';
  return 'error';
}
function cmdProbe(cmd, timeout = LOCAL_TIMEOUT_MS) {
  const remaining = remainingMs();
  if (remaining <= 0) { deadlineSkipped = true; return { ok: false, stdout: '', reason: 'deadline' }; }
  try { return { ok: true, stdout: execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1, Math.min(timeout, remaining)) }).toString().trim(), reason: 'ok' }; }
  catch (error) { return { ok: false, stdout: '', reason: failureReason(error) }; }
}
function wslDistros() {
  if (process.platform !== 'win32') return [];
  const remaining = remainingMs();
  if (remaining <= 0) { deadlineSkipped = true; return []; }
  try { return execSync('wsl.exe -l -q', { stdio: ['ignore', 'pipe', 'ignore'], timeout: Math.max(1, Math.min(WSL_TIMEOUT_MS, remaining)) }).toString('utf16le').split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean); } catch { return []; }
}
function preferredDistro() { const all = wslDistros(); return all.find((x) => x.toLowerCase() === 'ubuntu') || all[0] || ''; }
// wsl -d に引用符付きで渡すと cmd.exe 経由で壊れて必ず失敗する(実測)。shellを介さず配列で渡す。
function wslRun(distro, argv) {
  const tries = distro ? [['-d', distro, '--', ...argv], ['--', ...argv]] : [['--', ...argv]];
  let lastReason = 'notfound';
  for (const args of tries) {
    const remaining = remainingMs();
    if (remaining <= 0) { deadlineSkipped = true; return { ok: false, stdout: '', reason: 'deadline' }; }
    try { return { ok: true, stdout: execFileSync('wsl.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1, Math.min(WSL_TIMEOUT_MS, remaining)) }).toString().trim(), reason: 'ok' }; }
    catch (error) { lastReason = failureReason(error); if (lastReason === 'timeout') break; }
  }
  return { ok: false, stdout: '', reason: lastReason };
}
function wslCodexVersion(distro) { return wslRun(distro, ['codex', '--version']); }

function npmGlobalPackageExists(packageName) {
  const root = cmdProbe('npm root -g');
  return root.ok && fs.existsSync(path.join(root.stdout, ...packageName.split('/')));
}
function nativeCommandExists(command, packageName) {
  if (process.platform === 'win32') {
    const appData = process.env.ORGIAST_HOME ? path.join(HOME, 'AppData', 'Roaming') : (process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'));
    if (fs.existsSync(path.join(appData, 'npm', `${command}.cmd`))) return true;
  } else {
    const found = cmdProbe(`command -v ${command}`);
    if (found.ok && !!found.stdout) return true;
    if (fs.existsSync(`/usr/bin/${command}`)) return true;
  }
  return npmGlobalPackageExists(packageName);
}
function wslCodexExists(distro) { return wslRun(distro, ['sh', '-lc', 'command -v codex']); }

function clearInstallStateIfTarget(target) {
  try {
    const state = JSON.parse(fs.readFileSync(installStatePath, 'utf8'));
    if (state.target === target) fs.unlinkSync(installStatePath);
  } catch {}
}
function installRecentlyStarted(target) {
  try {
    const state = JSON.parse(fs.readFileSync(installStatePath, 'utf8'));
    return state.target === target && Date.now() - Date.parse(state.started) < INSTALL_DEDUP_MS;
  } catch { return false; }
}
function startCodexInstall(target, distro = '', packageName = '@openai/codex') {
  if (installRecentlyStarted(target)) return false;
  const claudeDir = path.join(HOME, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(installStatePath, JSON.stringify({ started: new Date().toISOString(), target }));
  const logFd = fs.openSync(installLogPath, 'a');
  const override = process.env.TOOL_ADOPTION_INSTALL_CMD;
  const command = override || (distro ? 'wsl.exe' : 'npm');
  const args = override ? [] : (distro ? ['-d', distro, '--', 'npm', 'i', '-g', packageName] : ['i', '-g', packageName]);
  try {
    const child = spawn(command, args, { detached: true, shell: !!override, stdio: ['ignore', logFd, logFd] });
    child.unref();
    return true;
  } catch {
    try { fs.unlinkSync(installStatePath); } catch {}
    return false;
  } finally { fs.closeSync(logFd); }
}
function startGeminiInstall() {
  return startCodexInstall('gemini-native', '', '@google/gemini-cli');
}

// 再帰で最新mtime(ms)を返す。無ければ0。
function newestMtime(dir, filterExt) {
  let newest = 0;
  (function walk(d) {
    if (deadlineExceeded()) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (deadlineExceeded()) return;
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
    if (hit || deadlineExceeded()) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hit || deadlineExceeded()) return;
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
    if (deadlineExceeded()) break;
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
const installStarts = []; // 完了待ちせずバックグラウンドで開始した導入
const human = [];   // 人手が要る残タスク(最小1操作)

// ---- Codex ----
function checkCodex() {
  // テスト用フック指定時は version/WSL の外部プローブ自体を行わない。
  const forceMissing = FORCE_MISSING.has('codex');
  // FORCE_MISSING はバージョン検出だけを偽装する。ここでディストロまで空にすると
  // 「WSL未導入」分岐に落ちて detached 導入経路が検証できない(実測でテストが落ちた)。
  // テストを速く決定的にしたい時は TOOL_ADOPTION_FAKE_DISTRO で明示指定する。
  const distro = process.env.TOOL_ADOPTION_FAKE_DISTRO !== undefined ? process.env.TOOL_ADOPTION_FAKE_DISTRO : preferredDistro();
  const forcedTimeout = FORCE_TIMEOUT.has('codex');
  const nativeProbe = forceMissing ? { ok: false, stdout: '', reason: 'notfound' }
    : forcedTimeout ? { ok: false, stdout: '', reason: 'timeout' } : cmdProbe('codex --version');
  const codexProbe = forceMissing ? { ok: false, stdout: '', reason: 'notfound' }
    : forcedTimeout ? { ok: false, stdout: '', reason: 'timeout' }
      : (process.platform === 'win32' ? wslCodexVersion(distro) : nativeProbe);
  const presence = forceMissing || FORCE_ABSENT.has('codex') ? { ok: false, stdout: '', reason: 'notfound' }
    : FORCE_PRESENT.has('codex') ? { ok: true, stdout: '', reason: 'ok' }
      : (process.platform === 'win32' ? wslCodexExists(distro) : { ok: nativeCommandExists('codex', '@openai/codex'), stdout: '', reason: 'ok' });
  const installed = codexProbe.ok || presence.ok;
  const indeterminate = !installed && codexProbe.reason !== 'notfound';
  const version = codexProbe.stdout || (installed && codexProbe.reason === 'timeout' ? '(バージョン取得はタイムアウト)' : '');
  const installTarget = process.platform === 'win32' && distro ? 'wsl' : 'native';
  if (installed) clearInstallStateIfTarget(installTarget);
  const nativePresent = forceMissing || FORCE_ABSENT.has('codex') ? false : (nativeProbe.ok || nativeCommandExists('codex', '@openai/codex'));
  const nativeOnly = process.platform === 'win32' && nativePresent && !installed && !indeterminate;
  const authed = fs.existsSync(path.join(HOME, '.codex', 'auth.json'));
  const lastUsed = Math.max(0, ...codexSessionDirs(HOME).map((dir) => newestMtime(dir, '.jsonl')));
  const usedDays = lastUsed ? daysAgo(lastUsed) : Infinity;
  const used = usedDays <= USAGE_WINDOW_DAYS;
  if (!installed && !indeterminate && DO_FIX && distro) {
    if (startCodexInstall(installTarget, distro)) installStarts.push(`🔧 WSL(${distro}) への Codex 導入をバックグラウンドで開始しました（数分後・次回セッションで有効。ログ: ~/.claude/tool-adoption-install.log）`);
  }
  if (!installed && !indeterminate && process.platform === 'win32') {
    if (distro) {
      if (!(DO_FIX && installRecentlyStarted(installTarget))) human.push(`Windows版codexはread-onlyサンドボックス固定で実装に使えない。\`wsl -d ${distro} -- npm i -g @openai/codex\` で WSL 側に入れる（\`--fix\` で自動実行）`);
    } else human.push('WSLディストロ未導入→管理者ターミナルで `wsl --install -d Ubuntu`（再起動が必要）');
  } else if (!installed && !indeterminate && DO_FIX) {
    if (startCodexInstall(installTarget)) installStarts.push('🔧 native環境への Codex 導入をバックグラウンドで開始しました（数分後・次回セッションで有効。ログ: ~/.claude/tool-adoption-install.log）');
    else if (!installRecentlyStarted(installTarget)) human.push('Codex CLI のバックグラウンド導入を開始できませんでした→手動 `npm i -g @openai/codex`');
  }
  if (installed && !authed) human.push('Codex 未認証→`codex` 実行しChatGPTでログイン(1回)');
  return { name: 'Codex', installed, indeterminate, nativeOnly, version, authed, used, usedDays, role: 'コード実装の主経路(定額枠)' };
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
  const forceMissing = FORCE_MISSING.has('gemini');
  const probe = forceMissing ? { ok: false, stdout: '', reason: 'notfound' }
    : FORCE_TIMEOUT.has('gemini') ? { ok: false, stdout: '', reason: 'timeout' }
      : cmdProbe('gemini --version', NODE_CLI_TIMEOUT_MS);
  const present = !forceMissing && !FORCE_ABSENT.has('gemini') && (FORCE_PRESENT.has('gemini') || nativeCommandExists('gemini', '@google/gemini-cli'));
  const installed = probe.ok || present;
  const indeterminate = !installed && probe.reason !== 'notfound';
  const version = probe.stdout || (installed && probe.reason === 'timeout' ? '(バージョン取得はタイムアウト)' : '');
  const key = loadEnv(path.join(HOME, '.gemini', '.env')).GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
  const keyed = !!key;
  let mcpReg = false;
  try { const d = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf-8')); mcpReg = !!(d.mcpServers && d.mcpServers['gemini-cli'] && d.mcpServers['gemini-cli'].env && d.mcpServers['gemini-cli'].env.GEMINI_API_KEY); } catch {}
  if (!installed && !indeterminate && DO_FIX) {
    if (startGeminiInstall()) installStarts.push('🔧 native環境への Gemini CLI 導入をバックグラウンドで開始しました（数分後・次回セッションで有効。ログ: ~/.claude/tool-adoption-install.log）');
    else if (!installRecentlyStarted('gemini-native')) human.push('Gemini CLI のバックグラウンド導入を開始できませんでした→手動 `npm i -g @google/gemini-cli`');
  }
  if (keyed && !mcpReg) ensureGeminiMcp();
  else if (!keyed) ensureGeminiMcp(); // human タスク追加のため
  // 使用痕跡: gemini tmp のmtime or transcript の MCP呼び出し
  const tmpUsed = newestMtime(path.join(HOME, '.gemini', 'tmp'));
  const trUsed = transcriptHits(/gemini-cli|geminiChat|googleSearch|"gemini"\s*-p|gemini\s+-p/, USAGE_WINDOW_DAYS);
  const lastUsed = tmpUsed;
  const usedDays = lastUsed ? daysAgo(lastUsed) : Infinity;
  const used = trUsed || usedDays <= USAGE_WINDOW_DAYS;
  return { name: 'Gemini', installed, indeterminate, version, keyed, mcpReg: mcpReg || (DO_FIX && keyed), used, usedDays, role: '超大規模文脈・Google検索(無料枠でトークン節約)' };
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
    if (deadlineExceeded()) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (deadlineExceeded()) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        let raw; try { raw = fs.readFileSync(p, 'utf-8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          if (deadlineExceeded()) return;
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
function recentFableOutput(windowDays) {
  const root = path.join(HOME, '.claude', 'projects');
  const cutoff = now - windowDays * 86400000;
  let count = 0;
  (function walk(dir) {
    if (deadlineExceeded()) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (deadlineExceeded()) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs < cutoff) continue; } catch { continue; }
        let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          if (deadlineExceeded()) return;
          let row; try { row = JSON.parse(line); } catch { continue; }
          const timestamp = Date.parse(row.timestamp || '');
          if (Number.isFinite(timestamp) && timestamp < cutoff) continue;
          if (modelFamily(row?.message?.model) === 'fable') count += row?.message?.usage?.output_tokens || 1;
        }
      }
    }
  })(root);
  return count;
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

let driftLine = '';
if (remainingMs() < 2000) {
  deadlineSkipped = true;
  driftLine = '⚠️ **配布物の版**判定不能（デッドライン超過でスキップ・次回再判定）';
} else {
  try { driftLine = formatDriftLine(await checkVersionDrift({ timeoutMs: Math.min(8000, remainingMs()) })); }
  catch { driftLine = '⚠️ **配布物の版**判定不能（次回再判定）'; }
}

// ---- レポート組み立て ----
const label = loadEnv(path.join(HOME, '.claude', 'cost-reporter.env')).REPORTER_LABEL || os.hostname();
let msg = `**🛠️ ツール採用チェック** — ${label} (直近${USAGE_WINDOW_DAYS}日)\n`;
msg += `${driftLine}\n`;
for (const c of checks) {
  let icon, note;
  if (c.name === 'Kimi' && !c.keyed) { icon = '🚨'; note = 'APIキー未設定→~/.claude/kimi-api.env に MOONSHOT_API_KEY= を設定'; }
  else if (c.name === 'Kimi' && c.used) { icon = '✅'; note = c.count === null ? '使用あり(痕跡のみ)' : `使用あり(${c.count}回)`; }
  else if (c.name === 'Kimi') { icon = '⚠️'; note = '未使用=Claude従量を別課金プールへ逃がせていない(§1.13)。量産・分類・中量級生成は `node tools/llm-ask.mjs --provider kimi "…"` へ'; }
  else if (c.appEmbedded) { icon = c.used ? '✅' : '☑️'; note = c.used ? `使用あり(直近)${c.traceOnly ? '(痕跡のみ)' : ''}` : '未使用(aujust未実行なら想定内)'; }
  else if (c.indeterminate) { icon = '⚠️'; note = '判定不能(プローブがタイムアウト・次回再判定)'; }
  else if (c.name === 'Codex' && c.nativeOnly) { icon = '🚨'; note = 'Windows版codexはread-onlyサンドボックス固定で実装に使えない。WSL側への導入が必要'; }
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

// ---- 決めた施策が実際に使われたか ----
const wantedProviders = ['kimi', 'groq', 'openrouter', 'gemini', 'deepseek'];
const adoptionCounts = Object.fromEntries(wantedProviders.map((provider) => [provider, providerCounts?.[provider] || 0]));
let batchCount = 0;
try {
  const queueDir = path.join(HOME, '.claude', 'batch-queue');
  for (const name of fs.readdirSync(queueDir)) {
    if (name !== 'pending.jsonl' && !/^results-.*\.jsonl$/.test(name)) continue;
    const file = path.join(queueDir, name);
    if (fs.statSync(file).mtimeMs < now - USAGE_WINDOW_DAYS * 86400000) continue;
    batchCount += fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length;
  }
} catch {}
const fableCount = recentFableOutput(USAGE_WINDOW_DAYS);
msg += `\n**決めた施策が実際に使われたか（直近${USAGE_WINDOW_DAYS}日）**\n`;
msg += `| 実行者/施策 | 使用回数 | 判定 |\n|---|---:|---|\n`;
for (const provider of wantedProviders) msg += `| ${provider} | ${adoptionCounts[provider]} | ${adoptionCounts[provider] ? '✅' : '⚠️ 使用0'} |\n`;
msg += `| 夜間バッチ投入/結果 | ${batchCount} | ${batchCount ? '✅' : '⚠️ 使用0'} |\n`;
msg += `| Fable5 (§1.16) | ${fableCount ? formatTokens(fableCount) : '0'} | ${fableCount ? '🚨 検出' : '✅ 未検出'} |\n`;
if (deadlineSkipped) msg += `※一部の判定はデッドライン超過でスキップしました(次回再判定)\n`;

if (fixes.length) msg += `\n🔧 自動修復: ${fixes.join(' / ')}\n`;
if (installStarts.length) msg += `\n${installStarts.join('\n')}\n`;
if (human.length) msg += `\n🙋 要人手(最小1操作): ${human.join(' / ')}\n`;
if (!fixes.length && !installStarts.length && !human.length) msg += `\n(健全性OK。未使用⚠️があればルーティング(§1.13)を意識)\n`;
msg += `※使用痕跡はセッションファイル/キー/MCP登録のみ判定。会話内容は読んでいません。`;

console.log(msg);
const adoptionState = {
  last: new Date(now).toISOString(),
  codexInstalled: Boolean(checks.find((c) => c.name === 'Codex')?.installed),
  codexAuthed: Boolean(checks.find((c) => c.name === 'Codex')?.authed),
  geminiInstalled: Boolean(checks.find((c) => c.name === 'Gemini')?.installed),
  cheapAiCounts: providerCounts || {},
  fable5OutTok: fableCount,
  verdicts: Object.fromEntries(checks.map((c) => [c.name.toLowerCase(), { installed: Boolean(c.installed), used: Boolean(c.used), indeterminate: Boolean(c.indeterminate) }]).concat([['discipline', disc]])),
};
if (DRY_RUN) { console.log('\n--dry-run: Discord未送信'); process.exit(0); }
try {
  let previous = {}; try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  fs.writeFileSync(statePath, JSON.stringify({ ...previous, ...adoptionState }));
} catch {}
const webhook = loadEnv(path.join(HOME, '.claude', 'cost-reporter.env')).DISCORD_COST_WEBHOOK;
if (!webhook) { console.error('DISCORD_COST_WEBHOOK未設定'); process.exit(1); }
fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msg.slice(0, 1950) }) })
  .then((r) => console.log(r.ok ? 'posted' : `discord ${r.status}`)).catch((e) => console.error(e.message));
