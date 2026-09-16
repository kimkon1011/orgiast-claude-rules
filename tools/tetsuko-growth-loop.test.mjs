#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicAppend,
  atomicWrite,
  buildBriefing,
  buildCodeCheckItems,
  chooseCategory,
  CATEGORIES,
  commitAndPush,
  extractBriefBullet,
  extractPastCategoryLabels,
  extractPastTags,
  localDate,
  nextCycleNumber,
  splitDraftItems,
} from './tetsuko-growth-loop.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tetsuko-growth-test-'));
}

test('nextCycleNumber: 見出しと累計行の両方から最大値+1を取る', () => {
  const log = '## 2026-09-02 サイクル#1\n本文\n(累計提案サイクル数: 1)\n\n## 2026-09-03 サイクル#2\n本文\n(累計提案サイクル数: 2)\n';
  assert.equal(nextCycleNumber(log), 3);
});

test('nextCycleNumber: 空ログは1を返す', () => {
  assert.equal(nextCycleNumber(''), 1);
});

test('nextCycleNumber: 見出しと累計行がズレていても大きい方を採用する(重複採番防止)', () => {
  const log = '## x サイクル#5\n(累計提案サイクル数: 3)\n';
  assert.equal(nextCycleNumber(log), 6);
});

test('extractPastTags: 【】タグを重複排除して抽出する', () => {
  const log = '1. **【Amazon・CVR】施策A**\n2. **【Amazon・CVR】施策A再掲**\n3. **【自社サイト・SEO】施策B**\n';
  assert.deepEqual(extractPastTags(log), ['Amazon・CVR', '自社サイト・SEO']);
});

test('extractPastCategoryLabels: 対象:行を直近N件だけ返す', () => {
  const log = '対象: 1回目\n本文\n対象: 2回目\n本文\n対象: 3回目\n本文\n対象: 4回目\n';
  assert.deepEqual(extractPastCategoryLabels(log, 2), ['対象: 3回目', '対象: 4回目']);
});

test('chooseCategory: サイクル番号でローテーションする', () => {
  assert.equal(chooseCategory(1, []).key, CATEGORIES[0].key);
  assert.equal(chooseCategory(2, []).key, CATEGORIES[1].key);
  assert.equal(chooseCategory(6, []).key, CATEGORIES[0].key); // 1周して戻る
});

test('chooseCategory: 直近で使われたカテゴリは避けて次に進める', () => {
  const recent = [`対象: 今回は「${CATEGORIES[1].label}」の切り口でローテーションする。`];
  const chosen = chooseCategory(2, recent); // 通常なら index1=cvr_trustだが直近に含まれるため回避
  assert.notEqual(chosen.label, CATEGORIES[1].label);
});

test('splitDraftItems: 規定フォーマットのブロックのみ有効と判定する', () => {
  const text = [
    '**【技術基盤・計測】OGP追加**',
    '   - 根拠: テスト根拠',
    '   - 期待効果(定量目安・仮): テスト',
    '   - 実行難易度: 低',
    '   - 担当区分: Codex実装',
    '**【壊れた項目】見出しだけで本文が無い**',
  ].join('\n');
  const items = splitDraftItems(text);
  assert.equal(items.length, 1);
  assert.match(items[0], /OGP追加/);
});

test('splitDraftItems: 空文字は空配列', () => {
  assert.deepEqual(splitDraftItems(''), []);
  assert.deepEqual(splitDraftItems(null), []);
});

test('extractBriefBullet: タグ・タイトル・担当区分を短く抽出する', () => {
  const block = [
    '1. **【Amazon・出荷体制】規格品はFBA、特注サイズ切断品は自社出荷(FBM)の併用体制を検討する非常に長いタイトルのテスト文言でトリミングされることを確認する**',
    '   - 根拠: x',
    '   - 期待効果(定量目安・仮): x',
    '   - 実行難易度: 低',
    '   - 担当区分: kim承認要 + 東邦鋼業側確認要。',
  ].join('\n');
  const bullet = extractBriefBullet(block);
  assert.match(bullet, /^\*\*【Amazon・出荷体制】\*\*/);
  assert.match(bullet, /…/); // 長いタイトルは省略される
  assert.match(bullet, /kim承認要 \+ 東邦鋼業側確認要/);
});

test('buildBriefing: 件数・番号・目標表を正しく組み立てる', () => {
  const itemBlocks = [
    ['1. **【A】title1**', '   - 根拠: x', '   - 期待効果(定量目安・仮): x', '   - 実行難易度: 低', '   - 担当区分: Codex実装'].join('\n'),
  ];
  const briefing = buildBriefing({ previousBriefing: '', date: '2026-09-15', cycleNumber: 36, itemBlocks });
  assert.match(briefing, /更新日時: 2026-09-15（サイクル#36）/);
  assert.match(briefing, /今日の新規提案（1件）/);
  assert.match(briefing, /提案サイクル数: 36/);
});

test('buildBriefing: 直前ブリーフィングの目標表を引き継ぐ(実データ無しの捏造を避ける)', () => {
  const previous = '# x\n\n## 目標に対する現在地\n\n| 目標 | 状況 |\n|---|---|\n| 3年で売上2億円 | 特徴的な既存文言XYZ |\n\n## 累計\n';
  const briefing = buildBriefing({ previousBriefing: previous, date: '2026-09-15', cycleNumber: 36, itemBlocks: [] });
  assert.match(briefing, /特徴的な既存文言XYZ/);
});

test('atomicWrite/atomicAppend: 既存内容を保持したまま追記する', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'sub', 'log.md');
    atomicWrite(file, '既存の1行目\n');
    atomicAppend(file, '追記した2行目\n');
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /既存の1行目/);
    assert.match(content, /追記した2行目/);
    assert.equal(content.indexOf('既存の1行目') < content.indexOf('追記した2行目'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('atomicAppend: 元ファイルが無いディレクトリでも新規作成できる', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'new.md');
    atomicAppend(file, '1行目\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '1行目\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildCodeCheckItems: 未実装を確認したチェックのみ候補にする(実ファイルscan)', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'web', 'src', 'app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'web', 'src', 'app', 'catalog'), { recursive: true });
    // layout.tsx に openGraph が無い → OGP未実装として候補に挙がるはず
    fs.writeFileSync(path.join(dir, 'web', 'src', 'app', 'layout.tsx'), 'export const metadata = { title: "x" };\n');
    fs.writeFileSync(path.join(dir, 'web', 'src', 'app', 'page.tsx'), 'export default function Page(){ return <img src="a.png" />; }\n');
    const category = CATEGORIES.find((c) => c.key === 'tech_measurement');
    const items = buildCodeCheckItems(category, dir);
    assert.ok(items.some((item) => /OGP/.test(item.label)));
    assert.ok(items.some((item) => /next\/image/.test(item.label)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildCodeCheckItems: 実装済み(OGP有り)は候補から外れる', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'web', 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'web', 'src', 'app', 'layout.tsx'), 'export const metadata = { openGraph: { title: "x" } };\n');
    const category = CATEGORIES.find((c) => c.key === 'tech_measurement');
    const items = buildCodeCheckItems(category, dir);
    assert.ok(!items.some((item) => /OGP/.test(item.label)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildCodeCheckItems: amazonカテゴリはコードチェック対象が無い(実データにアクセスできないため)', () => {
  const dir = tmpDir();
  try {
    const category = CATEGORIES.find((c) => c.key === 'amazon');
    assert.deepEqual(buildCodeCheckItems(category, dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('commitAndPush: add/commit/pushを順に呼び、途中失敗で以降を止める', () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push(args[0]); return { status: args[0] === 'commit' ? 1 : 0, stdout: '', stderr: args[0] === 'commit' ? 'conflict' : '', error: null }; };
  const result = commitAndPush('C:\\fake', 36, fakeSpawn);
  assert.deepEqual(calls, ['add', 'commit']);
  assert.equal(result.ok, false);
});

test('commitAndPush: 全て成功すればokになる', () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push(args[0]); return { status: 0, stdout: '', stderr: '', error: null }; };
  const result = commitAndPush('C:\\fake', 36, fakeSpawn);
  assert.deepEqual(calls, ['add', 'commit', 'push']);
  assert.equal(result.ok, true);
});

test('localDate: YYYY-MM-DD形式を返す', () => {
  assert.equal(localDate(new Date(2026, 8, 14)), '2026-09-14');
});
