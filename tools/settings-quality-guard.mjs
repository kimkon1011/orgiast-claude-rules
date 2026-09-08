#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const ALLOWED_EFFORT_LEVELS = new Set(['high', 'xhigh', 'max']);
const REASON = 'kim 2026-09-09 厳命: 節約のために effortLevel/thinking/監督モデルを下げない。節約は委譲・レスポンス数削減で行う。意図的に変える場合は ORGIAST_ALLOW_EFFORT_DOWNGRADE=1 を付けて再実行';

export function isDowngradeValue(value) {
  return !ALLOWED_EFFORT_LEVELS.has(String(value ?? '').toLowerCase());
}

function comparablePath(value) {
  return path.resolve(String(value || '').replace(/[\\/]+/g, path.sep)).toLowerCase();
}

function writtenTexts(toolInput) {
  const texts = [toolInput?.new_string, toolInput?.content];
  if (Array.isArray(toolInput?.edits)) texts.push(...toolInput.edits.map((edit) => edit?.new_string));
  return texts.filter((value) => typeof value === 'string');
}

export function detectEffortDowngrade(toolName, toolInput, settingsPath) {
  const name = String(toolName || '').toLowerCase();
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (['edit', 'write', 'multiedit'].includes(name)
    && comparablePath(input.file_path) === comparablePath(settingsPath)) {
    for (const text of writtenTexts(input)) {
      for (const match of text.matchAll(/"effortLevel"\s*:\s*"(\w+)"/gi)) {
        if (isDowngradeValue(match[1])) return { blocked: true, reason: REASON };
      }
    }
  }
  if (['bash', 'powershell'].includes(name)) {
    const command = String(input.command || '');
    const identifiesSettings = /settings\.json/i.test(command)
      || /(?:sed\b|node\s+-e\b|Set-Content|>)/i.test(command);
    if (/effortLevel/i.test(command) && identifiesSettings && /["'](?:low|medium)["']/i.test(command)) {
      return { blocked: true, reason: REASON };
    }
  }
  return { blocked: false };
}

export function restoreEffortLevel(settingsPath, { now = Date.now(), backupDir } = {}) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return { changed: false }; }
  if (!isDowngradeValue(settings.effortLevel)) return { changed: false };
  const from = settings.effortLevel == null ? '未設定' : String(settings.effortLevel);
  const destinationDir = backupDir || path.join(path.dirname(settingsPath), 'backups');
  const instant = typeof now === 'function' ? now() : now;
  const timestamp = new Date(instant).toISOString().replace(/[:.]/g, '-');
  try {
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.copyFileSync(settingsPath, path.join(destinationDir, `settings.json.bak-${timestamp}`));
    settings.effortLevel = 'high';
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch { return { changed: false }; }
  return { changed: true, from };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (isEntry(import.meta.url)) {
  const homeDir = process.env.ORGIAST_HOME || os.homedir();
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'pretooluse';
  if (mode === 'sessionstart') {
    const result = restoreEffortLevel(settingsPath, {});
    if (result.changed) console.log(`⚠️ effortLevel が ${result.from} だったため high へ自動復元しました（性能を下げる節約は禁止）`);
  } else if (process.env.ORGIAST_ALLOW_EFFORT_DOWNGRADE !== '1') {
    try {
      const input = JSON.parse(await readStdin());
      const result = detectEffortDowngrade(input.tool_name, input.tool_input, settingsPath);
      if (result.blocked) {
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
      }
    } catch { /* 壊れた hook 入力で Claude Code 自体を止めない */ }
  }
}
