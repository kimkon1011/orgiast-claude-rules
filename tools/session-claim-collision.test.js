import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./session-claim-collision.mjs', import.meta.url));
const selfId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-claim-collision-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  return { root, projects };
}

function write(projects, slug, sessionId, entries) {
  const dir = path.join(projects, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return file;
}

function assistant(purpose) {
  return { type: 'assistant', message: { content: [{ type: 'text', text: `**[本セッションの目的]** ${purpose}\n\n作業を開始します。` }] } };
}

function run(projects) {
  return spawnSync(process.execPath, [script], {
    cwd: projects,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: selfId }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_SESSION_ID: '', CLAUDE_PROJECTS_DIR: projects },
  });
}

function runWithEvent(projects, home, event) {
  return spawnSync(process.execPath, [script], {
    cwd: projects,
    input: JSON.stringify({ hook_event_name: event, session_id: selfId }), encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, CLAUDE_SESSION_ID: '', CLAUDE_PROJECTS_DIR: projects },
  });
}

test('assistant行の同等な制作シート目的は相手sessionId付きで警告する', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug-a', selfId, [
    assistant('keyserve の暗号鍵ローテーションを実施する'),
    assistant('aujust 営業アプリ: 案件詳細の「制作シートに追加」で デザイナー様用/ディレクター様用シートへ行追加を実装する'),
  ]);
  const other = write(f.projects, 'slug-b', otherId, [
    assistant('keyserve の暗号鍵ローテーションを実施する'),
    assistant('keyserve の暗号鍵ローテーションを実施する **[本セッションの目的]** aujust の案件詳細からデザイナー様用とディレクター様用の制作シートに行を追加できるようにする'),
  ]);
  fs.appendFileSync(other, '{broken json\n');
  const result = run(f.projects); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /着手衝突の疑い/);
  assert.match(output.hookSpecificOutput.additionalContext, /22222222/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /11111111|keyserve|作業を開始/);
});

test('無関係な目的なら静かに終了する', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', selfId, [assistant('aujust 制作シート同期を修正する')]);
  write(f.projects, 'slug', otherId, [
    assistant('aujust 制作シート同期を修正する'),
    { type: 'assistant', message: { content: '**[本セッションの目的]** keyserve の暗号鍵ローテーションを実施する\naujust 制作シート同期を修正する' } },
  ]);
  const result = run(f.projects); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
});

test('同等でもmtimeが3日前なら静かに終了する', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', selfId, [assistant('aujust 制作シート同期を修正する')]);
  const other = write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); fs.utimesSync(other, old, old);
  const result = run(f.projects); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
});

test('user行だけの目的宣言は拾わない', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', selfId, [assistant('aujust 制作シート同期を修正する')]);
  const declaration = '**[本セッションの目的]** aujust 制作シート同期を修正する';
  write(f.projects, 'slug', otherId, [
    { type: 'user', message: { content: declaration } },
    { type: 'user', message: { content: [{ type: 'text', text: declaration }] } },
    { type: 'system', content: declaration, additionalContext: declaration },
    { type: 'assistant', additionalContext: declaration, message: { content: [
      { type: 'thinking', thinking: declaration },
      { type: 'tool_use', name: 'example', input: { text: declaration } },
    ] } },
  ]);
  const result = run(f.projects); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
});

test('自セッションの目的宣言がなく他セッションも居なければ静かにexit 0', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const absent = run(f.projects); assert.equal(absent.status, 0, absent.stderr); assert.equal(absent.stdout, '');
  for (const entries of [
    [{ type: 'assistant', message: { content: [{ type: 'text', text: '目的宣言なし' }] } }],
    [{ type: 'user', message: { content: '**[本セッションの目的]** aujust 制作シート同期を修正する' } }],
    [assistant('aujust 制作シート同期を修正する'), assistant('同期')],
    [assistant('aujust 制作シート同期を修正する'), assistant('<目的> aujust 制作シート同期を修正する')],
  ]) {
    write(f.projects, 'slug', selfId, entries);
    const result = run(f.projects); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '', JSON.stringify(entries));
  }
});

test('PreToolUseは初回に衝突を警告してlatchを書く', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', selfId, [assistant('aujust 制作シート同期を修正する')]);
  write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const result = runWithEvent(f.projects, f.root, 'PreToolUse');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /22222222/);
  assert.equal(fs.existsSync(path.join(f.root, '.claude', 'session-claim-collision', `${selfId}.checked`)), true);
});

test('2回目のPreToolUseはlatchにより無音', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', selfId, [assistant('aujust 制作シート同期を修正する')]);
  write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const first = runWithEvent(f.projects, f.root, 'PreToolUse');
  assert.notEqual(first.stdout, '');
  const second = runWithEvent(f.projects, f.root, 'PreToolUse');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '');
});

test('目的宣言前のPreToolUseはlatchを書かず宣言後に再試行する', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', selfId, [{ type: 'assistant', message: { content: '目的宣言なし' } }]);
  write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const latch = path.join(f.root, '.claude', 'session-claim-collision', `${selfId}.checked`);
  const before = runWithEvent(f.projects, f.root, 'PreToolUse');
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.stdout, '');
  assert.equal(fs.existsSync(latch), false);
  write(f.projects, 'slug', selfId, [assistant('aujust 制作シート同期を修正する')]);
  const after = runWithEvent(f.projects, f.root, 'PreToolUse');
  assert.equal(after.status, 0, after.stderr);
  assert.match(JSON.parse(after.stdout).hookSpecificOutput.additionalContext, /22222222/);
});

test('SessionStartとUserPromptSubmitはPreToolUseのlatchを見ない', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', selfId, [assistant('aujust 制作シート同期を修正する')]);
  write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const preToolUse = runWithEvent(f.projects, f.root, 'PreToolUse');
  assert.notEqual(preToolUse.stdout, '');
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const result = runWithEvent(f.projects, f.root, event);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, event);
  }
});

test('T1 SessionStart・自分の宣言なし・目的を宣言した peer が1件稼働中', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const result = run(f.projects);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(otherId.slice(0, 8)));
  assert.match(output.hookSpecificOutput.additionalContext, /aujust 制作シート同期を修正する/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /着手衝突の疑い/);
});

test('T2 SessionStart・自分の宣言なし・peer が0件', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = run(f.projects);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('T3 SessionStart・自分の宣言なし・peer は居るが mtime が 9 時間前', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const other = write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const old = new Date(Date.now() - 9 * 60 * 60 * 1000);
  fs.utimesSync(other, old, old);
  const result = run(f.projects);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('T4 PreToolUse・自分の宣言なし・目的を宣言した peer が1件稼働中', (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.projects, 'slug', otherId, [assistant('aujust 制作シート同期を修正する')]);
  const result = runWithEvent(f.projects, f.root, 'PreToolUse');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const latch = path.join(f.root, '.claude', 'session-claim-collision', `${selfId}.checked`);
  assert.equal(fs.existsSync(latch), false);
});
