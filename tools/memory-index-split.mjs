#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const V2_MARKER = '<!-- MEMORY-INDEX v2 split -->';
export const MAX_MEMORY_BYTES = 5120;
export const DOMAINS = Object.freeze({
  shared: ['他PCからの共有知見', '別アカウントPCで確立した実測ノウハウ'],
  session: ['セッション運用', '引き継ぎ/並行セッション/1目的/監査/記憶索引'],
  cost: ['AIコストと委譲', 'モデルルーティング/Codex/安いAI/課金枠'],
  workstyle: ['userへの接し方', '手作業ゼロ/依頼の書き方/通知/クレデンシャル'],
  infra: ['インフラ・CI', 'GitHub Actions/Vercel/cron/秘密鍵/keyserve/fleet'],
  gas: ['GAS・Workspace', 'clasp/Sheets/Drive/Gmail/DWD'],
  booth: ['ブース制作', '実行パネル/見積/原価/施工'],
  biz: ['経営・営業・組織', '100億計画/営業/顧問/社員/拠点'],
  apps: ['自社アプリ', '購買部/秘書/カフェ/学会協賛ナビ/aujust'],
  devtools: ['Claude Code本体', 'hook/skill/MCP/permission/マキモノ'],
  verify: ['検証と失敗の型', 'exit0/沈黙failure/read-back/デプロイ検証'],
  platform: ['実行環境の罠', 'Windows/Node/ESM/git bash/文字化け'],
  reference: ['外部リソース', 'URL/ダッシュボード/連絡先/外部仕様'],
});

const LINK_RE = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

function optionValue(argv, name, required = false) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} が必要です`);
    return undefined;
  }
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} の値が必要です`);
  return argv[index + 1];
}

function memoryFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith('.md') && item.name !== 'MEMORY.md' && !item.name.includes('.bak'))
    .map((item) => item.name).sort();
}

function formatOf(buffer) {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = buffer.subarray(bom ? 3 : 0).toString('utf8');
  return { bom, eol: text.includes('\r\n') ? '\r\n' : '\n', text };
}

function encode(text, format) {
  const body = Buffer.from(text.replace(/\n/g, format.eol), 'utf8');
  return format.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function titlesFrom(text, baseDirectory, wantedDirectory) {
  const result = new Map();
  for (const match of text.matchAll(LINK_RE)) {
    const resolved = path.resolve(baseDirectory, match[2]);
    if (path.dirname(resolved) === path.resolve(wantedDirectory)) result.set(path.basename(resolved), match[1]);
  }
  return result;
}

function externallyManagedIndexes(directory) {
  const result = new Map();
  const indexDirectory = path.join(directory, 'index');
  if (!fs.existsSync(indexDirectory)) return result;
  for (const [key] of Object.entries(DOMAINS)) {
    const filename = path.join(indexDirectory, `${key}.md`);
    if (!fs.existsSync(filename)) continue;
    const content = fs.readFileSync(filename);
    const text = content.toString('utf8');
    const externalTargets = [...text.matchAll(LINK_RE)]
      .map((match) => path.resolve(indexDirectory, match[2]))
      .filter((target) => path.dirname(target) !== path.resolve(directory));
    if (externalTargets.length) result.set(key, { content, count: externalTargets.length });
  }
  return result;
}

function frontmatterDescription(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return '';
  const line = match[1].split(/\r?\n/).find((item) => /^description\s*:/.test(item));
  if (!line) return '';
  let value = line.replace(/^description\s*:\s*/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value;
}

function descriptionTitle(description) {
  const first = [...description].slice(0, 40).join('');
  const punctuation = first.search(/[。、,.，．]/u);
  return (punctuation >= 0 ? first.slice(0, punctuation + 1) : first).trim();
}

function fallbackTitle(file) {
  return file.replace(/\.md$/i, '').replace(/^[^_]+_/, '').replaceAll('_', ' ');
}

function backupIndexFiles(backupsDirectory) {
  if (!backupsDirectory || !fs.existsSync(backupsDirectory)) return [];
  return fs.readdirSync(backupsDirectory, { withFileTypes: true })
    .filter((item) => item.isFile() && /^MEMORY\.md\.bak-/.test(item.name))
    .map((item) => path.join(backupsDirectory, item.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || b.localeCompare(a));
}

function chooseTitles({ directory, oldMemory, assignments, backupsDirectory }) {
  const titles = new Map(titlesFrom(oldMemory, directory, directory));
  const indexDirectory = path.join(directory, 'index');
  for (const [file, key] of Object.entries(assignments)) {
    if (titles.has(file)) continue;
    const indexFile = path.join(indexDirectory, `${key}.md`);
    if (!fs.existsSync(indexFile)) continue;
    const found = titlesFrom(fs.readFileSync(indexFile, 'utf8'), indexDirectory, directory).get(file);
    if (found) titles.set(file, found);
  }
  for (const backup of backupIndexFiles(backupsDirectory)) {
    // バックアップの置き場所が memoryDir 外でも、記録されたリンクは元の
    // MEMORY.md と同じく memoryDir 基準として解釈する。
    const found = titlesFrom(fs.readFileSync(backup, 'utf8'), directory, directory);
    for (const [file, title] of found) if (!titles.has(file)) titles.set(file, title);
  }
  for (const file of Object.keys(assignments)) {
    if (titles.has(file)) continue;
    const description = frontmatterDescription(fs.readFileSync(path.join(directory, file), 'utf8'));
    titles.set(file, descriptionTitle(description) || fallbackTitle(file));
  }
  return titles;
}

function parsePins(file) {
  if (!file) return [];
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function validateAssignments(files, assignments) {
  const missing = files.filter((file) => !Object.hasOwn(assignments, file));
  if (missing.length) throw new Error(`未分類の memory ファイル:\n${missing.map((file) => `- ${file}`).join('\n')}`);
  const unknownFiles = Object.keys(assignments).filter((file) => !files.includes(file));
  if (unknownFiles.length) throw new Error(`--domains に存在しない memory ファイルがあります:\n${unknownFiles.map((file) => `- ${file}`).join('\n')}`);
  const invalid = Object.entries(assignments).filter(([, key]) => !Object.hasOwn(DOMAINS, key));
  if (invalid.length) throw new Error(`未知のドメインキー:\n${invalid.map(([file, key]) => `- ${file}: ${key}`).join('\n')}`);
}

export function build({ directory, domainsFile, pinsFile, backupsDirectory }) {
  const memoryPath = path.join(directory, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) throw new Error(`MEMORY.md がありません: ${memoryPath}`);
  const oldBuffer = fs.readFileSync(memoryPath);
  const format = formatOf(oldBuffer);
  const files = memoryFiles(directory);
  const assignments = JSON.parse(fs.readFileSync(domainsFile, 'utf8').replace(/^\uFEFF/, ''));
  validateAssignments(files, assignments);
  const pins = parsePins(pinsFile);
  const invalidPins = [...new Set(pins.filter((file) => !files.includes(file)))];
  if (invalidPins.length) throw new Error(`pin のファイルが存在しません:\n${invalidPins.map((file) => `- ${file}`).join('\n')}`);
  if (new Set(pins).size !== pins.length) throw new Error('--pins に重複があります');
  const titles = chooseTitles({ directory, oldMemory: format.text, assignments, backupsDirectory });
  const externalIndexes = externallyManagedIndexes(directory);
  const grouped = new Map();
  for (const key of Object.keys(DOMAINS)) grouped.set(key, []);
  for (const file of files) grouped.get(assignments[file]).push(file);

  const memoryLines = [
    V2_MARKER,
    '> 新規 memory の1行は **`index/<ドメイン>.md`** に足す。このファイルには足さない(閾値 24,985B で切り捨てられるため)。',
    '', '## 常に効くルール',
    ...pins.map((file) => `- [${titles.get(file)}](${file})`),
    '', '## ドメイン索引',
  ];
  const indexes = new Map();
  for (const [key, [display, keywords]] of Object.entries(DOMAINS)) {
    const external = externalIndexes.get(key);
    if (external) {
      memoryLines.push(`- **${display}** ${keywords} → [index/${key}.md](index/${key}.md) (${external.count}件)`);
      indexes.set(`${key}.md`, external.content);
      continue;
    }
    const domainFiles = grouped.get(key);
    if (!domainFiles.length) continue;
    memoryLines.push(`- **${display}** ${keywords} → [index/${key}.md](index/${key}.md) (${domainFiles.length}件)`);
    const text = [`# ${display}`, '', '（MEMORY.md から辿られるサブ索引。新規はここへ1行足す）', '', ...domainFiles.map((file) => `- [${titles.get(file)}](../${file})`), ''].join('\n');
    indexes.set(`${key}.md`, encode(text, format));
  }
  memoryLines.push('');
  const memory = encode(memoryLines.join('\n'), format);
  if (memory.length > MAX_MEMORY_BYTES) throw new Error(`MEMORY.md が ${memory.length}B で上限 ${MAX_MEMORY_BYTES}B を超えます`);
  return { memory, indexes, files, format };
}

function currentMatches(directory, plan) {
  const memoryPath = path.join(directory, 'MEMORY.md');
  if (!fs.readFileSync(memoryPath).equals(plan.memory)) return false;
  const indexDirectory = path.join(directory, 'index');
  if (!fs.existsSync(indexDirectory)) return false;
  const names = fs.readdirSync(indexDirectory, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.md')).map((item) => item.name).sort();
  if (names.join('\0') !== [...plan.indexes.keys()].sort().join('\0')) return false;
  return names.every((name) => fs.readFileSync(path.join(indexDirectory, name)).equals(plan.indexes.get(name)));
}

function timestamp(date = new Date()) {
  const two = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function validateReadBack(directory, expectedFiles) {
  const memoryPath = path.join(directory, 'MEMORY.md');
  const memory = fs.readFileSync(memoryPath, 'utf8');
  const problems = [];
  if (Buffer.byteLength(fs.readFileSync(memoryPath)) > MAX_MEMORY_BYTES) problems.push('MEMORY.md が 5,120B を超えています');
  const counts = new Map(expectedFiles.map((file) => [file, 0]));
  const documents = [{ file: memoryPath, text: memory }];
  const indexDirectory = path.join(directory, 'index');
  for (const name of fs.readdirSync(indexDirectory).filter((name) => name.endsWith('.md'))) {
    const file = path.join(indexDirectory, name);
    const text = fs.readFileSync(file, 'utf8');
    documents.push({ file, text });
    for (const match of text.matchAll(LINK_RE)) {
      const target = path.resolve(indexDirectory, match[2]);
      const base = path.basename(target);
      if (counts.has(base) && path.dirname(target) === path.resolve(directory)) counts.set(base, counts.get(base) + 1);
    }
  }
  for (const [file, count] of counts) if (count !== 1) problems.push(`${file} のサブ索引掲載回数が ${count} 回です`);
  for (const document of documents) for (const match of document.text.matchAll(LINK_RE)) {
    if (!fs.existsSync(path.resolve(path.dirname(document.file), match[2]))) problems.push(`リンク先が存在しません: ${document.file} -> ${match[2]}`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

export function run(argv = process.argv.slice(2)) {
  const directory = path.resolve(optionValue(argv, '--dir', true));
  const domainsFile = path.resolve(optionValue(argv, '--domains', true));
  const pinsValue = optionValue(argv, '--pins');
  const backupsValue = optionValue(argv, '--backups');
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('--dry-run と --apply は同時に指定できません');
  const plan = build({ directory, domainsFile, pinsFile: pinsValue && path.resolve(pinsValue), backupsDirectory: backupsValue && path.resolve(backupsValue) });
  console.log(`生成予定: memory ${plan.files.length}件 / sub index ${plan.indexes.size}件 / MEMORY.md ${plan.memory.length}B`);
  if (!apply) { console.log('dry-run: 書き込みなし'); return { ...plan, changed: !currentMatches(directory, plan) }; }
  if (currentMatches(directory, plan)) { console.log('変更なし'); return { ...plan, changed: false }; }

  const stamp = timestamp();
  const memoryPath = path.join(directory, 'MEMORY.md');
  const indexDirectory = path.join(directory, 'index');
  const memoryBackup = path.join(directory, `MEMORY.md.bak-${stamp}`);
  const indexBackup = path.join(directory, `index.bak-${stamp}`);
  fs.copyFileSync(memoryPath, memoryBackup, fs.constants.COPYFILE_EXCL);
  const hadIndex = fs.existsSync(indexDirectory);
  if (hadIndex) fs.cpSync(indexDirectory, indexBackup, { recursive: true, errorOnExist: true, force: false });
  try {
    fs.rmSync(indexDirectory, { recursive: true, force: true });
    fs.mkdirSync(indexDirectory);
    for (const [name, content] of plan.indexes) fs.writeFileSync(path.join(indexDirectory, name), content);
    fs.writeFileSync(memoryPath, plan.memory);
    validateReadBack(directory, plan.files);
    if (!currentMatches(directory, plan)) throw new Error('read-back が生成内容と一致しません');
  } catch (error) {
    fs.copyFileSync(memoryBackup, memoryPath);
    fs.rmSync(indexDirectory, { recursive: true, force: true });
    if (hadIndex) fs.cpSync(indexBackup, indexDirectory, { recursive: true });
    throw new Error(`適用後検証に失敗したためバックアップから復元しました: ${error.message}`);
  }
  console.log(`適用完了: ${memoryPath}`);
  console.log(`バックアップ: ${memoryBackup}${hadIndex ? ` / ${indexBackup}` : ''}`);
  return { ...plan, changed: true, memoryBackup, indexBackup: hadIndex ? indexBackup : undefined };
}

if (isEntry(import.meta.url)) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
