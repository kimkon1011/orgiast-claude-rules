import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, listItems, answerItem, markSeen, dropItem, selectContext, ingestFleetMail, isKimSeat, main, CONTEXT_LIMIT } from './kim-inbox.mjs';
import { notifyKim } from './notify-kim.mjs';
import { loadAllowlist, discordAllowed } from './lib/kim-discord-allowlist.mjs';
function seat(t, label = 'kim-PC') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-test-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), `REPORTER_LABEL=${label}`);
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ [label]: { account: label === 'kim-PC' ? 'kim@orgiast.jp' : 'test@example.test' } }));
  t.after(() => fs.rmSync(home, { force: true, recursive: true })); return home;
}
test('ask は毎回提示し回答後に消える。info は確認できるが ask は確認だけで消せない', async t => {
  const home = seat(t); const ask = await addItem(home, { kind: 'ask', text: '判断してください\n詳細', source: '試験' });
  const info = await addItem(home, { kind: 'info', text: '完了' });
  assert.match(ask.id, /^ki-\d{14}-[a-f0-9]{4}$/);
  const output = [];
  const hook = session_id => main(['--context'], { home, stdout: s => output.push(JSON.parse(s)), readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id }) });
  await hook('s1'); await hook('s1'); await hook('s2');
  assert.match(output[0].hookSpecificOutput.additionalContext, /詳細/);
  assert.doesNotMatch(output[1].hookSpecificOutput.additionalContext, /詳細/);
  assert.match(output[2].hookSpecificOutput.additionalContext, /詳細/);
  assert.equal(listItems(home).find(i => i.id === ask.id).shownCount, 3);
  assert.throws(() => markSeen(home, ask.id));
  answerItem(home, ask.id, '承認 sk-abcdefghijklmnopqr', 's2'); markSeen(home, info.id);
  await hook('s3'); assert.equal(output.length, 3);
  const answered = listItems(home).find(i => i.id === ask.id);
  assert.equal(answered.answerSession, 's2'); assert.doesNotMatch(answered.answer, /abcdefghijklmnopqr/);
  assert.throws(() => dropItem(home, ask.id, '')); dropItem(home, ask.id, '取り下げ');
});
test('非 kim 席は転送IDを保存し失敗だけをローカル表示する', async t => {
  const home = seat(t, '作業用011'); assert.equal(isKimSeat(home), false);
  const item = await addItem(home, { kind: 'ask', text: '判断', execImpl: async (node, args, opts) => {
    assert.equal(node, process.execPath); assert.equal(opts.windowsHide, true); assert.ok(args.includes('kim-PC'));
    assert.equal(fs.readFileSync(args.at(-1), 'utf8'), '判断'); return { stdout: '送信済み: mail-example\n' };
  } });
  assert.equal(item.status, 'forwarded'); assert.equal(item.forwardMailId, 'mail-example');
  const failed = await addItem(home, { text: '送信失敗', execImpl: async () => { throw new Error('通信不能'); } });
  assert.equal(failed.status, 'open'); assert.match(failed.forwardError, /通信不能/);
  const output = [];
  await main(['--context'], { home, stdout: s => output.push(s), readStdin: async () => '{"hook_event_name":"SessionStart","session_id":"s"}' });
  assert.match(output[0], /送信失敗/); assert.doesNotMatch(output[0], new RegExp(item.id));
});
test('fleet-mail は一度だけ取り込み元の from を保持して ack を同期待ちにする', async t => {
  const home = seat(t); const dir = path.join(home, '.claude/fleet-inbox'); fs.mkdirSync(dir);
  const mail = { id: 'mail-incoming', from: '作業用011', to: 'kim-PC', kind: 'note', why: '[kim-inbox:ask] 判断', body: '本文', status: 'delivered', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, `${mail.id}.json`), JSON.stringify(mail));
  assert.equal((await ingestFleetMail(home)).length, 1); assert.equal((await ingestFleetMail(home)).length, 0);
  assert.equal(listItems(home)[0].from, '作業用011');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${mail.id}.json`))).status, 'done');
  fs.unlinkSync(path.join(home, '.claude/kim-inbox/.ingested', mail.id));
  await ingestFleetMail(home); assert.equal(listItems(home).length, 1);
});
test('本文上限・秘匿・表示予算と ask 優先を守り、表示した件だけ更新する', async t => {
  const home = seat(t);
  await addItem(home, { kind: 'info', text: '先に届いた報告' });
  for (let n = 0; n < 8; n++) await addItem(home, { kind: 'ask', text: 'sk-abcdefghijklmnopqr\n' + 'あ'.repeat(5000) });
  const items = listItems(home); assert.ok(items.every(i => i.text.length <= 4000));
  const context = selectContext(items, { sessionId: 's' });
  assert.ok(context.length <= CONTEXT_LIMIT); assert.doesNotMatch(context, /abcdefghijklmnopqr/);
  assert.match(context, /■ ask/); assert.ok(items.filter(i => i.shownCount > 0).length <= 8);
  const shown = items.filter(i => i.shownCount > 0); assert.ok(shown.every(i => context.includes(i.id)));
});
test('許可リストは追加マージし壊れた正規表現では許可しない', t => {
  const home = seat(t); const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-repo-')); t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, 'config'));
  fs.writeFileSync(path.join(repoRoot, 'config/kim-discord-allowlist.json'), JSON.stringify({ entries: [{ category: '定時', pattern: '^定時' }] }));
  fs.writeFileSync(path.join(home, '.claude/kim-discord-allowlist.json'), JSON.stringify({ entries: [{ category: '壊れた', pattern: '[' }, { category: '追加', pattern: '^追加' }] }));
  assert.equal(loadAllowlist({ home, repoRoot }).length, 3);
  assert.equal(discordAllowed('追加本文', { home, repoRoot }).category, '追加');
  assert.equal(discordAllowed('未許可', { home, repoRoot }).allowed, false);
});
test('通知は fetch ゼロで台帳に ask を保存し24時間抑制も維持する', async t => {
  const home = seat(t); const options = { home, plainJa: false, fetchImpl: async () => assert.fail('Discord を呼ばない'), kind: 'ask' };
  const a = await notifyKim('自動進行が判断待ちです: 判断してください', options);
  assert.equal(a.delivered, 'session-inbox'); assert.equal(a.kind, 'ask');
  assert.equal((await notifyKim('自動進行が判断待ちです: 判断してください', options)).delivered, 'suppressed');
  assert.equal(listItems(home).length, 1);
});
test('hook は無関係なイベント・不正な入力でセッションを止めない', async t => {
  const home = seat(t); const output = [], errors = [];
  for (const raw of ['{}', 'not json']) assert.equal(await main(['--context'], { home, readStdin: async () => raw, stdout: x => output.push(x), stderr: x => errors.push(x) }), 0);
  assert.equal(output.length, 0); assert.equal(errors.length, 1);
});

test('PC ラベルが別名でも所有者が kim なら kim 席として扱う', t => {
  const home = seat(t, '別名');
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ '別名': { account: 'kim@orgiast.jp' } }));
  assert.equal(isKimSeat(home), true);
});
test('手作業依頼を ask に分類し台帳に依頼本文を残す', async t => {
  const home = seat(t);
  const result = await notifyKim('接続して確認してください', { home, plainJa: false, fetchImpl: async () => assert.fail('Discord 禁止') });
  assert.equal(result.kind, 'ask'); assert.match(listItems(home)[0].text, /接続して確認してください/);
});
test('複数プロセスの追加で上書きせず全件保存する', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const home = seat(t), file = path.join(home, '本文.txt'); fs.writeFileSync(file, '同時追加');
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url)), '--add', '--body-file', file], { env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true })));
  assert.equal(new Set(results.map(r => JSON.parse(r.stdout).id)).size, 4); assert.equal(listItems(home).length, 4);
});

test('破損・欠損フィールドのあるファイルで正常な未回収項目を隠さない', async t => {
  const home = seat(t), item = await addItem(home, { kind: 'ask', text: '有効な依頼' });
  fs.writeFileSync(path.join(home, '.claude/kim-inbox/ki-20261027000000-0000.json'), '{bad');
  fs.writeFileSync(path.join(home, '.claude/kim-inbox/ki-20261027000000-0001.json'), '{"id":"ki-20261027000000-0001"}');
  assert.deepEqual(listItems(home).map(i => i.id), [item.id]);
});

test('fleet 受信ファイルが使用中でも項目を表示でき、次回に確認を再試行する', async t => {
  const home = seat(t), dir = path.join(home, '.claude/fleet-inbox'); fs.mkdirSync(dir);
  const file = path.join(dir, 'mail-busy.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'mail-busy', from: '作業用011', to: 'kim-PC', kind: 'note', why: '[kim-inbox:ask] 判断', body: '確認が必要', status: 'delivered', createdAt: new Date().toISOString() }));
  fs.writeFileSync(`${file}.lock`, String(process.pid));
  assert.equal((await ingestFleetMail(home)).length, 1);
  assert.match(selectContext(listItems(home)), /確認が必要/);
  fs.unlinkSync(`${file}.lock`);
  await ingestFleetMail(home); assert.equal(JSON.parse(fs.readFileSync(file)).status, 'done'); assert.equal(listItems(home).length, 1);
});
