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

const tools = path.dirname(fileURLToPath(import.meta.url));

function runNode(script, { fatal = true } = {}) {
  const result = spawnSync(process.execPath, [path.join(tools, script), ...process.argv.slice(2)], {
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
    windowsHide: true,
  });
  if (result.error) {
    if (fatal) throw result.error;
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    if (fatal) process.exit(result.status ?? 1);
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
    if (fs.existsSync(alertPath)) fs.appendFileSync(alertPath, line);
    else fs.writeFileSync(alertPath, `# 未送信アラート\n生成: ${stamp}\n件数: 0件\n${line}`);
  } catch {
    // ignore
  }
}

export function main() {
  const ledger = runNode('unsent-ledger.mjs', { fatal: true });
  if (!ledger.ok) process.exit(1);
  const capture = runNode('discord-appointment-capture.mjs', { fatal: false });
  if (!capture.ok) appendCaptureError(capture.error || 'failed');
}

if (isEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
