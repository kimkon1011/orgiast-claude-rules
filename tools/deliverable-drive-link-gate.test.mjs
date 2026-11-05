import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeDeliverableDriveLink as judge, registerDeliverableCheck } from './deliverable-drive-link-gate.mjs';
import { run } from './stop-gate-runner.mjs';
import { registerStopViolation } from './lib/stop-recheck.mjs';
import { classifyHandoff } from './past-log-search-gate.mjs';

const incident = '出勤の申し出の書面を作り、端末に送りました。\n【最終まとめ】\n① 報告\n完了\n② 確認事項\nなし\n**③ やること**\n- 今日中に、裁判所への2枚を FAX 048-839-8614 へ送ってください。\n- 明日 11/5 に、出勤の申し出を FAX 048-643-5793 へ送ってください。';
const links = '\nhttps://drive.google.com/file/d/a/view?authuser=x@example.com\nhttps://docs.google.com/document/d/b/edit?authuser=x@example.com';
const toolUses = [{ name: 'SendUserFile', input: { files: ['C:/Users/x/a.pdf', 'C:/Users/x/b.pdf'] } }];

test('実害文と③にURLを追加した修正版', () => {
  assert.equal(judge({ text: incident }).decision, 'block');
  const linkedIncident = incident
    .replace('048-839-8614 へ送ってください。', '048-839-8614 へ送ってください。 https://drive.google.com/file/d/a/view?authuser=x@example.com')
    .replace('048-643-5793 へ送ってください。', '048-643-5793 へ送ってください。 https://docs.google.com/document/d/b/edit?authuser=x@example.com');
  assert.equal(judge({ text: linkedIncident }).decision, 'pass');
  assert.equal(judge({ text: links + incident }).decision, 'block');
});
test('SendUserFileの異なる2ファイルには2本必要', () => {
  assert.equal(judge({ text: links.split('\n')[1], toolUses }).decision, 'block');
  assert.equal(judge({ text: links, toolUses }).decision, 'pass');
  assert.equal(judge({ text: 'C:/Users/x/a.pdf' + links, toolUses }).files.length, 2);
});
test('コードブロックと引用内の絶対パスも対象', () => {
  for (const file of ['C:\\Users\\x\\Documents\\a.pdf', 'c:/Users/x/a.xlsx', '/c/Users/x/a.png', '/mnt/c/Users/x/a.html']) {
    assert.equal(judge({ text: '```\n' + file + '\n```' }).decision, 'block');
    assert.equal(judge({ text: '「' + file + '」' }).decision, 'block');
  }
});
test('通常報告・引用・アップロード失敗証拠', () => {
  assert.equal(judge({ text: 'テストは全件成功しました。' }).decision, 'pass');
  for (const text of ['「端末に送りました」', '『添付しました』', '“チャットに送りました”', '【最終まとめ】\n③ 「PDFを提出してください」']) assert.equal(judge({ text }).decision, 'pass');
  assert.equal(judge({ text: incident + '\n[DRIVE-UPLOAD-FAILED: rclone: 403 insufficientPermissions for folder]' }).decision, 'pass');
  assert.equal(judge({ text: incident + '\n[DRIVE-UPLOAD-FAILED: failed]' }).decision, 'block');
});
test('③だけでも発火し、次の見出しのURLは数えない', () => {
  const text = '【最終まとめ】\n③ やること\nPDFを印刷してください。';
  assert.equal(judge({ text }).decision, 'block');
  assert.equal(judge({ text: text + '\n① 報告' + links }).decision, 'block');
  assert.equal(judge({ text: text + links }).decision, 'block');
  assert.equal(judge({ text: text.replace('ください。', 'ください。 https://drive.google.com/file/d/a/view') }).decision, 'pass');
});

test('②で確認してもらう成果物にも同じ単位のDrive URLが必要', () => {
  const text = `【最終まとめ】
**① 報告**
31件を移動しました。
**② kim の確認事項**
- チラシ初稿と告知画像3枚を、このまま 11/5 17:00 の打ち合わせで森田社長に見せてよいですか？
**③ kim がやること**
- 上の2つの確認事項に返信する。`;
  assert.equal(judge({ text }).decision, 'block');
  assert.equal(judge({ text: text.replace('見せてよいですか？', '見せてよいですか？ https://drive.google.com/file/d/example/view') }).decision, 'pass');
});

test('対象外の報告と成果物を参照しない返信は通す', () => {
  assert.equal(judge({ text: '【最終まとめ】\n① 報告\n- チラシを保存しました。\n② 確認事項\nなし\n③ やること\nなし' }).decision, 'pass');
  assert.equal(judge({ text: '【最終まとめ】\n② 確認事項\n- 日程は明日でよいですか？\n③ やること\n- 上の2つの確認事項に返信する。' }).decision, 'pass');
});

test('runner: reply-only・既存cap後でも3回blockし、4回目は専用cap', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-test-'));
  const previous = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const text = '端末に送りました。\n次に kim がすること: 返信してください';
  assert.equal(classifyHandoff(text), 'reply-only');
  const input = { session_id: 'deliverable', assistant_text: text };
  for (let i = 0; i < 6; i++) registerStopViolation({ input, assistantText: text, blockedBy: ['other'], home });
  for (let i = 0; i < 3; i++) {
    const result = await run(input, { raw: '', assistantText: text });
    assert.equal(result.decision, 'block');
    assert.deepEqual(result.record.blockedBy, ['deliverable-drive-link-gate']);
  }
  const capped = await run(input, { raw: '', assistantText: text });
  assert.equal(capped.decision, undefined);
  assert.equal(capped.record.verdict, 'pass_cap');
  assert.match(capped.systemMessage, /3回書き直しても Drive URL がありません/);
  const ledger = fs.readFileSync(path.join(home, '.claude/stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.at(-1).verdict, 'deliverable-cap');
  const raw = [
    { type: 'user', message: { role: 'user', content: 'ファイルを作成' } },
    { type: 'assistant', message: { role: 'assistant', content: toolUses.map(tool => ({ type: 'tool_use', ...tool })) } },
  ].map(JSON.stringify).join('\n');
  const toolResult = await run({ session_id: 'tools', assistant_text: links.split('\n')[1] }, { raw });
  assert.equal(toolResult.decision, 'block');
});

test('専用カウントは合格でリセットし、別セッションへ持ち越さない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverable-streak-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const check = (sessionId, blocked) => registerDeliverableCheck({ home, sessionId, blocked });
  assert.equal(check('a', true).count, 1);
  assert.equal(check('a', true).count, 2);
  assert.equal(check('b', true).count, 1);
  assert.equal(check('a', false).count, 0);
  assert.equal(check('a', true).count, 1);
});
