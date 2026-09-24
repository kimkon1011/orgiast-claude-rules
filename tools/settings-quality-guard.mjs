#!/usr/bin/env node
// 一時許可: CLAUDE_MODEL_GUARD_ALLOW=1 で SessionStart の model 正規化だけを停止する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';


const REASON = 'kim 2026-09-17 改定: 既定 medium。low 禁止。監督モデルと実装先（Codex）を節約目的で下げない';

export function isDowngradeValue(value) {
  return String(value ?? '').toLowerCase() === 'low';
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
    const assignments = [...command.replace(/\\(["'])/g, '$1').matchAll(/effortLevel["']?\]?\s*[:=]\s*["'](\w+)["']/gi)];
    // sedの検索側にある旧lowを拒否しない。置換・代入先の最後の値を判定する。
    if (identifiesSettings && assignments.length && isDowngradeValue(assignments.at(-1)[1])) {
      return { blocked: true, reason: REASON };
    }
  }
  return { blocked: false };
}

export function normalizeSessionSettings(settingsPath, { env = process.env } = {}) {
  if (env.CLAUDE_MODEL_GUARD_ALLOW === '1') return { changed: false };
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return { changed: false }; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { changed: false };
  const model = settings.model;
  if (model != null && model !== '' && !/fable/i.test(String(model)) && !/\[1m\]/.test(String(model))) return { changed: false };
  const from = model == null || model === '' ? '未設定' : String(model);
  settings.model = 'opus';
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { changed: true, from };
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
    settings.effortLevel = 'medium';
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch { return { changed: false }; }
  return { changed: true, from };
}

if (isEntry(import.meta.url)) {
  const homeDir = process.env.ORGIAST_HOME || os.homedir();
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'pretooluse';
  if (mode === 'sessionstart') {
    const modelResult = normalizeSessionSettings(settingsPath);
    if (modelResult.changed) console.log(`[settings-guard] model: ${modelResult.from} → opus`);
    const result = restoreEffortLevel(settingsPath, {});
    if (result.changed) console.log(`⚠️ effortLevel が ${result.from} だったため medium へ自動復元しました（kim 2026-09-17 改定: 既定 medium。low 禁止）`);
  } else if (process.env.ORGIAST_ALLOW_EFFORT_DOWNGRADE !== '1') {
    try {
      const input = JSON.parse(await readStdinWithTimeout());
      const result = detectEffortDowngrade(input.tool_name, input.tool_input, settingsPath);
      if (result.blocked) {
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
      }
    } catch { /* 壊れた hook 入力で Claude Code 自体を止めない */ }
  }
}
