#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { machineIdentity } from './machine-identity.mjs';
import { addDecision, listDecisions } from './pending-decisions.mjs';
import { loadOptin, redactSecrets, targetMatches, runPrompt, consentCommand } from './fleet-agent.mjs';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';

const ownRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const decisionPrefix = /^\s*\[判断依頼\]/;
export function hasDecisionRequest(mail) {
  return decisionPrefix.test(mail.body ?? '') || decisionPrefix.test(mail.why ?? '');
}
// 本文先頭の実行モードマーカー（送信側 --exec codex が挿入する）。GAS は messageKind を prompt のまま扱う。
const execMarker = /^<!--\s*fleet-exec:\s*codex\s*-->\s*$/;
const execCwdMarker = /^<!--\s*fleet-exec-cwd:\s*(.*?)\s*-->\s*$/;
export function parseExecMarkers(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  if (!execMarker.test(lines[0] ?? '')) return { exec: null, cwd: null, body: String(body ?? '') };
  let index = 1;
  let cwd = null;
  const cwdMatch = (lines[index] ?? '').match(execCwdMarker);
  if (cwdMatch) { cwd = cwdMatch[1]; index += 1; }
  return { exec: 'codex', cwd, body: lines.slice(index).join('\n') };
}
export const LOCK_MS = 10 * 60 * 1000;
export function validId(id) {
  if (!/^mail-[A-Za-z0-9-]{1,180}$/.test(String(id ?? ''))) throw new Error('invalid mail id');
  return id;
}
export function resolveRemoteName(to, pcMap) {
  if (typeof to === 'string' && pcMap && typeof pcMap === 'object' && !Array.isArray(pcMap)) {
    const normalized = to.normalize('NFKC').trim();
    for (const [label, entry] of Object.entries(pcMap)) {
      if (label.startsWith('_') || typeof entry?.remoteName !== 'string') continue;
      if (entry.remoteName.normalize('NFKC').trim() === normalized) {
        // Resolve to the reporter label: cloned PCs can share a hostname (作業用004 and kimko-PC both report DESKTOP-PPD5V8I).
        return { to: label, resolved: true };
      }
    }
  }
  return { to, resolved: false };
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function envFile(file) {
  try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
// Discord監視も fleet-mail と同じPCラベルで動作を判定する。
export function resolveFleetLabel(home, identity = machineIdentity()) {
  return envFile(path.join(home, '.claude', 'cost-reporter.env')).REPORTER_LABEL || identity.hostname;
}
export function readInbox(home, { unreadOnly = true } = {}) {
  const dir = path.join(home, '.claude', 'fleet-inbox');
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(f => /^mail-[A-Za-z0-9-]+\.json$/.test(f)).flatMap(f => {
    try {
      const mail = readJson(path.join(dir, f));
      return mail && (!unreadOnly || !mail.readAt) ? [mail] : [];
    } catch { return []; } // One damaged file must not hide other unread messages.
  }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
export function acquireLock(file, { now = Date.now, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = { pid, nonce: randomUUID(), createdAt: now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd);
      const owns = () => { try { return readJson(file)?.nonce === owner.nonce; } catch { return false; } };
      const heartbeat = setInterval(() => { if (owns()) { const d = new Date(now()); fs.utimesSync(file, d, d); } }, 30_000);
      heartbeat.unref();
      return () => { clearInterval(heartbeat); if (owns()) fs.unlinkSync(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const reclaim = `${file}.reclaim`;
      try { fs.mkdirSync(reclaim); } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
      try {
        const stat = fs.statSync(file);
        if (now() - stat.mtimeMs < LOCK_MS) return null;
        fs.unlinkSync(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      finally { fs.rmdirSync(reclaim); }
    }
  }
  return null;
}
export function findPriorReply(dir, id) {
  const sentFile = path.join(dir, 'fleet-mail-sent.jsonl');
  let sentLines;
  try {
    sentLines = fs.readFileSync(sentFile, 'utf8').split('\n').filter(l => l.trim());
  } catch (e) {
    if (e.code === 'ENOENT') sentLines = [];
    else throw e;
  }
  for (const line of sentLines) {
    try {
      const entry = JSON.parse(line);
      if (entry.id === id && (entry.action === 'reply' || entry.action === 'auto-reply')) {
        return { at: entry.at, action: entry.action };
      }
    } catch { /* skip malformed line */ }
  }
  const inboxPath = path.join(dir, 'fleet-inbox', `${id}.json`);
  let mail = null;
  try { mail = readJson(inboxPath, null); } catch { /* damaged inbox file: sent.jsonl stays the source of truth */ }
  if (mail && mail.status === 'done') {
    return { at: mail.resultAt ?? null, action: 'inbox-done' };
  }
  return null;
}
export function parseArgs(argv) {
  const options = {};
  const flags = new Set(['--send', '--poll', '--dry-run', '--json', '--inbox', '--force']);
  const values = new Set(['--to', '--kind', '--body-file', '--why', '--expires-hours', '--wait', '--reply', '--ack', '--sent-status', '--exec', '--exec-cwd']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option: ${key}`);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else throw new Error(`unknown option or missing value: ${key}; 本文は --body-file を使ってください`);
  }
  const actions = ['--send', '--poll', '--inbox', '--reply', '--ack', '--sent-status'].filter(k => options[k]);
  if (actions.length !== 1) throw new Error('指定は --send / --poll / --reply / --inbox / --ack / --sent-status のいずれか1つ');
  const allowed = {
    '--send': ['--to', '--kind', '--body-file', '--why', '--expires-hours', '--wait', '--exec', '--exec-cwd'],
    '--poll': ['--dry-run', '--json'], '--inbox': ['--json'], '--reply': ['--body-file', '--force'], '--ack': [],
    '--sent-status': []
  };
  for (const key of Object.keys(options)) if (key !== actions[0] && !allowed[actions[0]].includes(key)) throw new Error(`option not applicable: ${key}`);
  if (options['--send']) {
    for (const key of ['--to', '--kind', '--body-file', '--why']) if (!options[key]?.trim()) throw new Error(`${key} 必須`);
    if (!['prompt', 'note'].includes(options['--kind'])) throw new Error('--kind must be prompt or note');
    if (options['--to'].length > 128 || options['--why'].length > 1000) throw new Error('宛先または理由が長すぎます');
    if (options['--exec'] !== undefined) {
      if (options['--exec'] !== 'codex') throw new Error('--exec は codex のみ対応');
      if (options['--kind'] !== 'prompt') throw new Error('--exec は --kind prompt でのみ使えます');
    }
    if (options['--exec-cwd'] !== undefined && options['--exec'] === undefined) throw new Error('--exec-cwd は --exec codex と併用してください');
  }
  if (options['--reply'] && !options['--body-file']) throw new Error('--body-file 必須');
  for (const key of ['--reply', '--ack', '--sent-status']) if (options[key]) validId(options[key]);
  for (const key of ['--expires-hours', '--wait']) if (options[key] !== undefined && (!Number.isFinite(Number(options[key])) || Number(options[key]) < (key === '--wait' ? 0 : 0.001))) throw new Error(`invalid ${key}`);
  return options;
}
export function createClient({ url, token, fetchImpl = fetch }) {
  return async (kind, payload, timeoutMs = 60_000) => {
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ ...payload, kind, token }), signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)))
    });
    if (!response.ok) throw new Error(`fleet-mail HTTP ${response.status}`);
    const result = await response.json();
    if (result?.ok !== true) throw new Error(`fleet-mail: ${result?.error || 'invalid response'}`);
    // Old GAS falls back to status writes for unknown kinds: never call that a success.
    if (kind === 'mail-poll' ? !Array.isArray(result.messages) : !Object.hasOwn(result, 'mail')) throw new Error('fleet-mail: GAS mail handlers are not deployed');
    return result;
  };
}
export async function waitForReply(id, seconds, { request, now = Date.now, sleepImpl = sleep }) {
  const deadline = now() + seconds * 1000;
  while (now() < deadline) {
    try {
      const result = await request('mail-get', { id }, Math.min(60_000, deadline - now()));
      if (result.mail?.status === 'done') return { exitCode: 0, text: redactSecrets(result.mail.resultBody) };
    } catch (error) { if (now() < deadline) throw error; }
    if (now() < deadline) await sleepImpl(Math.min(15_000, deadline - now()));
  }
  return { exitCode: 2, text: `未返信（id=${id}）` };
}
// 受信1回分。main の --poll からも、対話セッションの hook（fleet-inbox-context.mjs）からも呼ばれる。
// 受信タスク(OrgiastFleetMail)が死んでいても対話セッションが受信を代替するための exports（2026-10-10 事故）。
// executePrompts: false なら prompt のヘッドレス実行は行わず受信だけする（hook が 90秒の実行で固まるのを防ぐ）。
export async function pollOnce(deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const dir = path.join(home, '.claude');
  const out = deps.stdout ?? (text => console.log(text));
  const err = deps.stderr ?? (text => console.error(text));
  const now = deps.now ?? Date.now;
  const dryRun = !!deps.dryRun;
  const json = !!deps.json;
  const executePrompts = deps.executePrompts !== false;
  const inboxFile = id => path.join(dir, 'fleet-inbox', `${validId(id)}.json`);
  const log = (name, value) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `fleet-mail-${name}.jsonl`), `${JSON.stringify({ at: new Date(now()).toISOString(), ...value })}\n`, { mode: 0o600 });
  };
  const config = envFile(path.join(dir, 'fleet-sheet.env'));
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) { err('fleet-mail: fleet-sheet.env 未設定のためスキップ'); return { skipped: 'unconfigured' }; }
  const identity = deps.identity ?? machineIdentity();
  const label = deps.label ?? resolveFleetLabel(home, identity);
  const request = deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch });
  const release = dryRun ? () => {} : acquireLock(path.join(dir, 'fleet-mail.lock'), { now });
  if (!release) { err('fleet-mail: 別の受信処理が実行中'); return { skipped: 'locked' }; }
  try {
    const processedFile = path.join(dir, '.fleet-mail-processed');
    let processed = new Set();
    try { processed = new Set(fs.readFileSync(processedFile, 'utf8').split(/\r?\n/).filter(Boolean)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Reuse a poll request id until the full response is durable on disk.
    const pollFile = path.join(dir, '.fleet-mail-poll.json');
    const batch = dryRun ? {} : readJson(pollFile) || { requestId: randomUUID() };
    if (!dryRun) writeJson(pollFile, batch);
    const response = await request('mail-poll', { to: label, hostname: identity.hostname, dryRun, requestId: batch.requestId,
      processedIds: readInbox(home, { unreadOnly: false }).filter(m => m.to === 'all' && processed.has(m.id) && Date.parse(m.expiresAt) > now()).map(m => m.id) });
    if (dryRun) { out(JSON.stringify(response.messages.map(m => ({ ...m, from: redactSecrets(m.from), why: redactSecrets(m.why), body: redactSecrets(m.body), resultBody: redactSecrets(m.resultBody) })))); return { messages: response.messages }; }
    const received = [];
    const decisionAcks = [];
    // Persist the whole batch before any potentially slow prompt execution or network follow-ups.
    for (const raw of response.messages) {
      validId(raw.id);
      if (!targetMatches(raw.to, label, identity.hostname) || !['note', 'prompt'].includes(raw.kind)) throw new Error('invalid incoming mail');
      if (processed.has(raw.id)) continue;
      const file = inboxFile(raw.id);
      if (!fs.existsSync(file)) {
        const mail = { ...raw, from: redactSecrets(raw.from), why: redactSecrets(raw.why), body: redactSecrets(raw.body), readAt: null, receivedAt: new Date(now()).toISOString() };
        writeJson(file, mail); log('received', { id: mail.id, from: mail.from, kind: mail.kind });
        if (mail.kind === 'note' && hasDecisionRequest(mail)) {
          try {
            const source = `fleet-mail:${mail.from}:${mail.id}`;
            let record = listDecisions({ home }).find(decision => decision.source === source);
            if (!record) {
              const subject = String(mail.why ?? '').replace(decisionPrefix, '').trim()
                || String(mail.body ?? '').trimStart().split(/\r?\n/)[0].replace(decisionPrefix, '').trim();
              record = addDecision({ source, text: `[判断依頼] ${subject} / from=${mail.from} id=${mail.id}`.slice(0, 200) }, { home, now: new Date(now()) });
            }
            decisionAcks.push({ mail, record });
          } catch (error) {
            log('decision-intake-failed', { id: mail.id, error: redactSecrets(error.message) });
          }
        }
      }
      received.push(raw.id);
    }
    // 受領確認の自動返信: 送信側が「届いて待ち状態」だと分かるようにする（2026-10-10 事故）。
    // 本回答は kim が決めた後に別メッセージ(--send)で送るので、受領確認が返信 id を先に使っても競合しない。
    for (const { mail, record } of decisionAcks) {
      try {
        const ackBody = `受領しました。kim の判断待ちとして登録（決定ID ${record.id}）。回答は kim が決めた後に別の note で送ります。期限: ${mail.expiresAt}`;
        await request('mail-reply', { id: mail.id, from: label, resultBody: ackBody });
        log('sent', { action: 'decision-ack', id: mail.id, decisionId: record.id });
      } catch (error) {
        log('decision-ack-failed', { id: mail.id, error: redactSecrets(error.message) });
      }
    }
    writeJson(path.join(dir, '.fleet-mail-last-poll.json'), { at: new Date(now()).toISOString() });
    fs.unlinkSync(pollFile);
    // Resume pending inbox records after failures, including a failed reply POST.
    const pending = readInbox(home, { unreadOnly: false }).filter(m => !processed.has(m.id));
    let promptHandled = false;
    const handled = [];
    for (const mail of pending) {
      if (mail.kind === 'prompt') {
        // [判断依頼] はヘッドレスが答えない: kim 本人の判断を代行しない（2026-10-10 事故: autopilot が「A で進めます」）。
        if (hasDecisionRequest(mail)) {
          log('decision-request-skipped', { id: mail.id, from: mail.from });
          writeJson(path.join(dir, 'fleet-agent-results', `${validId(mail.id)}.json`),
            { exitCode: null, outputTail: '判断依頼を含むためヘッドレス実行では回答しません（decision-request-skipped）。kim の判断待ちです。' });
          fs.appendFileSync(processedFile, `${mail.id}\n`, { mode: 0o600 }); processed.add(mail.id); handled.push(mail.id);
          continue;
        }
        if (!executePrompts) continue; // hook からの受信: 実行は受信タスク/対話セッションに任せる
        // --exec codex: 本文先頭のマーカーで相手PCの Codex に実装させる経路（デタッチ起動・結果ファイル待ち）。
        const exec = parseExecMarkers(mail.body);
        if (exec.exec === 'codex') {
          const resultFile = path.join(dir, 'fleet-agent-results', `${validId(mail.id)}.json`);
          const result = readJson(resultFile);
          if (result) {
            await request('mail-reply', { id: mail.id, from: label, resultBody: result.outputTail });
            log('sent', { action: 'auto-reply', id: mail.id, exitCode: result.exitCode, exec: 'codex' });
            try {
              const inboxMail = readJson(inboxFile(mail.id), null);
              if (inboxMail) writeJson(inboxFile(mail.id), { ...inboxMail, status: 'done', resultAt: new Date(now()).toISOString(), resultBody: result.outputTail });
            } catch (e) { err(`fleet-mail: inbox への返信記録に失敗（送信は成功）: ${e.message}`); }
          } else if (Date.parse(mail.expiresAt) <= now()) {
            await request('mail-reply', { id: mail.id, from: label, resultBody: '有効期限切れのため実行しません。' });
            log('sent', { action: 'auto-reply', id: mail.id, exitCode: null, exec: 'codex' });
          } else if (!loadOptin(path.join(dir, 'fleet-agent-optin.json')).includes('codex')) {
            await request('mail-reply', { id: mail.id, from: label, resultBody: `未オプトイン。承諾コマンド: ${consentCommand('codex')}` });
            log('sent', { action: 'auto-reply', id: mail.id, exitCode: null, exec: 'codex' });
          } else if (!mail.executionStartedAt) {
            // 初回: 開始印を書いて runner をデタッチ起動する。この時点では返信しない（結果ファイル待ち）。
            writeJson(inboxFile(mail.id), { ...readJson(inboxFile(mail.id)), executionStartedAt: new Date(now()).toISOString() });
            const spawnImpl = deps.spawnImpl ?? spawn;
            // Windows では detached が可視コンソールを出すので backgroundSpawnOptions（win32: windowsHide / それ以外: detached）に従う。
            const child = spawnImpl(process.execPath, [path.join(ownRepo, 'tools', 'fleet-task-runner.mjs'), '--id', mail.id],
              { ...backgroundSpawnOptions(), stdio: 'ignore', windowsHide: true });
            child.unref();
            log('exec-started', { id: mail.id, exec: 'codex' });
            continue; // 返信も processed 記録もしない: 結果ファイルができたら次回返信する
          } else if (now() - Date.parse(mail.executionStartedAt) >= 2 * 3600000) {
            await request('mail-reply', { id: mail.id, from: label, resultBody: 'codex 実行がタイムアウト（結果ファイル未生成）' });
            log('sent', { action: 'auto-reply', id: mail.id, exitCode: null, exec: 'codex', timedOut: true });
          } else {
            continue; // 実行中: 結果ファイルができるまで待つ（返信も processed 記録もしない）
          }
          fs.appendFileSync(processedFile, `${mail.id}\n`, { mode: 0o600 }); processed.add(mail.id); handled.push(mail.id);
          continue;
        }
        // Keep each poll short enough for the next two-minute delivery tick.
        if (promptHandled) continue;
        promptHandled = true;
        const resultFile = path.join(dir, 'fleet-agent-results', `${validId(mail.id)}.json`);
        let result = readJson(resultFile);
        if (!result) {
          if (mail.executionStartedAt) result = { exitCode: null, outputTail: '前回の実行が中断されました。二重実行防止のため自動再実行しません。' };
          else if (Date.parse(mail.expiresAt) <= now()) result = { exitCode: null, outputTail: '有効期限切れのため実行しません。' };
          else if (!loadOptin(path.join(dir, 'fleet-agent-optin.json')).includes('prompt')) result = { exitCode: null, outputTail: `未オプトイン。承諾コマンド: ${consentCommand('prompt')}` };
          else {
            writeJson(inboxFile(mail.id), { ...readJson(inboxFile(mail.id)), executionStartedAt: new Date(now()).toISOString() });
            const header = `これは ${mail.from} PC の Claude Code からのメッセージです。回答は標準出力に書けば自動で相手に返ります。ファイル変更や外部送信が要る内容は実行せず、必要な理由と手順を回答に書いてください。`;
            try {
              result = await runPrompt({ claudeExe: process.env.CLAUDE_CLI_PATH || 'claude', body: `${header}\n\n${mail.body}`,
                cwd: deps.repo ?? process.env.ORGIAST_REPO ?? ownRepo, timeoutSeconds: 90, readOnly: true, spawnImpl: deps.spawnImpl });
            } catch (e) { result = { exitCode: null, outputTail: `実行失敗: ${redactSecrets(e.message)}` }; }
          }
          result = { ...result, outputTail: redactSecrets(result.outputTail || result.error || '(出力なし)').slice(-8000) };
          if (result.error) result.error = redactSecrets(result.error);
          writeJson(resultFile, result);
        }
        await request('mail-reply', { id: mail.id, from: label, resultBody: result.outputTail });
        log('sent', { action: 'auto-reply', id: mail.id, exitCode: result.exitCode, timedOut: result.timedOut || false });
        try {
          const inboxMail = readJson(inboxFile(mail.id), null);
          if (inboxMail) writeJson(inboxFile(mail.id), { ...inboxMail, status: 'done', resultAt: new Date(now()).toISOString(), resultBody: result.outputTail });
        } catch (e) { err(`fleet-mail: inbox への返信記録に失敗（送信は成功）: ${e.message}`); }
      }
      fs.appendFileSync(processedFile, `${mail.id}\n`, { mode: 0o600 }); processed.add(mail.id); handled.push(mail.id);
    }
    out(json ? JSON.stringify({ received, processed: handled }) : `受信=${received.length} / 処理=${handled.length}`);
    return { received, handled };
  } finally { release(); }
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const dir = path.join(home, '.claude');
  const out = deps.stdout ?? (text => console.log(text));
  const err = deps.stderr ?? (text => console.error(text));
  const now = deps.now ?? Date.now;
  const inboxFile = id => path.join(dir, 'fleet-inbox', `${validId(id)}.json`);
  const log = (name, value) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `fleet-mail-${name}.jsonl`), `${JSON.stringify({ at: new Date(now()).toISOString(), ...value })}\n`, { mode: 0o600 });
  };
  if (options['--inbox']) {
    const mails = readInbox(home);
    out(options['--json'] ? JSON.stringify(mails) : mails.map(m => `${m.id} / from=${m.from} / ${m.kind} / ${m.why}\n${m.body}`).join('\n'));
    return 0;
  }
  if (options['--ack']) {
    const file = inboxFile(options['--ack']);
    const mail = readJson(file);
    if (!mail) throw new Error('inbox に該当メッセージがありません');
    writeJson(file, { ...mail, readAt: new Date(now()).toISOString() }); out(`既読: ${mail.id}`); return 0;
  }
  const config = envFile(path.join(dir, 'fleet-sheet.env'));
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) { err('fleet-mail: fleet-sheet.env 未設定のためスキップ'); return 0; }
  const identity = deps.identity ?? machineIdentity();
  const label = resolveFleetLabel(home, identity);
  const request = deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch });
  if (options['--sent-status']) {
    // 読み取りのみ: 返信が相手の受信タスクに拾われたか（deliveredAt）と返信済みか（resultAt）を確認する。
    const id = options['--sent-status'];
    const result = await request('mail-get', { id });
    const mail = result?.mail;
    if (!mail) { err(`fleet-mail: ${id} はサーバーに見つかりません`); return 4; }
    out([`id: ${mail.id}`, `status: ${mail.status || '(不明)'}`, `deliveredAt: ${mail.deliveredAt || '(未配達)'}`, `resultAt: ${mail.resultAt || '(未返信)'}`].join('\n'));
    return 0;
  }
  if (options['--send']) {
    let pcMap = deps.pcMap;
    if (pcMap === undefined) {
      try { pcMap = readJson(new URL('../fleet-pc-map.json', import.meta.url)); }
      catch { /* An unavailable or damaged roster must not prevent sending. */ }
    }
    const target = resolveRemoteName(options['--to'], pcMap);
    if (target.resolved) err(`${options['--to']} → ${target.to}`);
    const id = `mail-${new Date(now()).toISOString().replace(/[-:.TZ]/g, '')}-${(deps.randomInt ?? randomInt)(1000, 10000)}`;
    // --exec codex: 本文先頭にマーカー行を挿入して受信側に実行モードを伝える（本文ファイル自体は変更しない）。
    let body = redactSecrets(fs.readFileSync(options['--body-file'], 'utf8')).slice(0, 20000);
    if (options['--exec'] === 'codex') {
      const markers = ['<!-- fleet-exec: codex -->'];
      if (options['--exec-cwd'] !== undefined) markers.push(`<!-- fleet-exec-cwd: ${options['--exec-cwd']} -->`);
      body = `${markers.join('\n')}\n${body}`;
    }
    // --exec codex は相手PCの Codex が最長1800秒走るため、通常 prompt より長い既定期限(+6h)にする。
    const defaultExpiresHours = options['--exec'] === 'codex' ? 6 : 24;
    const payload = { id, from: label, to: target.to, messageKind: options['--kind'],
      body, why: redactSecrets(options['--why']),
      expiresAt: new Date(now() + Number(options['--expires-hours'] ?? defaultExpiresHours) * 3600000).toISOString() };
    // Record the id BEFORE transport; uncertain delivery can be inspected without resending a new id.
    log('sent', { action: 'send-attempt', ...payload, ...(options['--exec'] === 'codex' ? { exec: 'codex' } : {}) });
    await request('mail-send', payload); log('sent', { action: 'sent', id, to: payload.to, ...(options['--exec'] === 'codex' ? { exec: 'codex' } : {}) });
    if (options['--wait'] !== undefined) {
      err(`送信済み: ${id}`);
      const result = await waitForReply(id, Number(options['--wait']), { request, now, sleepImpl: deps.sleep });
      out(result.text); return result.exitCode;
    }
    out(`送信済み: ${id}`); return 0;
  }
  if (options['--reply']) {
    const id = options['--reply'];
    const body = redactSecrets(fs.readFileSync(options['--body-file'], 'utf8')).slice(0, 20000);
    if (!options['--force']) {
      const prior = findPriorReply(dir, id);
      if (prior !== null) {
        err(`fleet-mail: ${id} は ${prior.at ?? '日時不明'} に返信済み（${prior.action}）のため送信しません。意図的に再送するときだけ --force`);
        return 3;
      }
    }
    await request('mail-reply', { id, from: label, resultBody: body });
    log('sent', { action: 'reply', id, ...(options['--force'] ? { forced: true } : {}) });
    const file = inboxFile(id);
    // Record the reply locally too: a resumed session reads the inbox and must not answer the same id again.
    try {
      const mail = readJson(file, null);
      if (mail) {
        const nowISO = new Date(now()).toISOString();
        writeJson(file, { ...mail, status: 'done', resultAt: nowISO, resultBody: body, readAt: mail.readAt ?? nowISO });
      }
    } catch (e) { err(`fleet-mail: inbox への返信記録に失敗（送信は成功）: ${e.message}`); }
    out(`返信済み: ${id}`);
    out(`返信は相手の受信タスクが拾うまで届きません。届いたかは --sent-status ${id} で確認`);
    return 0;
  }
  await pollOnce({ ...deps, dryRun: !!options['--dry-run'], json: !!options['--json'] });
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`fleet-mail: ${redactSecrets(error.message)}`); process.exitCode = 1; }
}
