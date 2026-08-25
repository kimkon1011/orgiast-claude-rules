#!/usr/bin/env node
// GitHub 配布正本を CLAUDE.md の専用ブロックへ同期する。hookを壊さないため失敗は握る。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEnvValue } from './env-kv.mjs';
import { repairEnvBom } from './env-repair.mjs';
import { isEntry } from './is-entry.mjs';
import { buildKeyserveAlert, shouldAlert } from './keyserve-alert.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const targetArg = args.find((x) => x.startsWith('--target='));
const home = process.env.ORGIAST_HOME || os.homedir();
const target = targetArg ? targetArg.slice(9) : path.join(home, '.claude', 'CLAUDE.md');
const statePath = path.join(home, '.claude', '.onboarding-sync-state.json');
const repoStatePath = path.join(home, '.claude', '.repo-sync-state.json');
const keysStatePath = path.join(home, '.claude', '.keys-sync-state.json');
const repoPath = path.join(home, 'orgiast-claude-rules');
const logPath = path.join(home, '.claude', 'hooks', 'onboarding-sync.log');
const rawUrl = process.env.ORGIAST_ONBOARDING_URL || 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md';
const keyserveUrl = process.env.ORGIAST_KEYSERVE_URL || 'https://orgiast-keyserve.vercel.app/api/keys';
const beginPrefix = '<!-- BEGIN: オージャスト共通ルール';
const endMarker = '<!-- END: オージャスト共通ルール -->';
const indexLead = '全文は ~/.claude/rules/orgiast-onboarding.md（および https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/ONBOARDING.md ）。判断に迷ったら該当節の全文を読むこと';

function log(message) {
  if (dryRun) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    let old = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    if (old.length > 10240) old = old.slice(-8192);
    const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).replace(',', '');
    fs.writeFileSync(logPath, `${old.replace(/[\r\n]+$/, '')}${old ? '\n' : ''}${stamp}\t${message}`, 'utf8');
  } catch {}
}
function state() { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } }
function repoState() { try { return JSON.parse(fs.readFileSync(repoStatePath, 'utf8')); } catch { return null; } }
function keysState() { try { return JSON.parse(fs.readFileSync(keysStatePath, 'utf8')); } catch { return null; } }
function saveRepoState(now) {
  if (dryRun) return;
  try { fs.mkdirSync(path.dirname(repoStatePath), { recursive: true }); fs.writeFileSync(repoStatePath, `${JSON.stringify({ last: now.toISOString() }, null, 2)}\n`, 'utf8'); } catch {}
}
function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to); else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
export function deploySkills(sourceRepo, targetHome, options = {}) {
  const updated = new Set();
  try {
    const source = path.join(sourceRepo, 'skills');
    if (!fs.existsSync(source)) return [];
    const iso = (options.now || new Date()).toISOString();
    const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
    const copyChanged = (fromDir, toDir, skill) => {
      fs.mkdirSync(toDir, { recursive: true });
      for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
        const from = path.join(fromDir, entry.name), to = path.join(toDir, entry.name);
        if (entry.isDirectory()) copyChanged(from, to, skill);
        else if (entry.isFile()) {
          const same = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to));
          if (same) continue;
          if (fs.existsSync(to)) fs.copyFileSync(to, `${to}.bak.${stamp}`);
          fs.copyFileSync(from, to); updated.add(skill);
        }
      }
    };
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) if (entry.isDirectory()) copyChanged(path.join(source, entry.name), path.join(targetHome, '.claude', 'skills', entry.name), entry.name);
    if (updated.size && !options.quiet) console.log(`[onboarding-sync] skills updated: ${[...updated].join(', ')}`);
    return [...updated];
  } catch (e) { if (options.onError) options.onError(e); return []; }
}
async function syncRepository(now) {
  try {
    if (!fs.existsSync(repoPath)) return;
    const previous = repoState();
    if (!force && previous?.last && now - new Date(previous.last) < 24 * 60 * 60 * 1000) return;
    if (dryRun) { console.log(`[dry-run] リポ日次更新対象: ${repoPath} (書き込み・取得なし)`); return; }
    saveRepoState(now);
    // バックアップはリポ外(~/.claude/repo-backups)に置く: リポ内だと git status を汚し、毎日積み上がる
    const backupRoot = path.join(home, '.claude', 'repo-backups');
    const backup = path.join(backupRoot, `tools.bak-${now.toISOString().slice(0, 10)}`);
    if (fs.existsSync(path.join(repoPath, 'tools')) && !fs.existsSync(backup)) copyTree(path.join(repoPath, 'tools'), backup);
    // 直近3世代だけ残す(古いものから削除)
    try {
      const olds = fs.readdirSync(backupRoot).filter((n) => n.startsWith('tools.bak-')).sort();
      for (const old of olds.slice(0, Math.max(0, olds.length - 3))) fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true });
    } catch {}
    let changed = false;
    // 取得の失敗(未追跡ファイル衝突/ネット断/認証切れ)で skill 配布と hook 登録まで巻き添えにしない。
    // ここを1つの try に入れていたため、pull が1回失敗した PC は配布が静かに止まっていた(実測 2026-08-19)。
    try {
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      const before = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 60000 }).trim();
      execFileSync('git', ['-C', repoPath, 'pull', '--ff-only'], { stdio: 'pipe', timeout: 60000 });
      const after = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 60000 }).trim();
      changed = before !== after;
    } else {
      const response = await fetch('https://github.com/kimkon1011/orgiast-claude-rules/archive/refs/heads/main.zip', { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`repo zip HTTP ${response.status}`);
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-repo-sync-'));
      const zip = path.join(temp, 'main.zip'); fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
      const expanded = path.join(temp, 'expanded'); fs.mkdirSync(expanded);
      if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', zip, '-DestinationPath', expanded, '-Force'], { timeout: 60000 });
      else execFileSync('unzip', ['-q', zip, '-d', expanded], { timeout: 60000 });
      const root = path.join(expanded, 'orgiast-claude-rules-main');
      for (const name of ['tools', 'rules-extracted', 'skills']) if (fs.existsSync(path.join(root, name))) copyTree(path.join(root, name), path.join(repoPath, name));
      changed = true;
    }
    } catch (e) { console.log(`[onboarding-sync] リポ取得に失敗（skill配布とhook登録は続行）: ${e.message.split('\n')[0]}`); log(`repo fetch failed(continue): ${e.message}`); }
    if (changed) { console.log('[onboarding-sync] updated repository tools/rules/skills'); log('updated repository tools/rules/skills'); }
    const skills = deploySkills(repoPath, home, { now, onError: (e) => log(`skill deployment failed: ${e.message}`) });
    if (skills.length) log(`skills updated: ${skills.join(', ')}`);
    // 新しく配布された hook を全PCへ自動登録する(add-only・差分が無ければ何も書かない)。
    try {
      const registrar = path.join(repoPath, 'tools', 'register-hooks.mjs');
      if (fs.existsSync(registrar)) {
        const out = execFileSync(process.execPath, [registrar, '--hooks-only'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repoPath } }).trim();
        if (out.includes('追加')) { console.log(`[onboarding-sync] ${out.trim()}`); log(out.replace(/\s+/g, ' ')); }
      }
    } catch (e) { log(`hook registration failed: ${e.message}`); }
  } catch (e) { log(`repo sync failed: ${e.message}`); }
}
function saveKeysState(now) {
  try {
    fs.mkdirSync(path.dirname(keysStatePath), { recursive: true });
    fs.writeFileSync(keysStatePath, `${JSON.stringify({ last: now.toISOString() }, null, 2)}\n`, 'utf8');
  } catch {}
}
function saveKeysAlertState(previous, now) {
  try {
    fs.mkdirSync(path.dirname(keysStatePath), { recursive: true });
    fs.writeFileSync(keysStatePath, `${JSON.stringify({ ...(previous || {}), lastAlert: now.toISOString() }, null, 2)}\n`, 'utf8');
  } catch {}
}
async function alertKeyserveFailure(previous, now, status) {
  const keyserveEnvExists = fs.existsSync(path.join(home, '.claude', 'keyserve.env'));
  const rotationHint = status === 401 && keyserveEnvExists
    ? ' (この PC は既存 keyserve.env の秘密で認証を試みています。サーバ側で秘密がローテーションされた可能性があります)'
    : '';
  const visible = `[onboarding-sync] keyserve から鍵が受け取れていません (HTTP status: ${status ?? '不明'})${rotationHint}`;
  console.log(visible);
  if (dryRun || !shouldAlert(previous, now)) return;
  const reporterEnv = path.join(home, '.claude', 'cost-reporter.env');
  const webhook = readEnvValue(reporterEnv, 'DISCORD_COST_WEBHOOK');
  if (!webhook) return;
  const content = buildKeyserveAlert({
    label: readEnvValue(reporterEnv, 'REPORTER_LABEL'),
    hostname: os.hostname(),
    status,
    command: 'node ~/orgiast-claude-rules/tools/onboarding-sync.mjs --force',
  });
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'orgiast-keyserve-alert/1.0' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    saveKeysAlertState(previous, now);
  } catch {}
}
async function provisionKeys(now) {
  if (dryRun) return;
  const previous = keysState();
  if (!force && previous?.last && now - new Date(previous.last) < 24 * 60 * 60 * 1000) return;
  let secret = process.env.ORGIAST_KEYSERVE_SECRET || '';
  if (!secret) secret = readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET');
  if (!secret) {
    secret = readEnvValue(path.join(home, '.claude', 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK');
    if (secret) log('legacy secret を使用中（keyserve.env 未受領）');
  }
  if (!secret) return;
  try {
    const ts = Math.floor(Date.now() / 1000).toString();
    const auth = crypto.createHmac('sha256', secret).update(ts).digest('hex');
    const response = await fetch(keyserveUrl, {
      method: 'POST',
      headers: { 'x-orgiast-ts': ts, 'x-orgiast-auth': auth },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    if (!payload || typeof payload.files !== 'object' || payload.files === null || Array.isArray(payload.files)) throw new Error('invalid response');
    const provisioned = [];
    const refreshed = [];
    for (const [name, contents] of Object.entries(payload.files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..') || typeof contents !== 'string') continue;
      const destination = path.join(home, '.claude', name);
      const cleanedContents = contents.replace(/^\uFEFF/, '');
      if (fs.existsSync(destination)) {
        if (name !== 'keyserve.env' || fs.readFileSync(destination, 'utf8') === cleanedContents) continue;
        fs.writeFileSync(destination, cleanedContents, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(destination, 0o600);
        refreshed.push(name);
        log(`refreshed: ${name}`);
        continue;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, cleanedContents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      provisioned.push(name);
      log(`provisioned: ${name}`);
    }
    repairEnvBom({ home });
    saveKeysState(now);
    if (provisioned.length) console.log(`[onboarding-sync] provisioned: ${provisioned.join(', ')}`);
    if (refreshed.length) console.log(`[onboarding-sync] refreshed: ${refreshed.join(', ')}`);
  } catch (e) {
    log(`key provisioning failed: ${e.message}`);
    await alertKeyserveFailure(previous, now, e.status);
  }
}
function save(hash, now) {
  if (dryRun) return;
  try { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, `${JSON.stringify({ lastCheck: now.toISOString(), hash }, null, 2)}\n`, 'utf8'); } catch {}
}
export function makeIndex(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept = [indexLead];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}(?:\s|$)/.test(line)) {
      kept.push(line);
      for (let j = i + 1; j < lines.length && !/^#{1,3}(?:\s|$)/.test(lines[j]); j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        const end = candidate.indexOf('。');
        kept.push(end >= 0 ? candidate.slice(0, end + 1) : candidate);
        break;
      }
    }
    // 絶対ルール・上限規定の行は全文のまま残す。原文は `**🛑 上限…` のように強調記号が先に来るので
    // 先頭の `*` を許容する(ここを `**🔴` だけにすると 🛑/⚙️/🔁 の4行が索引から落ちる)。
    if (/^\*{0,2}\s*(?:🔴|🛑|⚙️|🔁)/u.test(line) && kept.at(-1) !== line) kept.push(line);
  }
  return kept.join('\n');
}
export function build(current, body, label) {
  const block = `${beginPrefix} (自動同期 ${label}) -->\n${body}\n${endMarker}`;
  if (current === null) return { updated: block, action: '新規作成' };
  // 行全体が開始マーカー形式そのものである場合だけ対象にする(部分一致は自己言及文書に誤爆する)。
  // ラベル部分の形式は縛らない: 日付形式を固定すると、別形式で導入されたPCで置換に失敗し
  // 「末尾へ追記」に落ちてブロックが二重になる。
  const isBegin = (line) => line.startsWith(beginPrefix) && line.endsWith('-->');
  const matches = [...current.matchAll(/^.*$/gm)];
  const begin = matches.find((match) => isBegin(match[0].replace(/\r$/, '').trim()));
  if (begin) {
    const afterBegin = begin.index + begin[0].length + (current[begin.index + begin[0].length] === '\n' ? 1 : 0);
    const end = matches.find((match) => match.index >= afterBegin && match[0].replace(/\r$/, '') === endMarker);
    if (end) {
      const afterEnd = end.index + end[0].length;
      return { updated: current.slice(0, begin.index) + block + current.slice(afterEnd), action: '既存ブロックを置換' };
    }
  }
  return { updated: `${current.replace(/[\r\n]+$/, '')}\n\n${block}`, action: 'マーカーなし/不完全のため末尾へ追記' };
}

async function main() { try {
  const now = new Date();
  await syncRepository(now);
  await provisionKeys(now);
  const oldState = state();
  if (!force && !dryRun && oldState?.lastCheck && now - new Date(oldState.lastCheck) < 20 * 60 * 60 * 1000) return;
  let bodyBytes;
  try {
    const response = await fetch(rawUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bodyBytes = Buffer.from(await response.arrayBuffer());
  } catch (e) { log(`fetch failed: ${e.message}`); return; }
  if (!bodyBytes?.length) { log('fetch returned empty body, skip'); return; }
  const hash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  const body = bodyBytes.toString('utf8');
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const result = build(current, makeIndex(body), now.toISOString().slice(0, 10));
  const rulesPath = path.join(home, '.claude', 'rules', 'orgiast-onboarding.md');
  const rulesCurrent = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath) : null;
  if (!dryRun && current === result.updated && rulesCurrent?.equals(bodyBytes)) { save(hash, now); return; }
  if (dryRun) {
    console.log(`[dry-run] 対象: ${target}`);
    console.log(`[dry-run] 変更: ${result.action}`);
    console.log(`[dry-run] hash: ${hash.slice(0, 8)} / 書き込み・バックアップ・state更新なし`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, bodyBytes);
    if (current !== null) fs.copyFileSync(target, `${target}.bak.${now.toISOString().slice(0, 10)}-onboarding-index`);
    fs.writeFileSync(target, result.updated, 'utf8');
    save(hash, now);
    console.log(`[onboarding-sync] updated CLAUDE.md (hash ${hash.slice(0, 8)})`);
    log(`updated (hash ${hash.slice(0, 8)})`);
  }
} catch (e) { log(`unexpected error: ${e.message}`); } }

if (isEntry(import.meta.url)) await main();
