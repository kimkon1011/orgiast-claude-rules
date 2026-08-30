#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findWebhook, localDate, notify as discordNotify } from './auto-session.mjs';
import { isEntry } from './is-entry.mjs';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const CAUSE_LABELS = {
  killswitch: '停止スイッチが有効',
  'task-missing': 'スケジュールタスク未登録',
  'task-args-drift': 'スケジュールタスク引数ずれ',
  'task-did-not-fire': 'スケジュールタスク未発火',
  locked: '実行ロック中',
  'launcher-failed': 'ランチャー失敗',
  unknown: '原因不明',
  'manifest-missing': 'マニフェスト欠落（実行記録はある）',
};

export function redact(value) {
  return String(value ?? '')
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[REDACTED_WEBHOOK]');
}

function defaultQueryTask() {
  const result = spawnSync('schtasks.exe', ['/Query', '/TN', 'OrgiastAutoSession', '/V', '/FO', 'CSV', '/NH'], { timeout: 15_000, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  // schtasks の出力は日本語 Windows では cp932。utf8 として読むと State が化けたまま Discord に載る(実測)。
  try { result.stdout = new TextDecoder('shift_jis').decode(result.stdout); } catch { result.stdout = Buffer.from(result.stdout).toString('utf8'); }
  // /NH の CSV は表示言語に依存するヘッダーを持たず、列順が固定なので日本語 Windows でも読める。
  const row = [];
  const line = String(result.stdout).split(/\r?\n/).find(Boolean) ?? '';
  for (let i = 0, value = ''; i <= line.length; i += 1) {
    if (line[i] === '"') {
      if (line[i + 1] === '"') { value += '"'; i += 1; }
      else {
        i += 1;
        while (i < line.length && line[i] !== '"') value += line[i++];
      }
    } else if (line[i] === ',' || i === line.length) { row.push(value); value = ''; }
    else value += line[i];
  }
  return { command: row[8] || '', lastRunTime: row[5] || '', lastTaskResult: row[6] || '', state: row[3] || '' };
}

function defaultRegister(repo) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tools', 'register-auto-session.ps1')], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return { ok: !result.error && result.status === 0, code: result.status, output: redact(result.stdout || result.stderr || result.error?.message || '') };
}

function parseJson(read, file) {
  try { return JSON.parse(read(file, 'utf8')); } catch { return null; }
}

function conclusion(day, verdict, actual, expected, counts, deadline) {
  if (verdict === 'ok') return `✅ 自動セッション ${day} ${actual}/${expected} 完走（成功${counts.success} / timeout${counts.timeout} / 失敗${counts.failure}）`;
  if (verdict === 'partial') return `⚠️ 自動セッション ${day} ${actual}/${expected} で打ち切り｜${deadline || `未消化${Math.max(0, expected - actual)}件`}`;
  return '';
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const dry = argv.includes('--dry');
  const now = io.now ? new Date(io.now()) : new Date();
  const home = io.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const repo = io.repo ?? path.resolve(import.meta.dirname, '..');
  const autoDir = path.join(home, '.claude', 'auto-session');
  const runsDir = path.join(autoDir, 'runs');
  const verifyDir = path.join(autoDir, 'verify');
  const day = localDate(now);
  const list = io.list ?? ((dir) => fs.readdirSync(dir));
  const exists = io.exists ?? fs.existsSync;
  const read = io.readFile ?? fs.readFileSync;
  const write = io.writeFile ?? fs.writeFileSync;
  const mkdir = io.mkdir ?? fs.mkdirSync;
  const unlink = io.unlink ?? fs.unlinkSync;
  const stat = io.stat ?? fs.statSync;
  const pidAlive = io.pidAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const queryTask = io.queryTask ?? defaultQueryTask;
  const register = io.register ?? (() => defaultRegister(repo));
  const send = io.notify ?? discordNotify;
  const log = io.log ?? console.log;
  let names = [];
  try { names = list(runsDir); } catch {}
  const manifests = names.filter((name) => new RegExp(`^${day}-manifest(?:-\\d+)?\\.json$`).test(name)).sort();
  let verdict = 'none';
  let cause = '';
  let repair = '';
  let evidence = [];
  let actual = 0;
  let expected = 0;
  let counts = { success: 0, timeout: 0, failure: 0 };
  let headline = '';
  const details = [];

  const dayRunNames = names.filter((name) => new RegExp(`^${day}-(?:\\d+|feedback-.+)\\.json$`).test(name));

  if (!manifests.length && dayRunNames.length) {
    // マニフェストの書き込みは try/catch で握られており、失敗しても夜間実行は続く。
    // ここで「1件も起動していません」と報告すると嘘になり、無用な再登録まで走る。
    const records = dayRunNames.map((name) => parseJson(read, path.join(runsDir, name))).filter(Boolean);
    actual = records.length;
    for (const record of records) if (record.status in counts) counts[record.status] += 1;
    verdict = 'partial';
    cause = 'manifest-missing';
    headline = `⚠️ 自動セッション ${day} 実行記録${actual}件あり・予定件数が不明（マニフェスト無し）｜成功${counts.success} / timeout${counts.timeout} / 失敗${counts.failure}`;
    evidence.push('マニフェストが無いため完走したかは判定できない。旧仕様の実行か、マニフェスト書き込みに失敗した可能性がある。');
  } else if (!manifests.length) {
    const disabled = path.join(autoDir, 'disabled');
    const lockFile = path.join(autoDir, '.lock');
    const task = exists(disabled) ? null : await queryTask();
    if (exists(disabled)) cause = 'killswitch';
    else if (!task) {
      cause = 'task-missing';
      if (!dry) {
        const result = await register();
        repair = `OrgiastAutoSession を再登録（${result?.ok ? '成功' : `失敗 code=${result?.code ?? '?'}`}）`;
      }
    } else if (!String(task.command ?? task.arguments ?? '').includes('--count all')) {
      cause = 'task-args-drift';
      if (!dry) {
        const result = await register();
        repair = `OrgiastAutoSession の引数を再登録（${result?.ok ? '成功' : `失敗 code=${result?.code ?? '?'}`}）`;
      }
    } else {
      const cutoff = new Date(now); cutoff.setHours(0, 30, 0, 0);
      const lastRun = Date.parse(task.lastRunTime);
      if (!Number.isFinite(lastRun) || lastRun < cutoff.getTime()) {
        cause = 'task-did-not-fire';
        evidence.push(`LastRunTime=${task.lastRunTime || '(不明)'} / LastTaskResult=${task.lastTaskResult ?? '(不明)'} / State=${task.state || '(不明)'}`);
      } else if (exists(lockFile)) {
        const lock = parseJson(read, lockFile) ?? {};
        let age = Infinity;
        try { age = now.getTime() - stat(lockFile).mtimeMs; } catch {}
        if (pidAlive(lock.pid)) {
          cause = 'locked';
          evidence.push(`pid=${lock.pid ?? '(不明)'} / 経過=${Math.round(age / 60_000)}分`);
        } else if (age > SIX_HOURS && !dry) {
          try { unlink(lockFile); repair = `停止済み pid=${lock.pid ?? '(不明)'} の6時間超ロックを削除`; } catch {}
        }
      }
      if (!cause) {
        let launcher = '';
        try { launcher = read(path.join(autoDir, 'launcher.log'), 'utf8'); } catch {}
        const dayLines = String(launcher).split(/\r?\n/).filter((line) => line.includes(day));
        const failed = dayLines.filter((line) => /\babort\b|\bexit\s+(?!0\b)\d+/.test(line));
        if (failed.length) { cause = 'launcher-failed'; evidence.push(...failed.slice(-5)); }
        else { cause = 'unknown'; evidence.push(...String(launcher).split(/\r?\n/).filter(Boolean).slice(-20)); }
      }
    }
    headline = `🚨 自動セッション ${day} 1件も起動していません｜主因: ${CAUSE_LABELS[cause]}`;
  } else {
    const manifest = parseJson(read, path.join(runsDir, manifests.at(-1))) ?? {};
    expected = Number(manifest.selectedCount || 0) + Number(manifest.feedbackCount || 0);
    const records = dayRunNames.map((name) => parseJson(read, path.join(runsDir, name))).filter(Boolean);
    actual = records.length;
    for (const record of records) {
      if (record.status in counts) counts[record.status] += 1;
      if (['failure', 'timeout'].includes(record.status)) {
        const todo = String(record.todo ?? record.issue?.title ?? '(内容不明)').slice(0, 60);
        const summary = redact(record.summary ?? '').slice(-200).replace(/\r?\n/g, ' ');
        const stderr = redact(record.stderr ?? '').slice(-200).replace(/\r?\n/g, ' ');
        details.push(`- ${record.status}: ${todo}${summary ? `｜summary: ${summary}` : ''}${stderr ? `｜stderr: ${stderr}` : ''}${record.resumeCommand ? `｜${record.resumeCommand}` : ''}`);
      }
    }
    const deadlines = names.filter((name) => new RegExp(`^${day}-deadline-.+\\.json$`).test(name)).map((name) => parseJson(read, path.join(runsDir, name))).filter(Boolean);
    const unconsumed = deadlines.reduce((sum, item) => sum + Number(item.unconsumed || 0), 0);
    const deadlineText = deadlines.length ? `未消化${unconsumed || Math.max(0, expected - actual)}件（deadline ${deadlines.at(-1).deadline || manifest.options?.deadline || ''} 到達）` : '';
    verdict = actual === expected && counts.failure === 0 && counts.timeout === 0 ? 'ok' : actual === 0 ? 'none' : 'partial';
    headline = conclusion(day, verdict, actual, expected, counts, deadlineText);
    if (!headline) headline = `🚨 自動セッション ${day} 1件も起動していません｜主因: バッチ内で子を起動できず`;
  }

  const lines = [headline, ...evidence.map((line) => `証拠: ${redact(line)}`)];
  if (repair) lines.push(`🔧 自動修復: ${repair}`);
  lines.push(...details);
  if (repair) lines.push('修復内容は次回 00:30 の定期実行で自動的に再挑戦されます。');
  const notice = lines.join('\n').slice(0, 1900);
  const result = { day, verdict, cause, expected, actual, counts, repair, notice, dry };
  if (dry) { log(notice); return result; }
  mkdir(verifyDir, { recursive: true });
  write(path.join(verifyDir, `${day}.json`), JSON.stringify(result, null, 2));
  const lastFile = path.join(verifyDir, 'last-notice.txt');
  let previous = '';
  try { previous = read(lastFile, 'utf8'); } catch {}
  if (!(verdict === 'ok' && previous.split(/\r?\n/, 1)[0] === headline)) await send(findWebhook(path.join(home, '.claude')), notice);
  else log(`auto-session-verify: 正常通知は前回と同一のためスキップ: ${headline}`);
  write(lastFile, notice);
  return result;
}

if (isEntry(import.meta.url)) {
  try { await main(); process.exitCode = 0; }
  catch (error) {
    console.error(`auto-session-verify: ${error?.stack ?? error}`);
    try { await discordNotify(findWebhook(path.join(process.env.ORGIAST_HOME ?? os.homedir(), '.claude')), `🚨 verify 自身が失敗: ${redact(error?.message ?? error)}`); } catch {}
    process.exitCode = 1;
  }
}
