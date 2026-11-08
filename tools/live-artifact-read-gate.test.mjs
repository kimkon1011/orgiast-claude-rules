import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractArtifacts, extractShellBody, findUnreadIds, GMAIL_WRITE_ACTIONS, HOOK_MATCHER, judge, overrideActive, SHELL_TOOLS, TARGET } from './live-artifact-read-gate.mjs';

const script = fileURLToPath(new URL('./live-artifact-read-gate.mjs', import.meta.url));
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;
const HOUR = 60 * 60 * 1000;

function homeFor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'live-artifact-'));
  fs.mkdirSync(path.join(home, '.claude'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function transcriptFor(t, lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-artifact-tx-')), 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return file;
}
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const toolUse = (name, input, msAgo) => ({ timestamp: at(msAgo), message: { content: [{ type: 'tool_use', name, input }] } });
const gmail = (body, transcriptPath) => ({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: { body }, transcript_path: transcriptPath });
const shell = (command, transcriptPath) => ({ tool_name: 'Bash', tool_input: { command }, transcript_path: transcriptPath });
function run(input, home) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home }, timeout: 60000 });
}

test('URL なし本文は allow', (t) => {
  const home = homeFor(t);
  const result = judge(gmail('お世話になっております。来週の打ち合わせについてご連絡します。', transcriptFor(t, [])), { home });
  assert.equal(result.decision, 'pass');
  assert.deepEqual(result.ids, []);
});

test('Sheets URL あり・transcript に何も無しは block し、メッセージに ID を出す', (t) => {
  const home = homeFor(t);
  const result = judge(gmail(`集計はこちら ${SHEET_URL} を参照してください。`, transcriptFor(t, [])), { home });
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.unread, [SHEET_ID]);
  assert.match(result.reason, /\[LIVE-ARTIFACT-READ-GATE\]/);
  assert.match(result.reason, new RegExp(SHEET_ID));
  assert.match(result.reason, /Sheets/);
});

test('直近1時間に read_file_content(fileId 一致) があれば allow', (t) => {
  const home = homeFor(t);
  const transcript = transcriptFor(t, [toolUse('mcp__claude_ai_Google_Drive__read_file_content', { fileId: SHEET_ID }, HOUR)]);
  assert.equal(judge(gmail(SHEET_URL, transcript), { home }).decision, 'pass');
});

test('直近に get_file_permissions しか無い場合は block（今回の再現）', (t) => {
  const home = homeFor(t);
  const transcript = transcriptFor(t, [
    toolUse('mcp__claude_ai_Google_Drive__get_file_permissions', { fileId: SHEET_ID }, 10 * 60 * 1000),
    toolUse('mcp__claude_ai_Google_Drive__get_file_metadata', { fileId: SHEET_ID }, 5 * 60 * 1000),
  ]);
  const result = judge(gmail(SHEET_URL, transcript), { home });
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.unread, [SHEET_ID]);
});

test('read_file_content が7時間前なら block', (t) => {
  const home = homeFor(t);
  const transcript = transcriptFor(t, [toolUse('mcp__claude_ai_Google_Drive__read_file_content', { fileId: SHEET_ID }, 7 * HOUR)]);
  assert.equal(judge(gmail(SHEET_URL, transcript), { home }).decision, 'block');
});

test('直近に Agent の prompt へ ID を含めていれば allow', (t) => {
  const home = homeFor(t);
  const transcript = transcriptFor(t, [toolUse('Agent', { prompt: `このシート ${SHEET_URL} のタブ構成を読んで要約して` }, 30 * 60 * 1000)]);
  assert.equal(judge(gmail(SHEET_URL, transcript), { home }).decision, 'pass');
});

test('/a/orgiast.jp/ 入り URL でも ID を抽出できる', () => {
  const id = '1ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLlKkJjHh';
  const url = `https://docs.google.com/a/orgiast.jp/spreadsheets/d/${id}/edit`;
  assert.deepEqual(extractArtifacts(url), [{ id, kind: 'spreadsheets', label: 'Sheets' }]);
});

test('Bash の gmail-draft.mjs --body-file の中身に URL があり証拠なしなら block', (t) => {
  const home = homeFor(t);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, `手順は ${SHEET_URL} にまとめました。`);
  const command = `node "C:\\repo\\tools\\gmail-draft.mjs" --to x@example.com --subject y --body-file "${bodyFile}"`;
  const result = judge(shell(command, transcriptFor(t, [])), { home });
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.unread, [SHEET_ID]);
});

test('Gmail 以外のツールは allow', (t) => {
  const home = homeFor(t);
  const input = { tool_name: 'mcp__claude_ai_Google_Drive__create_file', tool_input: { body: SHEET_URL }, transcript_path: transcriptFor(t, []) };
  assert.deepEqual(judge(input, { home }), { decision: 'pass', ids: [], unread: [] });
});

test('override ファイルが有効期限内なら allow、期限切れなら通常判定', (t) => {
  const home = homeFor(t);
  const transcript = transcriptFor(t, []);
  const overrideFile = path.join(home, '.claude', 'live-artifact-read-override');
  fs.writeFileSync(overrideFile, new Date(Date.now() + HOUR).toISOString());
  assert.equal(overrideActive(home), true);
  assert.equal(judge(gmail(SHEET_URL, transcript), { home }).decision, 'pass');
  fs.writeFileSync(overrideFile, new Date(Date.now() - HOUR).toISOString());
  assert.equal(overrideActive(home), false);
  assert.equal(judge(gmail(SHEET_URL, transcript), { home }).decision, 'block');
});

// --- 補助: 抽出・証拠判定・CLI 契約 ---
test('URL 抽出は重複を除き、drive.google.com/file/d も拾う', () => {
  const docId = '1AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRr';
  const text = `${SHEET_URL} と https://docs.google.com/document/d/${docId}/edit と https://drive.google.com/file/d/${docId}/view と ${SHEET_URL}`;
  assert.deepEqual(extractArtifacts(text), [
    { id: SHEET_ID, kind: 'spreadsheets', label: 'Sheets' },
    { id: docId, kind: 'document', label: 'Docs' },
  ]);
});

test('Bash の --body 直値も本文として扱い、gmail-draft 以外は null', () => {
  assert.equal(extractShellBody(`node gmail-draft.mjs --to x --subject y --body "本文 ${SHEET_URL}"`), `本文 ${SHEET_URL}`);
  assert.equal(extractShellBody('node other.mjs --body "x"'), null);
  assert.equal(extractShellBody('node gmail-draft.mjs --to x --subject y --body-file missing.txt', () => { throw new Error('ENOENT'); }), null);
});

test('transcript が読めない場合は allow（作業を止めない）', (t) => {
  const home = homeFor(t);
  const result = judge(gmail(SHEET_URL, path.join(home, 'nope.jsonl')), { home });
  assert.equal(result.decision, 'pass');
  assert.equal(result.transcriptUnreadable, true);
});

test('timestamp の無い行は無視し、Bash の読み出し証拠は ID と動詞が揃った時だけ有効', (t) => {
  const home = homeFor(t);
  const noTimestamp = { message: { content: [{ type: 'tool_use', name: 'mcp__claude_ai_Google_Drive__read_file_content', input: { fileId: SHEET_ID } }] } };
  assert.deepEqual(findUnreadIds(transcriptFor(t, [noTimestamp]), [SHEET_ID]), [SHEET_ID]);
  const shellRead = transcriptFor(t, [toolUse('Bash', { command: `node gdoc-export.mjs ${SHEET_ID}` }, HOUR)]);
  assert.equal(judge(gmail(SHEET_URL, shellRead), { home }).decision, 'pass');
  const shellUnrelated = transcriptFor(t, [toolUse('Bash', { command: `echo ${SHEET_ID}` }, HOUR)]);
  assert.equal(judge(gmail(SHEET_URL, shellUnrelated), { home }).decision, 'block');
});

test('guard の対象 tool 名と hook matcher が一致する', () => {
  const matcher = new RegExp(`^(?:${HOOK_MATCHER})$`);
  for (const action of GMAIL_WRITE_ACTIONS) {
    for (const account of ['', '_2', '_12']) {
      const toolName = `mcp__claude_ai_Gmail${account}__${action}`;
      assert.equal(TARGET.test(toolName), true, `TARGET: ${toolName}`);
      assert.equal(matcher.test(toolName), true, `HOOK_MATCHER: ${toolName}`);
    }
  }
  for (const toolName of ['Bash', 'PowerShell']) assert.equal(matcher.test(toolName), true, toolName);
  for (const toolName of ['mcp__claude_ai_Gmail__get_message', 'mcp__claude_ai_Google_Drive__create_file']) assert.equal(matcher.test(toolName), false, toolName);
  assert.equal(SHELL_TOOLS, 'Bash|PowerShell');
});

test('stdin→stdout は既存 PreToolUse の deny 契約、pass は無出力', (t) => {
  const home = homeFor(t);
  const blocked = run(gmail(SHEET_URL, transcriptFor(t, [])), home);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stderr, '');
  const output = JSON.parse(blocked.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /\[LIVE-ARTIFACT-READ-GATE\]/);
  for (const input of [
    gmail('URL の無い本文', transcriptFor(t, [])),
    { tool_name: 'mcp__claude_ai_Google_Drive__create_file', tool_input: { body: SHEET_URL } },
  ]) {
    const pass = run(input, home);
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(pass.stdout, '');
    assert.equal(pass.stderr, '');
  }
});

test('既存配布処理は指定 matcher・timeout で登録し、再実行で重複しない', (t) => {
  const home = homeFor(t);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(script, path.join(repo, 'tools', path.basename(script)));
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const existing = { matcher: 'Example', hooks: [{ type: 'command', command: 'node existing.mjs' }] };
  fs.writeFileSync(settingsFile, JSON.stringify({ custom: true, hooks: { PreToolUse: [existing] } }));
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./register-hooks.mjs', import.meta.url)), '--hooks-only'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo }, timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(settings.custom, true);
    assert.deepEqual(settings.hooks.PreToolUse[0], existing);
    const groups = settings.hooks.PreToolUse.filter((group) => group.hooks.some((h) => h.command.includes('live-artifact-read-gate')));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].matcher, HOOK_MATCHER);
    assert.deepEqual(groups[0].hooks, [{ type: 'command', command: `node "${path.join(repo, 'tools', path.basename(script))}"`, timeout: 30 }]);
  }
});
