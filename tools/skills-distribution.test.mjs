import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(toolsDir);
const skillsDir = path.join(repoRoot, 'skills');

function skillDirectories() {
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readSkill(name) {
  return fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
}

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, 'YAML frontmatter がありません');
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const separator = line.indexOf(':');
    assert.notEqual(separator, -1, `frontmatter の形式が不正です: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

test('skills 配下の各ディレクトリに SKILL.md が存在する', () => {
  const missing = skillDirectories().filter((name) => !fs.existsSync(path.join(skillsDir, name, 'SKILL.md')));
  assert.deepEqual(missing, [], `SKILL.md がないディレクトリ: ${missing.join(', ')}`);
});

test('各 SKILL.md の frontmatter に name と description があり、name がディレクトリ名と一致する', () => {
  for (const name of skillDirectories()) {
    const frontmatter = parseFrontmatter(readSkill(name));
    assert.ok(frontmatter.name, `${name}: name がありません`);
    assert.ok(frontmatter.description, `${name}: description がありません`);
    assert.equal(frontmatter.name, name, `${name}: frontmatter の name がディレクトリ名と一致しません`);
  }
});

test('manifest の skills エントリが title、localTarget、実ファイルで整合する', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files.filter((file) => file.in === 'skills')) {
    const match = entry.title.match(/^(.+)\.md$/);
    assert.ok(match, `skills エントリの title が <name>.md 形式ではありません: ${entry.title}`);
    const name = match[1];
    assert.equal(entry.localTarget, `~/.claude/skills/${name}/SKILL.md`, `${entry.title}: localTarget が不整合です`);
    assert.ok(fs.existsSync(path.join(skillsDir, name, 'SKILL.md')), `${entry.title}: 対応する SKILL.md がありません`);
  }
});

test('requirements-freeze に核となる文字列がすべて含まれる', () => {
  const source = readSkill('requirements-freeze');
  for (const text of ['要件が固まるまで', '一問一答', '3案', '推奨案', '実装手順書']) {
    assert.ok(source.includes(text), `requirements-freeze に「${text}」がありません`);
  }
  assert.match(source, /user\s*の?手作業回数/, 'requirements-freeze に「user の手作業回数」がありません');
});

test('design-deck はハイブリッド企画書モデルと修正分担を固定する', () => {
  const source = readSkill('design-deck');
  for (const text of [
    '見せる資料はハイブリッド企画書モデル',
    '実写真2〜4枚',
    '見出し14字以内',
    '写真面積は40%以上',
    '写真の内容・雰囲気・構図への不満',
    '文字・数字・表・余白への不満',
    'Genspark: 写真配置の文法',
    'Canva は使わない',
  ]) {
    assert.ok(source.includes(text), `design-deck に「${text}」がありません`);
  }
});

test('design-deck pipeline は必須ファイルと7ページ型を同梱する', () => {
  const pipeline = path.join(skillsDir, 'design-deck', 'pipeline');
  for (const file of ['README.md', 'pages.example.json', 'gen-visuals.mjs', 'build.mjs', 'preview.mjs']) {
    assert.ok(fs.existsSync(path.join(pipeline, file)), `pipeline/${file} がありません`);
  }
  const pages = JSON.parse(fs.readFileSync(path.join(pipeline, 'pages.example.json'), 'utf8'));
  assert.deepEqual(pages.map((page) => page.type), ['cover', 'stats', 'visual', 'table', 'timeline', 'compare', 'perspective']);
  for (const page of pages) {
    for (const photo of page.photoSources ?? []) assert.ok(photo.startsWith('../'), `${page.id}: 写真パスが相対ではありません`);
  }
});

if (isEntry(import.meta.url)) {
  process.exitCode = 0;
}
