#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { addItem } from './kim-inbox.mjs';
import { isEntry } from './is-entry.mjs';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export function getRuleFiles() {
  const files = [];

  function collect(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  }

  for (const relative of ['ONBOARDING.md', 'CLAUDE.md.template']) {
    const full = path.join(rootDir, relative);
    if (fs.existsSync(full)) files.push(full);
  }

  for (const folder of ['rules', 'rules-extracted', 'protocols']) {
    collect(path.join(rootDir, folder));
  }

  const skillsDir = path.join(rootDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) files.push(skillMd);
      }
    }
  }

  return files;
}

export async function runAudit(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const orgPath = path.join(rootDir, 'docs', 'org-instructions.md');
  const missionPath = path.join(rootDir, 'docs', 'mission.md');

  if (!fs.existsSync(orgPath) || !fs.existsSync(missionPath)) {
    return { status: 'skipped', reason: 'docs/org-instructions.md or docs/mission.md missing' };
  }

  const orgContent = fs.readFileSync(orgPath, 'utf8');
  const missionContent = fs.readFileSync(missionPath, 'utf8');

  const ruleFiles = getRuleFiles();
  const fileContentsMap = new Map();
  let combinedRulesText = '';

  for (const file of ruleFiles) {
    const rel = path.relative(rootDir, file);
    const text = fs.readFileSync(file, 'utf8');
    fileContentsMap.set(rel, text);
    combinedRulesText += `\n--- FILE: ${rel} ---\n${text}\n`;
  }

  const systemPrompt = `あなたはルールの一貫性を検証する監査員です。
組織指示（org-instructions.md）と基本理念（mission.md）が正本です。
以下のルールファイル一式を正本と比較し、明確に矛盾しているか古い方針（Discord DM指示、Claude API新規利用など）を抽出してください。

出力フォーマットは以下の JSON 配列のみで出力してください（Markdownの装飾なし）:
[
  {
    "file": "ファイル相対パス",
    "quote": "ルールファイル内に実在する一字一句正確な引用文字列",
    "reason": "組織指示または基本理念とどのように矛盾しているかの説明"
  }
]
矛盾や古い方針がなければ空配列 [] を返してください。`;

  const userPrompt = `【正本1: 組織指示】\n${orgContent}\n\n【正本2: 基本理念】\n${missionContent}\n\n【配布ルール一式】\n${combinedRulesText.slice(0, 100000)}`;

  const tempPromptFile = path.join(os.tmpdir(), `rule-audit-${Date.now()}.txt`);
  fs.writeFileSync(tempPromptFile, `${systemPrompt}\n\n${userPrompt}`, 'utf8');

  let rawOutput = '';
  try {
    const llmAskScript = path.join(__dirname, 'llm-ask.mjs');
    const { stdout } = await exec(
      process.execPath,
      [llmAskScript, '--provider', 'gemini', '--category', 'classification', '--prompt-file', tempPromptFile],
      { timeout: 120000, windowsHide: true, env: { ...process.env, ORGIAST_HOME: home } }
    );
    rawOutput = stdout.trim();
  } catch (err) {
    fs.rmSync(tempPromptFile, { force: true });
    return { status: 'error', error: err.message };
  } finally {
    fs.rmSync(tempPromptFile, { force: true });
  }

  let candidates = [];
  try {
    const jsonMatch = rawOutput.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      candidates = JSON.parse(jsonMatch[0]);
    }
  } catch {
    candidates = [];
  }

  const verifiedViolations = [];
  for (const candidate of candidates) {
    if (!candidate.quote || typeof candidate.quote !== 'string') continue;
    const trimmedQuote = candidate.quote.trim();
    if (!trimmedQuote) continue;

    let foundInFile = false;
    for (const [fileRel, content] of fileContentsMap.entries()) {
      if (content.includes(trimmedQuote)) {
        foundInFile = true;
        verifiedViolations.push({
          file: candidate.file || fileRel,
          quote: trimmedQuote,
          reason: candidate.reason || '正本との食い違い'
        });
        break;
      }
    }
  }

  if (verifiedViolations.length > 0) {
    const lines = verifiedViolations.map(
      (v) => `- [${v.file}] 「${v.quote.slice(0, 50)}${v.quote.length > 50 ? '…' : ''}」: ${v.reason}`
    );
    const detail = `【配布ルールの週次監査結果】\n正本（組織指示・基本理念）と食い違う記述が ${verifiedViolations.length} 件確認されました:\n${lines.join('\n')}`;

    if (!options.dryRun) {
      addItem(home, {
        kind: 'info',
        text: detail,
        source: 'rule-consistency-audit',
        dedupeKey: 'rule-consistency-audit-weekly',
        replaceExisting: true
      });
    }
    return { status: 'found', count: verifiedViolations.length, violations: verifiedViolations };
  }

  return { status: 'clean', count: 0 };
}

if (isEntry(import.meta.url)) {
  const isDryRun = process.argv.includes('--dry-run');
  runAudit({ dryRun: isDryRun })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
