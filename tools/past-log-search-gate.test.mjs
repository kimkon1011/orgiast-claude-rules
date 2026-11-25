import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyHandoff, evaluatePastLogSearch, extractAppNames, turnToolUses } from './past-log-search-gate.mjs';
const text = '1. MacroDroid を開いてタップしてください。\n2. MacroDroid に入力してください。\n3. 保存してください。';
const human = content => ({ type: 'user', message: { content } });
const use = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const raw = entries => entries.map(JSON.stringify).join('\n');
const search = use('Grep', { pattern: 'MacroDroid', path: 'C:\\Users\\x\\.claude\\projects' });
const judge = entries => evaluatePastLogSearch({ text, transcriptRaw: raw(entries) });
test('今ターンの検索と前ターンの検索を区別する', () => {
  assert.match(judge([human('相談'), use('Read', { file_path: '/tmp/code' })]).reason, /MacroDroid で過去ログを検索してから書き直せ/);
  assert.equal(judge([human('相談'), search]).decision, 'pass');
  assert.equal(judge([human('相談'), use('Skill', { skill: 'find-session', args: 'MacroDroid WeChat' })]).decision, 'pass');
  assert.equal(judge([human('前'), search, human('今')]).decision, 'block');
});
test('返信・完了・理由付き免除・アプリ不明は通す', () => {
  for (const [body, kind] of [['どちらにするか一言返信してください。', 'reply-only'], ['PR をマージしました。テスト 12 件成功。', 'none']]) {
    assert.equal(classifyHandoff(body), kind); assert.equal(evaluatePastLogSearch({ text: body }).decision, 'pass');
  }
  assert.equal(evaluatePastLogSearch({ text: `${text}\n[PASTLOG-OK] 新規アプリのため` }).code, 'PASTLOG-OK');
  assert.equal(evaluatePastLogSearch({ text: 'ボタンを押してください。' }).reason, 'app-unknown');
  assert.equal(evaluatePastLogSearch({ text: `${text}\n[PASTLOG-OK]   ` }).decision, 'block');
});
test('画像のみの発言で区切り、機械発言とsidechainは区切らない', () => {
  assert.equal(judge([search, human([{ type: 'image', source: {} }])]).decision, 'block');
  assert.equal(judge([human([{ type: 'image' }]), search]).decision, 'pass');
  assert.equal(judge([human('[Image: photo]'), search, human('<system-reminder>注入')]).decision, 'pass');
  assert.deepEqual(turnToolUses(raw([human('今'), { ...search, isSidechain: true }])), []);
});
test('playbook注入は直前5エントリのattachmentと今ターンを対象にする', () => {
  const attachment = { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['[PLAYBOOK:MacroDroid] 実測'] } };
  assert.equal(judge([human('今'), attachment]).decision, 'pass');
  assert.equal(judge([attachment, human('今')]).decision, 'pass');
  assert.equal(judge([attachment, ...Array(5).fill({ type: 'system' }), human('今')]).decision, 'block');
  assert.equal(judge([human('[PLAYBOOK:MacroDroid] 前'), human('今')]).decision, 'block');
  assert.equal(judge([human('今'), use('Read', { file_path: 'C:\\Users\\x\\.claude\\playbooks\\MacroDroid.md' })]).decision, 'pass');
});
test('分類は引用とコードを除き番号付き操作と次の操作を認識する', () => {
  assert.equal(classifyHandoff('```\nクリックしてください\n```\n> 押してください\n~~~\n入力してください\n~~~'), 'none');
  assert.equal(classifyHandoff('① 開く\n② 押す'), 'manual-steps');
  assert.equal(classifyHandoff('次に kim がすること: アプリを開く'), 'manual-steps');
  assert.equal(classifyHandoff('次に kim がすること: なし（開く必要なし）'), 'none');
});
test('製品名の境界・独自名・重複を検査する', () => {
  // Codex/Windows/PowerShell 等の汎用基盤は過去ログ検索を強制しても意味が無いので辞書から外した。部分一致(knowledge→Edge)も防ぐ。
  assert.deepEqual(extractAppNames('LINEAR XYZ Vercel knowledge Windows PowerShell'), ['Vercel']);
  assert.deepEqual(extractAppNames('X で LINE を使う'), ['LINE', 'X']);
  assert.deepEqual(extractAppNames('**Widget App** を開く', { humanText: 'Widget App', playbookNames: ['Widget App'] }), ['Widget App']);
});
test('Stopのstdinと一時JSONLでblockし再入とsubagentsは無視する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'past-log-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript_path = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript_path, raw([human('MacroDroid'), { type: 'assistant', message: { content: text } }]));
  const run = extra => spawnSync(process.execPath, ['tools/past-log-search-gate.mjs'], { encoding: 'utf8', input: JSON.stringify({ transcript_path, ...extra }), env: { ...process.env, ORGIAST_HOME: home } });
  assert.equal(JSON.parse(run({}).stdout).decision, 'block');
  assert.equal(run({ stop_hook_active: true }).stdout, '');
  assert.equal(run({ transcript_path: 'subagents/t.jsonl' }).stdout, '');
});
