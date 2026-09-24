#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepo = path.dirname(path.dirname(scriptPath));
const docPath = (repoRoot) => path.join(repoRoot, 'docs', 'prompt-memory-optimization.md');

export function loadCatalog(repoRoot = defaultRepo) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', 'prompt-memory-guideline.json'), 'utf8'));
}

export function renderDoc(catalog) {
  const lines = [
    '# プロンプトとメモリ最適化ガイドライン', '',
    '<!-- tools/prompt-memory-guideline.json から tools/prompt-memory-guideline.mjs --write で生成。手で編集しない。 -->', '',
    catalog.purpose, '', '## 原則',
    ...catalog.principles.map((item) => `- ${item}`), '', '## 規則',
  ];
  for (const rule of catalog.rules) {
    lines.push(`### ${rule.id} ${rule.title}`, `- 規則: ${rule.rule}`, `- 理由: ${rule.why}`,
      `- 適用: ${rule.howToApply.join(' / ')}`,
      `- 検査: ${rule.check ? `自動（${rule.check.type}）` : '手動（規範）'}`);
    if (rule.evidence) lines.push(`- 根拠: ${rule.evidence.join(' / ')}`);
    lines.push('');
  }
  lines.push('## 既存ツールとの対応', ...catalog.tooling.map((item) => `- \`${item.tool}\` — ${item.role}`),
    '', '## 実測から得た教訓', ...catalog.lessons.map((item) => `- ${item}`));
  return `${lines.join('\n').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trimEnd()}\n`;
}

function optionalRead(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}

function entries(directory) {
  try { return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; }
}

// 検査対象は「索引 MEMORY.md を持つ記憶ディレクトリ」だけにする。
// 過去に作られて放置された projects/*/memory まで巻き込むと、保守対象でない
// ディレクトリの古い形式で毎回 fail し、--check が常に赤になって信号として使えなくなる。
function memoryDirectories(home) {
  const projects = path.resolve(home, '.claude', 'projects');
  return entries(projects).filter((item) => item.isDirectory())
    .map((item) => path.join(projects, item.name))
    .map((project) => path.join(project, 'memory'))
    .filter((directory) => entries(directory).some((item) => item.name === 'MEMORY.md' && item.isFile()));
}

// 保守対象の記憶ディレクトリを1つに定める。索引を持つ候補のうち、いちばん多くの
// memory を抱えているものを「そのPCの正本」とみなし、同数ならパス順で決める。
// こうしないと、過去に作られて放置された別プロジェクトの記憶まで検査対象になり、
// 直しようのない古い形式で --check が常に赤になって信号として使えなくなる。
export function primaryMemoryDirectory(home) {
  const scored = memoryDirectories(home).map((directory) => ({
    directory,
    count: entries(directory).filter((item) => item.isFile() && item.name.endsWith('.md')).length,
  }));
  if (!scored.length) return null;
  scored.sort((a, b) => (b.count - a.count) || (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));
  return scored[0].directory;
}

function othersNote(home, primary) {
  const others = memoryDirectories(home).filter((directory) => directory !== primary);
  return others.length ? `（保守対象外の記憶ディレクトリ ${others.length} 件は検査しない）` : '';
}

export function checkMemoryIndexByteCap({ home, repoRoot, now }, { limitBytes }) {
  const directory = primaryMemoryDirectory(home);
  if (!directory) return { status: 'skip', detail: 'MEMORY.md が見つからない' };
  const file = path.join(directory, 'MEMORY.md');
  const bytes = fs.statSync(file).size;
  return bytes > limitBytes
    ? { status: 'fail', detail: `${file}: ${bytes} bytes（上限 ${limitBytes} bytes）` }
    : { status: 'pass', detail: `${bytes} bytes（上限 ${limitBytes} bytes）${othersNote(home, directory)}` };
}

export function checkClaudeMdNoCurrentDate({ home, repoRoot, now }) {
  const file = path.resolve(home, '.claude', 'CLAUDE.md');
  const body = optionalRead(file);
  if (body === null) return { status: 'skip', detail: 'CLAUDE.md が見つからない' };
  const date = now.toISOString().slice(0, 10);
  return body.includes(date)
    ? { status: 'fail', detail: `${file}: 今日のUTC日付 ${date} を含む` }
    : { status: 'pass', detail: `${file}: 今日のUTC日付 ${date} を含まない` };
}

// Read only the required block-style YAML fields; no external YAML dependency.
function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.lastIndexOf(quote);
    return end > 0 ? trimmed.slice(1, end).trim() : '';
  }
  const plain = trimmed.replace(/\s+#.*$/, '').trim();
  return /^(?:#.*|null|~)?$/i.test(plain) ? '' : plain;
}

function field(lines, key, indent = 0) {
  const start = lines.findIndex((line) => line.startsWith(`${' '.repeat(indent)}${key}:`));
  if (start < 0) return '';
  const value = scalar(lines[start].slice(indent + key.length + 1));
  if (!/^[|>][+-]?\d?$/.test(value)) return value;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line.trim());
  }
  return body.join(' ').trim();
}

export function checkMemoryFrontmatter({ home, repoRoot, now }, { allowedTypes }) {
  const primary = primaryMemoryDirectory(home);
  const directories = primary ? [primary] : [];
  let checked = 0;
  const violations = [];
  for (const directory of directories) {
    for (const item of entries(directory)) {
      if (!item.isFile() || !item.name.endsWith('.md') || item.name === 'MEMORY.md') continue;
      const file = path.join(directory, item.name);
      const lines = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
      if (!/^---\s*$/.test(lines[0])) continue;
      checked++;
      const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
      const block = end < 0 ? [] : lines.slice(1, end);
      const metadata = block.findIndex((line) => /^metadata:\s*(?:#.*)?$/.test(line));
      const children = [];
      if (metadata >= 0) {
        for (const line of block.slice(metadata + 1)) {
          if (line.trim() && !/^\s/.test(line) && !/^#/.test(line)) break;
          if (line.trim() && !/^\s*#/.test(line)) children.push(line);
        }
      }
      const indent = children.length ? Math.min(...children.map((line) => line.search(/\S/))) : 0;
      const type = field(children, 'type', indent);
      const reasons = [];
      if (end < 0) reasons.push('frontmatter が閉じられていない');
      if (!field(block, 'name')) reasons.push('name が空または欠落');
      if (!field(block, 'description')) reasons.push('description が空または欠落');
      if (!type || !allowedTypes.includes(type)) reasons.push('metadata.type が欠落または許可されていない');
      if (reasons.length) violations.push(`${file}: ${reasons.join(', ')}`);
    }
  }
  if (!checked) return { status: 'skip', detail: 'frontmatter を持つ対象ファイルが見つからない' };
  return violations.length ? { status: 'fail', detail: violations.join(' / ') }
    : { status: 'pass', detail: `${checked} 件の frontmatter を検査` };
}

export function checkMemoryDomainIndexPresent({ home, repoRoot, now }) {
  const directory = primaryMemoryDirectory(home);
  if (!directory) return { status: 'skip', detail: 'memory ディレクトリが見つからない' };
  const present = entries(path.join(directory, 'index')).some((item) => item.isFile() && item.name.endsWith('.md'));
  return present ? { status: 'pass', detail: `${directory}: index/*.md が存在${othersNote(home, directory)}` }
    : { status: 'fail', detail: `${directory}: index/*.md が見つからない（tools/memory-index-split.mjs --apply で分割する）` };
}

export function checkDocInSync({ home, repoRoot, now }) {
  const actual = optionalRead(docPath(repoRoot));
  return actual === renderDoc(loadCatalog(repoRoot))
    ? { status: 'pass', detail: 'docs/prompt-memory-optimization.md は生成内容と一致' }
    : { status: 'fail', detail: `docs/prompt-memory-optimization.md ${actual === null ? 'が見つからない' : 'が古い'}（--write で再生成）` };
}

const checks = {
  'memory-index-byte-cap': checkMemoryIndexByteCap,
  'claude-md-no-current-date': checkClaudeMdNoCurrentDate,
  'memory-frontmatter': checkMemoryFrontmatter,
  'memory-domain-index-present': checkMemoryDomainIndexPresent,
};

export function checkGuidelines(context) {
  const results = [{ id: 'doc-in-sync', ...checkDocInSync(context) }];
  for (const rule of loadCatalog(context.repoRoot).rules) {
    const result = !rule.check ? { status: 'skip', detail: '手動（規範）' }
      : checks[rule.check.type]?.(context, rule.check)
        ?? { status: 'fail', detail: `未知の検査: ${rule.check.type}` };
    results.push({ id: rule.id, ...result });
  }
  const violations = results.filter((result) => result.status === 'fail').map((result) => `${result.id}: ${result.detail}`);
  return { generatedAt: context.now.toISOString(), docInSync: results[0].status === 'pass', results, violations, ok: violations.length === 0 };
}

const usage = 'usage: node tools/prompt-memory-guideline.mjs --check [--home <dir>] [--repo <dir>] [--json]\n       node tools/prompt-memory-guideline.mjs --write [--repo <dir>]\n       node tools/prompt-memory-guideline.mjs --list';

export function main(args = process.argv.slice(2)) {
  const options = { home: os.homedir(), repoRoot: defaultRepo, json: false };
  let mode;
  let hasHome = false;
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (['--check', '--write', '--list'].includes(arg)) {
        if (mode) throw new Error('検査モードは1つだけ指定してください');
        mode = arg;
      } else if (arg === '--json') options.json = true;
      else if (arg === '--home' || arg === '--repo') {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} にディレクトリが必要です`);
        options[arg === '--home' ? 'home' : 'repoRoot'] = path.resolve(value);
        if (arg === '--home') hasHome = true;
      } else throw new Error(`未知の引数: ${arg}`);
    }
    if (!mode || ((options.json || hasHome) && mode !== '--check')) throw new Error('引数の組み合わせが不正です');
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  try {
    if (mode === '--write') {
      const doc = renderDoc(loadCatalog(options.repoRoot));
      fs.mkdirSync(path.dirname(docPath(options.repoRoot)), { recursive: true });
      fs.writeFileSync(docPath(options.repoRoot), doc, 'utf8');
      console.log(`wrote docs/prompt-memory-optimization.md (${Buffer.byteLength(doc)} bytes)`);
    } else if (mode === '--list') {
      for (const rule of loadCatalog(options.repoRoot).rules) console.log(`${rule.id} ${rule.category} ${rule.title}`);
    } else {
      const report = checkGuidelines({ ...options, now: new Date() });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else for (const result of report.results) console.log(`${result.status.toUpperCase()} ${result.id}: ${result.detail}`);
      return report.ok ? 0 : 1;
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) process.exitCode = main();
