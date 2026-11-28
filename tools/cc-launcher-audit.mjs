#!/usr/bin/env node
/**
 * cc-launcher-audit.mjs
 * --root 配下の run-cc*.ps1 を走査し、opus 固定 ('--model' の直後が opus) を検出。
 * 固定が残っていれば exit 1、JSON で件数・ファイル一覧を出力。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

/**
 * @param {string} root 走査ルートディレクトリ
 * @returns {{ total: number, opusHardcoded: number, files: { file: string, model: string }[] }}
 */
export function auditRunCcScripts(root) {
  const result = { total: 0, opusHardcoded: 0, files: [] };
  if (!fs.existsSync(root)) return result;

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    try {
      const files = fs.readdirSync(dirPath);
      for (const fileName of files) {
        if (!/^run-cc.*\.ps1$/i.test(fileName)) continue;
        result.total++;
        const filePath = path.join(dirPath, fileName);
        const content = fs.readFileSync(filePath, 'utf8');
        // '--model','opus' または '--model','opus-*' パターンを検出
        const match = content.match(/'--model'\s*,\s*'(opus(?:-\w+)?)'/i);
        if (match) {
          result.opusHardcoded++;
          result.files.push({ file: filePath, model: match[1] });
        }
      }
    } catch {
      // アクセス権限不足などはスキップ
    }
  }

  return result;
}

export function main(argv = process.argv.slice(2)) {
  let root = path.join(os.homedir(), 'gb-reports');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
  }

  const result = auditRunCcScripts(root);
  const output = JSON.stringify(result, null, 2);
  console.log(output);

  if (result.opusHardcoded > 0) {
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) {
  main();
}