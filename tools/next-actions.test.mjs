import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNextActions } from './next-actions.mjs';

const NOW = new Date('2026-09-05T03:00:00+09:00');
function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'next-actions-')); }
function put(root, rel, text) { const file = path.join(root, '.claude', rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
function gh(data = []) { return (_file, _args, _opts, cb) => cb(null, JSON.stringify(data)); }
const good = async () => ({ text: JSON.stringify({ actions: [{ title: 'PRを確認', why: '長期間未更新のため', first_step: 'gh pr view 12', source: 'PR#12' }] }) });

test('4種の入力をすべてLLMプロンプトへ渡す', async () => {
  const root = home(); put(root, 'next-session.md', '- TODOの実物'); put(root, 'logs/nightly-batch-2026-09-05.log', 'NG batch failure');
  put(root, 'logs/discord-task-digest.log', 'noise\n{"ok":true,"top":[{"id":"D1","rank":"P1","title":"至急タスク"}]}\n');
  let prompt = '';
  await runNextActions({ home: root, now: NOW, execImpl: gh([{ number: 12, title: '古いPR', updatedAt: '2026-01-01', isDraft: false }]), llm: async (req) => { prompt = req.messages[1].content; return good(); }, args: ['--dry-run'], log() {} });
  for (const value of ['古いPR', 'TODOの実物', 'NG batch failure', '至急タスク']) assert.match(prompt, new RegExp(value));
});

test('正常JSONならマーカー区間だけを置換して外側を保持する', async () => {
  const root = home(), file = put(root, 'next-actions.md', `前文\n<!-- NEXT-ACTIONS:BEGIN -->\n削除対象の旧節\n<!-- NEXT-ACTIONS:END -->\n後文\n`);
  await runNextActions({ home: root, now: NOW, execImpl: gh(), llm: good, log() {} });
  const text = fs.readFileSync(file, 'utf8'); assert.match(text, /^前文/); assert.match(text, /PRを確認/); assert.match(text, /後文\n$/); assert.doesNotMatch(text, /削除対象の旧節/);
});

test('マーカー無しなら追記し、ファイル無しなら新規作成する', async () => {
  const a = home(), existing = put(a, 'next-actions.md', '手書き本文\n'); await runNextActions({ home: a, now: NOW, execImpl: gh(), llm: good, log() {} });
  assert.match(fs.readFileSync(existing, 'utf8'), /^手書き本文[\s\S]*NEXT-ACTIONS:BEGIN/);
  const b = home(); await runNextActions({ home: b, now: NOW, execImpl: gh(), llm: good, log() {} }); assert.match(fs.readFileSync(path.join(b, '.claude', 'next-actions.md'), 'utf8'), /NEXT-ACTIONS:END/);
});

for (const [name, llm] of [['壊れたJSON', async () => ({ text: 'not json' })], ['LLM例外', async () => { throw new Error('down'); }]]) test(`${name}なら空でない機械フォールバック`, async () => {
  const root = home(); put(root, 'next-session.md', '- 残作業を行う');
  const result = await runNextActions({ home: root, now: NOW, execImpl: gh(), llm, log() {} });
  assert.ok(result.actions.length > 0 && result.actions.length <= 3); assert.equal(result.provider, 'fallback'); assert.match(result.body, /LLM未使用・機械選択/);
});

test('gh失敗でも他入力で完走する', async () => {
  const root = home(); put(root, 'next-session.md', '- 継続TODO');
  const result = await runNextActions({ home: root, now: NOW, execImpl: (_f, _a, _o, cb) => cb(new Error('ghなし')), llm: async () => { throw new Error('LLMなし'); }, log() {} });
  assert.match(result.body, /継続TODO/);
});

test('--dry-run はファイルを一切書かない', async () => {
  const root = home(), before = fs.readdirSync(root);
  await runNextActions({ home: root, now: NOW, execImpl: gh(), llm: good, args: ['--dry-run'], log() {} });
  assert.deepEqual(fs.readdirSync(root), before);
});

test('1回目が壊れたJSONでも2回目のLLM結果を採用する', async () => {
  const root = home(); let calls = 0; const systems = [];
  const result = await runNextActions({ home: root, now: NOW, execImpl: gh(), args: ['--dry-run'], log() {}, llm: async (req) => {
    systems.push(req.messages[0].content); calls++;
    if (calls === 1) return { text: '{broken', provider: 'groq' };
    return { text: JSON.stringify({ actions: [{ title: '再試行成功', why: '有効', first_step: '確認する', source: 'TODO' }] }), provider: 'deepseek' };
  } });
  assert.equal(calls, 2); assert.equal(result.provider, 'deepseek'); assert.equal(result.actions[0].title, '再試行成功');
  assert.match(systems[1], /前回の応答はJSONとして解釈できなかった/);
});

test('2回とも解析失敗ならstderrに理由を1行出してフォールバックする', async () => {
  const root = home(); put(root, 'next-session.md', '- 残作業'); const errors = [];
  const result = await runNextActions({ home: root, now: NOW, execImpl: gh(), llm: async () => ({ text: 'not json' }), log() {}, error: (line) => errors.push(line) });
  assert.equal(result.provider, 'fallback'); assert.equal(errors.length, 1);
  assert.match(errors[0], /^next-actions: LLM応答をJSONとして解釈できずフォールバック: /);
});

test('長いwhyは切り詰め、空sourceは既定値でLLM結果を採用する', async () => {
  const root = home(), why = '長'.repeat(61);
  const result = await runNextActions({ home: root, now: NOW, execImpl: gh(), log() {}, llm: async () => ({ text: JSON.stringify({ actions: [{ title: '有効な題名', why, first_step: '最初の操作', source: '' }] }) }) });
  assert.equal(result.provider, 'groq'); assert.equal([...result.actions[0].why].length, 60); assert.equal(result.actions[0].source, '入力情報');
});

test('末尾が人間向けサマリでも直前のJSONからP1を抽出する', async () => {
  const root = home(); put(root, 'logs/mail-task-digest.log', '{"ok":true,"top":[{"id":"M17","rank":"P1","title":"展示会へ至急返信"}]}\nmail-task-digest: 取得60通 / 新規17件 / P1 9件\n');
  let prompt = ''; await runNextActions({ home: root, now: NOW, execImpl: gh(), args: ['--dry-run'], log() {}, llm: async (req) => { prompt = req.messages[1].content; return good(); } });
  assert.match(prompt, /展示会へ至急返信/);
});

test('サマリ行と成功カウンタを夜間異常に含めない', async () => {
  const root = home(); put(root, 'logs/nightly-batch-2026-09-05.log', [
    '2026-09-05 03:04:38 / サマリ / nightly-batch 完了: nightly-batch=ok:開始, error=2',
    '同期完了 error=0', '処理完了 error=-', '集計 失敗0', 'queue dead=0', '判定 NG:0',
    '実処理 error=Drive API timeout',
  ].join('\n'));
  let prompt = ''; await runNextActions({ home: root, now: NOW, execImpl: gh(), args: ['--dry-run'], log() {}, llm: async (req) => { prompt = req.messages[1].content; return good(); } });
  assert.match(prompt, /実処理 error=Drive API timeout/); assert.doesNotMatch(prompt, /サマリ|error=0|error=-|失敗0|dead=0|NG:0/);
});

test('フォールバックはtitleを重複排除し異なるsourceを優先する', async () => {
  const root = home(); put(root, 'logs/nightly-batch-2026-09-05.log', 'step-a error=boom\nstep-b NG detected'); put(root, 'next-session.md', '- 次のTODO');
  put(root, 'logs/discord-task-digest.log', '{"top":[{"id":"D1","rank":"P1","title":"至急タスク"}]}\nsummary');
  const result = await runNextActions({ home: root, now: NOW, execImpl: gh([{ number: 12, title: '古いPR', updatedAt: '2026-01-01', isDraft: false }]), llm: async () => { throw new Error('down'); }, log() {}, error() {} });
  assert.equal(new Set(result.actions.map((a) => a.title)).size, result.actions.length);
  assert.equal(new Set(result.actions.map((a) => a.source)).size, result.actions.length);
});

test('実書き込み経路でもマーカー外の既存本文を保持する', async () => {
  const root = home(), file = put(root, 'next-actions.md', '利用者の前文\n<!-- NEXT-ACTIONS:BEGIN -->\n旧自動節\n<!-- NEXT-ACTIONS:END -->\n利用者の後文\n');
  await runNextActions({ home: root, now: NOW, execImpl: gh(), llm: good, log() {} });
  const actual = fs.readFileSync(file, 'utf8'); assert.match(actual, /^利用者の前文/); assert.match(actual, /利用者の後文\n$/); assert.doesNotMatch(actual, /旧自動節/);
});

function ghPrStates(prs, states, views) {
  return (file, args, opts, cb) => {
    assert.equal(file, 'gh');
    assert.equal(opts.encoding, 'utf8');
    if (args[0] === 'pr' && args[1] === 'list') return cb(null, JSON.stringify(prs));
    assert.deepEqual(args, ['pr', 'view', args[2], '--repo', 'kimkon1011/orgiast-claude-rules', '--json', 'number,state']);
    const number = Number(args[2]);
    views.push(number);
    assert.ok(Object.hasOwn(states, number), `想定外のPR照会: ${number}`);
    const state = states[number];
    if (state instanceof Error) return cb(state);
    cb(null, JSON.stringify({ number, state }));
  };
}
function llmActions(actions) { return async () => ({ text: JSON.stringify({ actions }) }); }
function action(title, source) { return { title, why: '確認が必要', first_step: '詳細を確認する', source }; }

test('MERGEDのPRを参照するLLMアクションは除外される', async () => {
  const views = [], logs = [];
  const todo = action('作業 #5 を確認', 'TODO');
  const result = await runNextActions({
    home: home(), now: NOW, execImpl: ghPrStates([{ number: 12 }], { 297: 'MERGED' }, views),
    llm: llmActions([action('マージを確認', 'PR#297'), todo]), log: (line) => logs.push(line)
  });
  assert.deepEqual(result.actions, [todo]);
  assert.doesNotMatch(result.body, /297/);
  assert.doesNotMatch(fs.readFileSync(result.outputFile, 'utf8'), /297/);
  assert.deepEqual(views, [297]);
  assert.equal(logs.filter((line) => line === 'next-actions: PR#297 はMERGEDのため除外').length, 1);
});

test('open一覧にいるPRは再照会しない', async () => {
  const views = [], candidate = action('PR#12 を確認', 'PR#12');
  const result = await runNextActions({
    home: home(), now: NOW, execImpl: ghPrStates([{ number: 12 }], {}, views),
    llm: llmActions([candidate]), args: ['--dry-run'], log() {}
  });
  assert.deepEqual(result.actions, [candidate]);
  assert.equal(views.length, 0);
});

test('pr viewが失敗したら除外せず同じPRのエラーもキャッシュする', async () => {
  const views = [], candidates = [action('PR297 を確認', 'PR#297'), action('関連作業', 'PR #297')];
  const result = await runNextActions({
    home: home(), now: NOW, execImpl: ghPrStates([], { 297: new Error('gh unavailable') }, views),
    llm: llmActions(candidates), args: ['--dry-run'], log() {}
  });
  assert.deepEqual(result.actions, candidates);
  assert.deepEqual(views, [297]);
});

test('フォールバックのTODO由来も同じフィルタが効く', async () => {
  const root = home(), views = [], logs = [];
  put(root, 'next-session.md', '- Review & merge PR #297 (stop alarms)\n- 継続TODOを確認');
  const result = await runNextActions({
    home: root, now: NOW, execImpl: ghPrStates([{ number: 12, title: '未処理PR' }], { 297: 'CLOSED' }, views),
    llm: async () => { throw new Error('LLM unavailable'); }, log: (line) => logs.push(line), error() {}
  });
  assert.equal(result.provider, 'fallback');
  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.actions.map((a) => a.source), ['PR#12', 'TODO']);
  assert.match(result.body, /継続TODOを確認/);
  assert.doesNotMatch(result.body, /297/);
  assert.deepEqual(views, [297]);
  assert.ok(logs.includes('next-actions: PR#297 はCLOSEDのため除外'));
});

test('全滅したら既定アクション1件を出す', async () => {
  const views = [];
  const result = await runNextActions({
    home: home(), now: NOW, execImpl: ghPrStates([], { 297: 'MERGED' }, views),
    llm: llmActions([action('PRを処理', 'PR#297')]), log() {}
  });
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0], {
    title: '新しい依頼と未処理事項を確認',
    why: '候補が処理済みだったため（LLM未使用・機械選択）',
    first_step: 'PR一覧と next-session.md を確認する',
    source: 'TODO'
  });
  assert.match(fs.readFileSync(result.outputFile, 'utf8'), /新しい依頼と未処理事項を確認/);
  assert.deepEqual(views, [297]);
});
