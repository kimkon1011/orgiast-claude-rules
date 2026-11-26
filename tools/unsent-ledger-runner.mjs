#!/usr/bin/env node
/**
 * 送信待ち台帳ランナー。
 * 台帳処理を先に実行し、discord-appointment-capture の失敗は致命にしない。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { patchSummary } from './unsent-ledger.mjs';

const tools = path.dirname(fileURLToPath(import.meta.url));

export function runnerArgs(argv = process.argv.slice(2)) {
  return [...argv.filter(arg => !['--send', '--auto-send', '--dry-run'].includes(arg)), '--dry-run'];
}

export function runNode(script, { fatal = true, spawn = spawnSync } = {}) {
  // 定期処理は台帳の取込・照合を継続する。送信は従来どおりdry-run固定。
  const refreshArgs = script === 'unsent-ledger.mjs' ? ['--refresh'] : [];
  const result = spawn(process.execPath, [path.join(tools, script), ...runnerArgs(), ...refreshArgs], {
    stdio: 'inherit',
    // 補助取込が外側のタスク制限に達する前に戻り、ALERTへ記録できる余裕を残す。
    timeout: fatal ? 10 * 60 * 1000 : 60 * 1000,
    windowsHide: true,
  });
  if (result.error) {
    if (fatal) throw result.error;
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    if (fatal) throw new Error(`${script}: exit ${result.status ?? 1}`);
    return { ok: false, error: `exit ${result.status}` };
  }
  return { ok: true };
}

function appendCaptureError(message) {
  const exportDir = process.env.UNSENT_LEDGER_EXPORT_DIR
    || path.join(os.homedir(), 'gb-reports', 'unsent-ledger');
  try {
    fs.mkdirSync(exportDir, { recursive: true });
    const alertPath = path.join(exportDir, 'ALERT.md');
    const stamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const line = `\n## 【照合エラー】discord-appointment-capture\n- 時刻: ${stamp}\n- 理由: ${message}\n`;
    if (fs.existsSync(alertPath)) {
      const previous = fs.readFileSync(alertPath, 'utf8');
      fs.writeFileSync(alertPath, previous.replace('## 【未送信】', `${line}\n## 【未送信】`));
    }
    else fs.writeFileSync(alertPath, `# 未送信アラート\n生成: ${stamp}\n件数: 0件\n${line}`);
    const jsonPath = path.join(exportDir, 'alerts.json');
    const alerts = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      : { counts: { total: 0, priority: 0, stopped: 0, checkErrors: 0, unsent: 0 }, items: [] };
    alerts.items.push({ id: 'job-discord-capture', alert_bucket: '照合エラー', last_check_error: message });
    alerts.counts.checkErrors++;
    alerts.counts.total++;
    alerts.generated_at = new Date().toISOString();
    fs.writeFileSync(jsonPath, JSON.stringify(alerts, null, 2));
    fs.writeFileSync(alertPath, fs.readFileSync(alertPath, 'utf8').replace(/^件数:.*$/m,
      `件数: ${alerts.counts.total}件（最優先 ${alerts.counts.priority} / 止まった ${alerts.counts.stopped} / 照合エラー ${alerts.counts.checkErrors} / 未送信 ${alerts.counts.unsent}）`));
    patchSummary(alerts);
  } catch {
    const status = path.join(os.homedir(), 'gb-reports', 'session-status', 'STATUS-000.md');
    fs.mkdirSync(path.dirname(status), { recursive: true });
    fs.appendFileSync(status, `\n照合ジョブ失敗: ${message}\n`);
  }
}

export function main({ run = runNode, recordCaptureError = appendCaptureError } = {}) {
  const ledger = run('unsent-ledger.mjs', { fatal: true });
  if (!ledger.ok) process.exit(1);
  const capture = run('discord-appointment-capture.mjs', { fatal: false });
  if (!capture.ok) recordCaptureError(capture.error || 'failed');
}

if (isEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
