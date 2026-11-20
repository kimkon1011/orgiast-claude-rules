#!/usr/bin/env node
/**
 * tools/notion-skill-sync.mjs
 * Notion 共有メモリブリッジ — 複数AI（Claude・Gemini・ChatGPT）間で
 * スキル（手順書）とメモリ（記憶）を共有する。
 *
 * 動作モード:
 *   Notion API キー未設定 → Drive フォルダを経由したファイルベース同期（既存 Drive 同期の拡張）
 *   NOTION_API_KEY 設定時 → Notion Database を直接读写
 *
 * コマンド:
 *   node tools/notion-skill-sync.mjs skill pull    [--dry-run]
 *   node tools/notion-skill-sync.mjs skill push    [--dry-run]
 *   node tools/notion-skill-sync.mjs memory pull   [--dry-run]
 *   node tools/notion-skill-sync.mjs memory push   [--dry-run]
 *   node tools/notion-skill-sync.mjs schema        [--format notion|markdown]
 *   node tools/notion-skill-sync.mjs validate <file>
 *
 * X-0017: Notion 共有メモリで複数AIへの再説明コストを削減
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

// ── 設定 ────────────────────────────────────────────────
const SKILLS_DIR = 'skills';                    // リポジトリ上のスキルディレクトリ
const SHARED_INBOX = '1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2'; // knowledge-inbox フォルダ
const NOTION_DB_SKILLS = 'SKILLS';              // Notion DB名（API利用時）
const NOTION_DB_MEMORIES = 'MEMORIES';           // Notion DB名（API利用時）
const PII_PATTERNS = [
  [/マイナンバー|個人番号|基礎年金番号/i, '個人識別番号'],
  [/パスポート|旅券番号/i, 'パスポート番号'],
  [/C0\d{3,}/i, '案件ID'],
  [/株式会社|有限会社|合同会社/, '法人名'],
  [/https:\/\/script\.google\.com\/[a-z]\/[A-Za-z0-9_-]{20,}/, 'Apps Script ID'],
  [/AIza[0-9A-Za-z_-]{35}|sk-[0-9A-Za-z]{20,}|sk-ant-[0-9A-Za-z]{20,}/, 'API キー'],
];

// ── スキーマ定義 ──────────────────────────────────────────

export const NOTION_SKILL_SCHEMA = {
  database: 'SKILLS',
  description: 'AI スキル（手順書） — 全AI（Claude/Gemini/ChatGPT）で共有する定型作業手順',
  properties: [
    { name: 'Name', type: 'title', description: 'スキル名（skills/<name>/SKILL.md の name と一致）' },
    { name: 'Description', type: 'rich_text', description: '1行の説明（SKILL.md frontmatter description）' },
    { name: 'Category', type: 'select', options: ['booth-design', 'seo', 'gas', 'automation', 'communication', 'research', 'other'],
      description: '機能カテゴリ' },
    { name: 'Body', type: 'markdown', description: 'スキル本文（SKILL.md の # 以降）' },
    { name: 'AI-Platform', type: 'multi_select', options: ['claude', 'gemini', 'chatgpt', 'copilot'],
      description: '動作確認済みAIプラットフォーム' },
    { name: 'LastSynced', type: 'date', description: '最終同期日時' },
    { name: 'Version', type: 'number', description: 'バージョン（1始まり）' },
    { name: 'NeedsReview', type: 'checkbox', description: '週次レビュー待ちフラグ' },
    { name: 'Source', type: 'select', options: ['human', 'claude', 'gemini', 'chatgpt', 'copilot'],
      description: '最終更新者' },
  ],
};

export const NOTION_MEMORY_SCHEMA = {
  database: 'MEMORIES',
  description: '共有メモリ — 全AIで共有する過去の判断・仕様・フィードバック',
  properties: [
    { name: 'Title', type: 'title', description: 'メモリタイトル（memory/<name>.md の name スラッグ）' },
    { name: 'Type', type: 'select', options: ['user', 'feedback', 'project', 'reference'],
      description: 'メモリ種別' },
    { name: 'Body', type: 'markdown', description: 'メモリ本文' },
    { name: 'Source', type: 'select', options: ['human', 'claude', 'gemini', 'chatgpt', 'copilot'],
      description: '作成者' },
    { name: 'Created', type: 'date', description: '作成日' },
    { name: 'NeedsReview', type: 'checkbox', description: '週次レビュー待ち（AI生成は初期 true）' },
    { name: 'Tags', type: 'multi_select', options: [],
      description: 'タグ（自由入力）' },
  ],
};

// ── ヘルパー ──────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function oneLine(e) {
  return String(e?.message || e || '不明').split(/\r?\n/)[0];
}

function argValue(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function repoRoot() {
  // このファイルの位置からリポジトリルートを解決
  let dir = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname);
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'tools', 'setup-manifest.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function readSkillFrontmatter(skillDir) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  const text = fs.readFileSync(skillFile, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { name: path.basename(skillDir), description: '', raw: text };
  const front = Object.fromEntries(
    m[1].split('\n').filter(l => l.includes(':')).map(l => {
      const [k, ...v] = l.split(':');
      return [k.trim(), v.join(':').trim()];
    })
  );
  const body = text.slice(m[0].length);
  return { name: front.name || path.basename(skillDir), description: front.description || '', body, raw: text };
}

function writeSkillFrontmatter(skillDir, { name, description, body }) {
  const frontmatter = `---
name: ${name}
description: ${description}
---\n\n`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), frontmatter + (body || '').trimStart());
}

// ── PII 検出 ──────────────────────────────────────────────

export function detectPII(text, options = {}) {
  const findings = [];
  for (const [pattern, label] of PII_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ label, pattern: pattern.source });
      if (options.firstOnly) break;
    }
  }
  return findings;
}

export function redactPII(text) {
  let result = text;
  for (const [pattern] of PII_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (pattern.source.startsWith('\\d')) return match.replace(/\d/g, 'x');
      if (match.length <= 4) return '**REDACTED**';
      return match[0] + '…' + match[match.length - 1];
    });
  }
  return result;
}

// ── スキーマ出力 ──────────────────────────────────────────

export function formatSchema(database, format = 'markdown') {
  const schema = database === 'SKILLS' ? NOTION_SKILL_SCHEMA : NOTION_MEMORY_SCHEMA;
  if (format === 'notion') {
    // Notion API 用 JSON
    return JSON.stringify({
      object: 'database',
      parent: { type: 'page_id', page_id: '{{PAGE_ID}}' },
      title: [{ type: 'text', text: { content: schema.database } }],
      description: [{ type: 'text', text: { content: schema.description } }],
      properties: Object.fromEntries(schema.properties.map(p => [
        p.name, { type: p.type.toLowerCase() === 'markdown' ? 'rich_text' : p.type.toLowerCase(),
          ...(p.options ? { [p.type === 'select' ? 'select' : 'multi_select']: { options: p.options.map(o => ({ name: o, color: 'default' })) } } : {}) }
      ])),
    }, null, 2);
  }

  // Markdown 形式（人間用）
  const lines = [
    `# Notion Database: \`${schema.database}\``,
    '',
    schema.description,
    '',
    '## プロパティ',
    '',
    '| プロパティ名 | 型 | 必須 | 説明 |',
    '|------------|-----|------|------|',
  ];
  for (const p of schema.properties) {
    const required = ['Name', 'Title', 'Body', 'Type'].includes(p.name);
    const typeStr = p.options ? `${p.type}（${p.options.join('/')}）` : p.type;
    lines.push(`| \`${p.name}\` | ${typeStr} | ${required ? '✓' : ''} | ${p.description} |`);
  }
  lines.push('');
  lines.push('## セキュリティルール');
  lines.push('');
  lines.push('- 個人情報・マイナンバー・パスポート番号を **Body に直接書かない**');
  lines.push('- 顧客案件ID（C0xxx）は抽象化して記述（例: `C0056` → `某建設機械メーカー`）');
  lines.push('- API キー・シークレットは Script Properties や secrets 経由で参照');
  lines.push('- AI が生成したメモリは \`NeedsReview: true\` でマーク → 週次レビューで人が確認');
  lines.push('');
  lines.push('## 週次レビューワークフロー');
  lines.push('');
  lines.push('1. \`NeedsReview: true\` のレコードを Notion でフィルタ');
  lines.push('2. 内容の正確性・PII不在・重複を人間が確認');
  lines.push('3. 承認 → \`NeedsReview: false\` に設定');
  lines.push('4. 却下 → 削除または修正を依頼');
  lines.push('5. 恒久ルールに昇格すべき内容は CLAUDE.md または rules/ へ移行');
  return lines.join('\n');
}

// ── スキル同期（Drive 経由・ファイルベース） ──────────────

/**
 * skill pull: Drive 共有インボックス → ローカル skills/
 * sharedInboxPath: 共有フォルダのローカルマウント or Drive MCP経由のパス
 */
export function pullSkills(options = {}) {
  const { sharedInboxPath, dryRun = false, repoDir = repoRoot() } = options;
  const results = { pulled: [], skipped: [], errors: [] };

  if (!sharedInboxPath || !fs.existsSync(sharedInboxPath)) {
    results.errors.push('共有インボックスが利用できません。Drive MCP または共有フォルダをマウントしてください。');
    return results;
  }

  // skills サブフォルダを探索
  const skillsSrc = path.join(sharedInboxPath, 'skills');
  if (!fs.existsSync(skillsSrc)) {
    results.errors.push('skills/ サブフォルダが共有インボックスに見つかりません。');
    return results;
  }

  for (const entry of fs.readdirSync(skillsSrc)) {
    if (entry.startsWith('.') || !fs.statSync(path.join(skillsSrc, entry)).isDirectory()) continue;
    const srcSkillFile = path.join(skillsSrc, entry, 'SKILL.md');
    if (!fs.existsSync(srcSkillFile)) continue;

    const skillData = readSkillFrontmatter(path.join(skillsSrc, entry));
    if (!skillData) { results.skipped.push(entry); continue; }

    // PII チェック
    const pii = detectPII(skillData.body || '');
    if (pii.length > 0) {
      results.errors.push(`${entry}: PII検出 (${pii.map(p => p.label).join(', ')}) — スキップ`);
      continue;
    }

    // ローカル skills/<name>/ に書き出し
    const targetDir = path.join(repoDir, SKILLS_DIR, skillData.name);
    if (!dryRun) {
      fs.mkdirSync(targetDir, { recursive: true });
      writeSkillFrontmatter(targetDir, skillData);
    }
    results.pulled.push(entry);
  }

  return results;
}

/**
 * skill push: ローカル skills/ → Drive 共有インボックス
 */
export function pushSkills(options = {}) {
  const { sharedInboxPath, dryRun = false, repoDir = repoRoot() } = options;
  const results = { pushed: [], skipped: [], errors: [] };

  if (!sharedInboxPath || !fs.existsSync(sharedInboxPath)) {
    results.errors.push('共有インボックスが利用できません。');
    return results;
  }

  const skillsDir = path.join(repoDir, SKILLS_DIR);
  if (!fs.existsSync(skillsDir)) {
    results.errors.push(`skills/ ディレクトリが見つかりません: ${skillsDir}`);
    return results;
  }

  const targetBase = path.join(sharedInboxPath, 'skills');
  if (!dryRun) fs.mkdirSync(targetBase, { recursive: true });

  for (const entry of fs.readdirSync(skillsDir)) {
    if (entry.startsWith('.') && entry !== '.') continue;
    const skillDir = path.join(skillsDir, entry);
    if (!fs.statSync(skillDir).isDirectory()) continue;

    const skillData = readSkillFrontmatter(skillDir);
    if (!skillData) { results.skipped.push(entry); continue; }

    // PII チェック
    const pii = detectPII(skillData.body || '');
    if (pii.length > 0) {
      results.errors.push(`${entry}: PII検出 (${pii.map(p => p.label).join(', ')}) — スキップ`);
      continue;
    }

    // 共有先に書き出し
    const targetDir = path.join(targetBase, skillData.name);
    if (!dryRun) {
      fs.mkdirSync(targetDir, { recursive: true });
      writeSkillFrontmatter(targetDir, skillData);
    }
    results.pushed.push(entry);
  }

  return results;
}

// ── メモリ同期 ──────────────────────────────────────────────

/**
 * memory pull: 共有メモリ → ローカル auto-memory
 * 共有メモリは Drive 上の cross-ai-memory/ フォルダに保管
 */
export function pullSharedMemory(options = {}) {
  const { sharedInboxPath, dryRun = false, homeDir = os.homedir() } = options;
  const results = { pulled: [], skipped: [], errors: [] };

  if (!sharedInboxPath || !fs.existsSync(sharedInboxPath)) {
    results.errors.push('共有メモリインボックスが利用できません。');
    return results;
  }

  const memorySrc = path.join(sharedInboxPath, 'cross-ai-memory');
  if (!fs.existsSync(memorySrc)) {
    results.skipped.push('cross-ai-memory/ なし');
    return results;
  }

  const memoryDir = path.join(homeDir, '.claude', 'projects',
    'd--CLAUDE-md--', 'memory');
  if (!dryRun) fs.mkdirSync(memoryDir, { recursive: true });

  for (const entry of fs.readdirSync(memorySrc)) {
    if (!entry.endsWith('.md') || entry === 'MEMORY.md') continue;
    const srcPath = path.join(memorySrc, entry);
    if (!fs.statSync(srcPath).isFile()) continue;

    const content = fs.readFileSync(srcPath, 'utf8');

    // PII チェック
    const pii = detectPII(content);
    if (pii.length > 0) {
      results.errors.push(`${entry}: PII検出 — スキップ`);
      continue;
    }

    // 重複チェック: 同名ファイルが既にあれば sha256 で比較
    const targetPath = path.join(memoryDir, entry);
    if (fs.existsSync(targetPath)) {
      const existingSha = sha256(fs.readFileSync(targetPath, 'utf8'));
      const incomingSha = sha256(content);
      if (existingSha === incomingSha) {
        results.skipped.push(`${entry} (変更なし)`);
        continue;
      }
      // content に frontmatter の modified が古い方で更新 = 古い方を上書き
    }

    if (!dryRun) {
      fs.writeFileSync(targetPath, content);
    }
    results.pulled.push(entry);
  }

  return results;
}

/**
 * memory push: ローカル auto-memory → 共有メモリ
 * AI生成メモリは NeedsReview フラグを付与
 */
export function pushSharedMemory(options = {}) {
  const { sharedInboxPath, dryRun = false, homeDir = os.homedir(), source = 'claude' } = options;
  const results = { pushed: [], skipped: [], errors: [] };

  if (!sharedInboxPath || !fs.existsSync(sharedInboxPath)) {
    results.errors.push('共有メモリインボックスが利用できません。');
    return results;
  }

  const memoryDir = path.join(homeDir, '.claude', 'projects',
    'd--CLAUDE-md--', 'memory');
  if (!fs.existsSync(memoryDir)) {
    results.skipped.push('ローカル memory/ なし');
    return results;
  }

  const targetBase = path.join(sharedInboxPath, 'cross-ai-memory');
  if (!dryRun) fs.mkdirSync(targetBase, { recursive: true });

  for (const entry of fs.readdirSync(memoryDir)) {
    if (!entry.endsWith('.md') || entry === 'MEMORY.md' || entry.startsWith('.')) continue;
    const srcPath = path.join(memoryDir, entry);
    if (!fs.statSync(srcPath).isFile()) continue;

    const content = fs.readFileSync(srcPath, 'utf8');

    // PII チェック
    const pii = detectPII(content);
    if (pii.length > 0) {
      results.errors.push(`${entry}: PII検出 — スキップ`);
      continue;
    }

    // AI生成メモリには NeedsReview フラグを追加
    let outContent = content;
    if (!content.includes('NeedsReview:') && source !== 'human') {
      if (content.startsWith('---')) {
        // frontmatter に追加
        outContent = content.replace(/^---\n/, `---\nmetadata:\n  needsReview: true\n  source: ${source}\n`);
      } else {
        outContent = `---\nmetadata:\n  needsReview: true\n  source: ${source}\n---\n\n${content}`;
      }
    }

    // 共有先に書き出し（同名 → 新規 or 更新）
    const targetPath = path.join(targetBase, entry);
    if (fs.existsSync(targetPath)) {
      const existingSha = sha256(fs.readFileSync(targetPath, 'utf8'));
      if (existingSha === sha256(outContent)) {
        results.skipped.push(`${entry} (変更なし)`);
        continue;
      }
    }

    if (!dryRun) {
      fs.writeFileSync(targetPath, outContent);
    }
    results.pushed.push(entry);
  }

  return results;
}

// ── CLI ────────────────────────────────────────────────────

export function main(argv = process.argv) {
  const mode = argv[2] || 'help';

  if (mode === 'schema') {
    const format = argValue(argv, '--format') || 'markdown';
    console.log('=== SKILLS ===');
    console.log(formatSchema('SKILLS', format));
    console.log('\n=== MEMORIES ===');
    console.log(formatSchema('MEMORIES', format));
    return 0;
  }

  if (mode === 'validate') {
    const file = argv[3];
    if (!file || !fs.existsSync(file)) {
      console.error('Usage: notion-skill-sync.mjs validate <file>');
      return 1;
    }
    const content = fs.readFileSync(file, 'utf8');
    const pii = detectPII(content);
    if (pii.length === 0) {
      console.log('✅ PII 検出なし');
      return 0;
    }
    console.log(`⚠ PII 検出: ${pii.length}件`);
    for (const p of pii) console.log(`  - ${p.label}（/${p.pattern}/）`);
    return 1;
  }

  if (mode === 'skill') {
    const action = argv[3] || 'help';
    const dryRun = hasFlag(argv, '--dry-run');
    const sharedInboxPath = argValue(argv, '--inbox') || process.env.NOTION_SYNC_INBOX;

    if (action === 'pull') {
      const result = pullSkills({ sharedInboxPath, dryRun });
      console.log(JSON.stringify(result, null, 2));
      return result.errors.length > 0 ? 1 : 0;
    }

    if (action === 'push') {
      const result = pushSkills({ sharedInboxPath, dryRun });
      console.log(JSON.stringify(result, null, 2));
      return result.errors.length > 0 ? 1 : 0;
    }
  }

  if (mode === 'memory') {
    const action = argv[3] || 'help';
    const dryRun = hasFlag(argv, '--dry-run');
    const sharedInboxPath = argValue(argv, '--inbox') || process.env.NOTION_SYNC_INBOX;
    const source = argValue(argv, '--source') || process.env.AI_PLATFORM || 'claude';

    if (action === 'pull') {
      const result = pullSharedMemory({ sharedInboxPath, dryRun });
      console.log(JSON.stringify(result, null, 2));
      return result.errors.length > 0 ? 1 : 0;
    }

    if (action === 'push') {
      const result = pushSharedMemory({ sharedInboxPath, dryRun, source });
      console.log(JSON.stringify(result, null, 2));
      return result.errors.length > 0 ? 1 : 0;
    }
  }

  // help
  console.log(`Notion 共有メモリブリッジ v1 (X-0017)

使い方:
  node tools/notion-skill-sync.mjs skill pull    [--dry-run] [--inbox <path>]
  node tools/notion-skill-sync.mjs skill push    [--dry-run] [--inbox <path>]
  node tools/notion-skill-sync.mjs memory pull   [--dry-run] [--inbox <path>]
  node tools/notion-skill-sync.mjs memory push   [--dry-run] [--inbox <path>] [--source <ai-name>]
  node tools/notion-skill-sync.mjs schema        [--format notion|markdown]
  node tools/notion-skill-sync.mjs validate <file>

環境変数:
  NOTION_SYNC_INBOX  共有インボックス（Drive フォルダ）のパス
  AI_PLATFORM        自AIの識別名（claude / gemini / chatgpt / copilot）
  NOTION_API_KEY     Notion API 統合キー（設定時は直接 Notion DB 读写）
`);
  return 1;
}

if (isEntry(import.meta.url)) {
  process.exit(main());
}