#!/usr/bin/env node
// 放置された Claude Code セッションを、transcript に触れず台帳と引き継ぎでクローズする。
import { promises as fs } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from './redact-secrets.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);

function usage(message) {
  if (message) console.error(`エラー: ${message}`);
  console.error('使い方: node tools/session-auto-close.mjs [--days N] [--max N] [--dry] [--force] [--provider name] [--no-llm] [--redact-existing]');
  process.exit(message ? 2 : 0);
}

function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) usage(`${name} に値が必要です`);
  return args[i + 1];
}

if (args.includes('--help') || args.includes('-h')) usage();
const days = Number(option('--days') ?? 7);
const max = Number(option('--max') ?? 40);
const provider = option('--provider');
const dry = args.includes('--dry');
const force = args.includes('--force');
const noLlm = args.includes('--no-llm');
const redactExisting = args.includes('--redact-existing');
if (!Number.isFinite(days) || days < 0) usage('--days は0以上の数値にしてください');
if (!Number.isInteger(max) || max < 0) usage('--max は0以上の整数にしてください');

const claudeDir = path.join(os.homedir(), '.claude');
const ledgerPath = path.join(claudeDir, 'session-closed-ledger.json');
const ledgerBackupPath = `${ledgerPath}.bak`;
const handoffsPath = path.join(claudeDir, 'session-handoffs.md');
const triagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-triage.mjs');

async function loadLedger() {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) throw new Error('台帳形式が不正です');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sessions: {} };
    console.error(`⚠️ 台帳が壊れているため${dry ? '、dry-run では退避せず新規台帳として扱います' : ` ${ledgerBackupPath} に退避します`}`);
    if (!dry) await fs.copyFile(ledgerPath, ledgerBackupPath);
    return { version: 1, sessions: {} };
  }
}

function cleanOneLine(value, fallback) {
  return redactSecrets(String(value || fallback)).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function markerFor(id) { return `<!-- SESSION:${id} -->`; }

function handoffBlock(record, nextAction) {
  const title = cleanOneLine(record.displayTitle, '(タイトルなし)').replace(/^#+\s*/, '');
  return `${markerFor(record.sessionId)}\n## ${title}（${Math.floor(record.ageDays)}日放置）\n- 次の1手: ${cleanOneLine(nextAction, 'セッションを再開して残作業を確認する')}\n- 再開コマンド: \`claude --resume ${record.sessionId}\`\n- cwd: \`${cleanOneLine(record.cwd, '(不明)').replace(/`/g, '\\`')}\`\n`;
}

async function atomicWrite(target, content) {
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, target);
}

function redactObject(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
  return value;
}

async function redactExistingFiles() {
  const stamp = new Date().toISOString().slice(0, 10);
  const targets = [path.join(claudeDir, 'session-triage.md'), handoffsPath, ledgerPath];
  let changed = 0;
  for (const target of targets) {
    let original;
    try { original = await fs.readFile(target, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const redacted = redactSecrets(original);
    if (redacted === original) continue;
    const backup = `${target}.bak-${stamp}-secret-redact`;
    try { await fs.copyFile(target, backup, fsConstants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await atomicWrite(target, redacted);
    console.log(redactSecrets(`秘匿値をマスク: ${target} (backup: ${backup})`));
    changed++;
  }
  console.log(`既存ファイルの秘匿値掃除: ${changed}件更新`);
}

try {
  if (redactExisting) {
    await redactExistingFiles();
  } else {
  const ledger = redactObject(await loadLedger());
  const triageArgs = [triagePath, '--all', '--older-than', String(days), '--json', '--include-completed', '--top', String(max)];
  if (force) triageArgs.push('--include-closed');
  if (!noLlm) triageArgs.push('--llm');
  if (provider) triageArgs.push('--provider', provider);
  const { stdout, stderr } = await execFileAsync(process.execPath, triageArgs, { maxBuffer: 16 * 1024 * 1024, timeout: Math.max(30_000, max * 35_000) });
  if (stderr.trim()) process.stderr.write(redactSecrets(stderr));
  const result = redactObject(JSON.parse(redactSecrets(stdout)));
  const totalEligible = Object.values(result.summary?.counts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
  const candidates = result.sessions.filter((record) => force || !ledger.sessions[record.sessionId]);
  const alreadyClosedInBatch = result.sessions.length - candidates.length;
  const deferred = Math.max(0, totalEligible - result.sessions.length);
  const closedAt = new Date().toISOString();
  const handoffIds = new Set();
  let handoffs = '';
  try {
    handoffs = await fs.readFile(handoffsPath, 'utf8');
    for (const line of handoffs.split(/\r?\n/)) {
      const match = line.match(/^<!-- SESSION:([0-9a-f-]{36}) -->$/i);
      if (match) handoffIds.add(match[1]);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  let completed = 0;
  let handedOff = 0;
  let llmFailures = 0;
  const additions = [];
  for (const record of candidates) {
    const llmFailed = !noLlm && (!record.llm || record.llm.verdict === '失敗' || record.llm.verdict === '不明' || record.llm.confidence < 60);
    if (llmFailed) { llmFailures++; console.log(`⚠️ 未記帳 ${record.sessionId}: LLM判定失敗`); continue; }
    let reason;
    if (noLlm) reason = record.status === '完了っぽい' && record.ageDays >= 30 ? 'completed' : 'handoff';
    else reason = record.llm.verdict === '完了' ? 'completed' : 'handoff';
    const nextAction = reason === 'handoff' ? cleanOneLine(record.nextAction, 'セッションを再開して残作業を確認する') : '';
    ledger.sessions[record.sessionId] = {
      closedAt, reason, status: record.status, title: redactSecrets(record.displayTitle), cwd: redactSecrets(record.cwd),
      file: redactSecrets(record.file), lastActivity: record.mtime, idleDays: record.ageDays,
      ...(reason === 'handoff' && { nextAction }), resumeCommand: `claude --resume ${record.sessionId}`,
    };
    if (reason === 'handoff') {
      handedOff++;
      if (!handoffIds.has(record.sessionId)) additions.push(handoffBlock(record, nextAction));
    } else completed++;
    console.log(`${dry ? '[dry] ' : ''}${reason === 'completed' ? '完了' : '引き継ぎ'} ${record.sessionId} ${cleanOneLine(record.displayTitle, '(タイトルなし)')}`);
  }

  if (!dry && completed + handedOff > 0) {
    await fs.mkdir(claudeDir, { recursive: true });
    if (additions.length) {
      const separator = handoffs && !handoffs.endsWith('\n') ? '\n\n' : handoffs ? '\n' : '';
      await fs.appendFile(handoffsPath, redactSecrets(`${separator}${additions.join('\n')}`), 'utf8');
    }
    await atomicWrite(ledgerPath, redactSecrets(`${JSON.stringify(redactObject(ledger), null, 2)}\n`));
  }
  if (llmFailures) {
    const warning = `⚠️ LLM判定失敗 ${llmFailures}件 — クローズせず次回に回した`;
    console.error(warning);
    console.log(warning);
  }
  if (deferred) console.log(`上限 --max ${max} に達したため、残り${deferred}件は次回`);
  console.log(`${dry ? 'dry-run: ' : ''}完了 ${completed}件 / 引き継ぎ ${handedOff}件 / LLM判定失敗 ${llmFailures}件 / 既クローズ ${alreadyClosedInBatch}件`);
  if (!noLlm && candidates.length > 0 && llmFailures === candidates.length) process.exitCode = 1;
  }
} catch (error) {
  console.error(redactSecrets(`session-auto-close: ${error.message}`));
  process.exitCode = 1;
}
