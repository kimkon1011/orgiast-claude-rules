#!/usr/bin/env node
/**
 * error-to-rule.mjs — コーディングエラーをLintルールに変換して登録・検証
 *
 * AIニュース提案 [X-0073]: ミスをLintルール化する再現可能コーディング。
 * エラーが発生したらルール化して再発を防ぎ、生成コードの品質を自動検証する。
 *
 * 使い方:
 *   node tools/error-to-rule.mjs --capture --title "<ルール名>" --file "<対象ファイル>" --pattern "<検出パターン>"
 *   node tools/error-to-rule.mjs --validate             # ルール一覧の整合性チェック
 *   node tools/error-to-rule.mjs --search <RULE_ID>     # 特定ルールの違反を探す
 *   node tools/error-to-rule.mjs --capture --interactive # 対話的にルール登録
 *   node tools/error-to-rule.mjs --list                  # 全ルール一覧
 *   node tools/error-to-rule.mjs --export-json           # JSON形式で出力
 *
 * オプション:
 *   --cwd <path>   作業ディレクトリ（既定: リポジトリルート）
 *   --dry-run      実際の登録を行わず結果表示のみ
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RULES_FILE = 'rules/error-lint-rules.md';
const RULE_ID_RE = /^R\d{3}$/;

// ─── 型定義 ────────────────────────────────────────────────

/** @typedef {{ id: string, title: string, trigger: string, fix: string, test: string, firstSeen: string, reference: string }} LintRule */

// ─── CLI引数解析 ────────────────────────────────────────────

function parseArgs(argv) {
  const args = { cwd: REPO_ROOT };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--capture': args.capture = true; break;
      case '--validate': args.validate = true; break;
      case '--list': args.list = true; break;
      case '--export-json': args.exportJson = true; break;
      case '--interactive': args.interactive = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--search': args.search = argv[++i]; break;
      case '--title': args.title = argv[++i]; break;
      case '--file': args.file = argv[++i]; break;
      case '--pattern': args.pattern = argv[++i]; break;
      case '--trigger': args.trigger = argv[++i]; break;
      case '--fix': args.fix = argv[++i]; break;
      case '--cwd': args.cwd = path.resolve(argv[++i]); break;
      default: break;
    }
  }
  return args;
}

// ─── ルール読み取り ────────────────────────────────────────

function readRulesFile(cwd) {
  const filePath = path.join(cwd, RULES_FILE);
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  // ルールセクション（### R001: ...）を抽出
  const ruleBlocks = [];
  const ruleRe = /^###\s+(R\d{3}):\s+(.+)$/gm;
  let match;
  while ((match = ruleRe.exec(raw)) !== null) {
    const id = match[1];
    const title = match[2];
    const blockStart = match.index;
    // 次の ### またはファイル末尾まで
    const nextMatch = ruleRe.exec(raw);
    const blockEnd = nextMatch ? nextMatch.index : raw.length;
    ruleRe.lastIndex = nextMatch ? nextMatch.index : raw.length;
    const block = raw.slice(blockStart, blockEnd);
    ruleBlocks.push({ id, title, block, line: raw.slice(0, blockStart).split('\n').length });
  }
  return { raw, rules: ruleBlocks };
}

function parseRuleBlock(block) {
  const lines = block.split('\n');
  const rule = { id: '', title: '', trigger: '', fix: '', test: '', firstSeen: '', reference: '' };
  const headerRe = /^###\s+(R\d{3}):\s+(.+)$/;
  const match = headerRe.exec(lines[0]);
  if (match) {
    rule.id = match[1];
    rule.title = match[2];
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('- **発火条件**')) rule.trigger = line.replace(/^- \*\*発火条件\*\*:/, '').trim();
    else if (line.startsWith('- **修正**')) rule.fix = line.replace(/^- \*\*修正\*\*:/, '').trim();
    else if (line.startsWith('- **テスト**')) rule.test = line.replace(/^- \*\*テスト\*\*:/, '').trim();
    else if (line.startsWith('- **初出**')) rule.firstSeen = line.replace(/^- \*\*初出\*\*:/, '').trim();
    else if (line.startsWith('- **参考インシデント**')) rule.reference = line.replace(/^- \*\*参考インシデント\*\*:/, '').trim();
  }
  return rule;
}

function getNextRuleId(rules) {
  const ids = rules.map(r => r.id).filter(id => RULE_ID_RE.test(id)).map(id => parseInt(id.slice(1), 10));
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  return `R${String(max + 1).padStart(3, '0')}`;
}

// ─── ルール登録 ────────────────────────────────────────────

function captureRule({ cwd, title, file, pattern, trigger, fix, dryRun, firstSeen }) {
  const { raw, rules } = readRulesFile(cwd);
  const id = getNextRuleId(rules);
  const today = firstSeen || new Date().toISOString().slice(0, 10);

  const triggerText = trigger || (pattern ? `\`${pattern}\` に一致するコード` : file ? `${file} で発生したエラー` : '（条件未記入）');
  const fixText = fix || '（修正方法未記入）';

  // ルール追記ブロック
  const entry = `\n### ${id}: ${title}\n- **発火条件**: ${triggerText}\n- **修正**: ${fixText}\n- **テスト**: 該当パターンを grep で確認\n- **初出**: ${today}\n`;

  // 「## 登録手順」セクションの前に挿入
  const insertionPoint = raw.lastIndexOf('\n## 登録手順');
  let newRaw;
  if (insertionPoint >= 0) {
    newRaw = raw.slice(0, insertionPoint) + entry + raw.slice(insertionPoint);
  } else {
    // 登録手順セクションが無い場合は末尾へ
    const endMarker = raw.trimEnd().endsWith('```') ? raw.trimEnd().slice(0, -3).trimEnd() : raw.trimEnd();
    newRaw = endMarker + '\n' + entry + '\n';
  }

  if (dryRun) {
    console.log(JSON.stringify({ id, title, trigger: triggerText, fix: fixText, firstSeen: today, dryRun: true }));
    return { id, dryRun: true };
  }

  const filePath = path.join(cwd, RULES_FILE);
  fs.writeFileSync(filePath, newRaw, 'utf-8');
  console.log(JSON.stringify({ status: 'registered', id, title, file: RULES_FILE }));
  return { id, dryRun: false };
}

// ─── バリデーション ────────────────────────────────────────

function validateRules(cwd) {
  const { raw, rules } = readRulesFile(cwd);
  const issues = [];

  // ID 重複チェック
  const ids = rules.map(r => r.id);
  const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of [...new Set(duplicateIds)]) {
    issues.push({ type: 'duplicate_id', id, severity: 'error', message: `ルールID ${id} が重複しています` });
  }

  // 必須フィールドチェック
  for (const rule of rules) {
    const parsed = parseRuleBlock(rule.block);
    if (!parsed.id) issues.push({ type: 'missing_id', line: rule.line, severity: 'error', message: 'ルールIDが不明です' });
    if (!parsed.title) issues.push({ type: 'missing_title', id: parsed.id || '?', severity: 'warning', message: `${parsed.id}: タイトルが空です` });
    if (!parsed.trigger) issues.push({ type: 'missing_trigger', id: parsed.id, severity: 'warning', message: `${parsed.id}: 発火条件が未記入です` });
    if (!parsed.fix) issues.push({ type: 'missing_fix', id: parsed.id, severity: 'warning', message: `${parsed.id}: 修正方法が未記入です` });
    if (!parsed.firstSeen) issues.push({ type: 'missing_firstSeen', id: parsed.id, severity: 'info', message: `${parsed.id}: 初出日が未記入です` });
  }

  // frontmatter チェック
  if (!raw.startsWith('---\n')) {
    issues.push({ type: 'missing_frontmatter', severity: 'error', message: 'YAML frontmatter (---) が見つかりません' });
  }

  return issues;
}

// ─── ルール違反の検索 ────────────────────────────────────

function searchRuleViolations(cwd, ruleId) {
  const { raw, rules } = readRulesFile(cwd);
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) {
    console.log(JSON.stringify({ error: `ルール ${ruleId} が見つかりません` }));
    return [];
  }

  const parsed = parseRuleBlock(rule.block);
  // 発火条件から検索パターンを抽出
  const pattern = parsed.trigger.replace(/^`([^`]+)`.*$/, '$1');
  if (!pattern || pattern === parsed.trigger) {
    console.log(JSON.stringify({ info: `ルール ${ruleId}: 検索可能なパターンが定義されていません` }));
    return [];
  }

  const result = spawnSync('git', ['-C', cwd, 'grep', '-n', '--', pattern], { timeout: 30000, encoding: 'utf8' });
  if (result.status !== 0) {
    console.log(JSON.stringify({ ruleId, pattern, matches: 0 }));
    return [];
  }

  const matches = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [file, lineNo, ...rest] = line.split(':', 2);
    return { file, line: lineNo || '', content: rest.join(':') || '' };
  });

  console.log(JSON.stringify({ ruleId, pattern, matches: matches.length, files: [...new Set(matches.map(m => m.file))] }));
  return matches;
}

// ─── 一覧表示 ──────────────────────────────────────────────

function listRules(cwd) {
  const { rules } = readRulesFile(cwd);
  const parsed = rules.map(r => ({ block: r, ...parseRuleBlock(r.block) }));
  return parsed.map(r => ({
    id: r.id,
    title: r.title,
    trigger: r.trigger.slice(0, 60),
    firstSeen: r.firstSeen,
  }));
}

// ─── エントリポイント ──────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  try {
    if (args.validate) {
      const issues = validateRules(args.cwd);
      if (issues.length === 0) {
        console.log(JSON.stringify({ status: 'valid', rulesFile: RULES_FILE }));
      } else {
        const errors = issues.filter(i => i.severity === 'error');
        const warnings = issues.filter(i => i.severity === 'warning');
        console.log(JSON.stringify({ status: errors.length > 0 ? 'invalid' : 'warnings', issues, errorCount: errors.length, warningCount: warnings.length }));
        process.exitCode = errors.length > 0 ? 1 : 0;
      }
      return;
    }

    if (args.list) {
      const rules = listRules(args.cwd);
      console.log(JSON.stringify(rules, null, 2));
      return;
    }

    if (args.search) {
      searchRuleViolations(args.cwd, args.search);
      return;
    }

    if (args.exportJson) {
      const { rules } = readRulesFile(args.cwd);
      const parsed = rules.map(r => parseRuleBlock(r.block));
      console.log(JSON.stringify(parsed, null, 2));
      return;
    }

    if (args.capture) {
      if (args.interactive && !args.title) {
        console.log(JSON.stringify({ error: '対話モードは未実装です。--title を指定してください' }));
        process.exitCode = 1; return;
      }
      if (!args.title) {
        console.log(JSON.stringify({ error: '--title は必須です', usage: 'node tools/error-to-rule.mjs --capture --title "<ルール名>" [--file <path>] [--pattern <grep>]' }));
        process.exitCode = 1; return;
      }
      captureRule({
        cwd: args.cwd,
        title: args.title,
        file: args.file,
        pattern: args.pattern,
        trigger: args.trigger,
        fix: args.fix,
        dryRun: args.dryRun,
        firstSeen: new Date().toISOString().slice(0, 10),
      });
      return;
    }

    // デフォルト: 使用方法表示
    console.log(`error-to-rule.mjs — エラーをLintルール化する再現可能コーディングツール

使い方:
  --capture --title "<ルール名>"    新規ルールを登録
    [--file <path>] [--pattern <grep>] [--trigger "<条件>"] [--fix "<修正法>"]
    [--dry-run] [--cwd <path>]
  --validate                       ルール一覧の整合性チェック
  --search <RULE_ID>               特定ルールの違反をコード検索
  --list                           全ルール一覧をJSON表示
  --export-json                    全ルールをJSON出力

例:
  node tools/error-to-rule.mjs --capture --title "絶対パス直書き禁止" --pattern "C:\\\\\\\\Users" --fix "os.homedir() を使う"
  node tools/error-to-rule.mjs --validate
  node tools/error-to-rule.mjs --search R001`);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message, stack: err.stack }));
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) { main(); }