import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, listItems, answerItem, markSeen, dropItem, selectContext, ingestFleetMail, isKimSeat, main, CONTEXT_LIMIT, oneScreenSummary, autoCloseByGmail } from './kim-inbox.mjs';
import { notifyKim } from './notify-kim.mjs';
import { loadAllowlist, discordAllowed } from './lib/kim-discord-allowlist.mjs';
import { inboxDedupeKey, spoolItem, drainSpool } from './kim-inbox.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { formatInboxBrief } from './lib/kim-inbox-relay-state.mjs';
// The hook intentionally skips sdk-cli sessions; these tests exercise interactive delivery.
delete process.env.CLAUDE_CODE_ENTRYPOINT;
test('--show reads the complete original without changing delivery or inbox data', async t => {
  const home = seat(t), item = await addItem(home, { kind: 'ask', text: '資料の確認\n' + '詳細'.repeat(500) + '\n末尾' });
  const file = path.join(home, '.claude/kim-inbox', item.id + '.json');
  const before = fs.readFileSync(file, 'utf8'), output = [];
  assert.equal(await main(['--show', item.id], { home, stdout: value => output.push(value) }), 0);
  assert.equal(output[0], item.text);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(await main(['--show', 'missing'], { home, stdout: () => assert.fail('missing item'), stderr: () => {} }), 1);
});
test('mixed context has unique numbers, complete briefs, accurate omitted count and shown-only bookkeeping', async t => {
  const home = seat(t), base = await addItem(home, { text: '完了: 確認済み', priority: 'high' });
  const sessionId = 'abcdef12-current';
  const items = [
    base,
    { ...base, id: 'own', kind: 'ask', sessionId, text: '資料公開\n判断してほしいこと: 公開可否', priority: undefined },
    ...Array.from({ length: 20 }, (_, n) => ({ ...base, id: 'urgent-' + n, kind: 'ask', urgent: true, text: '確認' + n, priority: undefined })),
    { ...base, id: 'daily', dailyProgress: true, priority: undefined, text: '毎朝の進捗' },
    { ...base, id: 'deadline', kind: 'deadline', key: 'D-004', priority: undefined },
  ].map(item => ({ ...item, shownSessions: [], shownCount: 0 }));
  const context = selectContext(items, { sessionId, home });
  assert.ok(context.length <= CONTEXT_LIMIT);
  assert.match(context, /^\[kim-inbox .*最後の【受信箱】節/);
  const headers = [...context.matchAll(/^(\d+)\. .*（([^）]+)）$/gm)];
  assert.deepEqual(headers.map(m => Number(m[1])), headers.map((_, n) => n + 1));
  assert.match(context, new RegExp('ほか ' + (items.length - headers.length) + ' 件'));
  for (const item of items) {
    const header = headers.find(m => m[2] === item.id);
    assert.equal(item.shownCount, header ? 1 : 0);
    if (header) assert.ok(context.includes(formatInboxBrief(item, Number(header[1]), { home })));
  }
});

test('oversized registration brief is omitted whole and is not marked shown or daily-delivered', async t => {
  const home = seat(t), base = await addItem(home, { kind: 'ask', text: '登録してください' });
  const item = { ...base, source: 'knowledge-lock-passkey-link', dailyProgress: true,
    text: '鍵の登録\n登録リンク: https://example.com/register?register=' + 'x'.repeat(CONTEXT_LIMIT) };
  const context = selectContext([item], { sessionId: 'long', home });
  assert.ok(context.length <= CONTEXT_LIMIT);
  assert.match(context, /ほか 1 件/);
  assert.doesNotMatch(context, /https:\/\/example.com/);
  assert.equal(item.shownCount, 0);
  assert.equal(item.dailyShown, undefined);
});
function seat(t, label = 'kim-PC') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-test-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), `REPORTER_LABEL=${label}`);
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ [label]: { account: label === 'kim-PC' ? 'kim@orgiast.jp' : 'test@example.test' } }));
  t.after(() => fs.rmSync(home, { force: true, recursive: true })); return home;
}

test('同じ本文の ask は空白・改行・大文字小文字を正規化して count を増やす', async t => {
  const home = seat(t);
  const first = await addItem(home, { kind: 'ask', text: '  Approve\n\tThis  ' });
  const second = await addItem(home, { kind: 'ask', text: 'approve this' });
  assert.equal(second.id, first.id);
  const items = listItems(home);
  assert.equal(items.length, 1);
  assert.equal(items[0].count, 2);
  assert.ok(Date.parse(items[0].lastSeenAt) >= Date.parse(items[0].createdAt));
});

test('本文が異なる ask は別レコードになる', async t => {
  const home = seat(t);
  await addItem(home, { kind: 'ask', text: '承認してください A' });
  await addItem(home, { kind: 'ask', text: '承認してください B' });
  assert.equal(listItems(home).length, 2);
});

test('answer 済み ask と同じ本文は新規 open ask になる', async t => {
  const home = seat(t);
  const answered = await addItem(home, { kind: 'ask', text: '再確認してください' });
  answerItem(home, answered.id, '承認');
  const reopened = await addItem(home, { kind: 'ask', text: '再確認してください' });
  assert.notEqual(reopened.id, answered.id);
  assert.equal(listItems(home).length, 2);
  assert.equal(listItems(home, { status: 'open' }).length, 1);
});

test('info の同文集約も count と repeatCount を維持する', async t => {
  const home = seat(t);
  const first = await addItem(home, { kind: 'info', text: '完了 しました' });
  const second = await addItem(home, { kind: 'info', text: ' 完了\nしました ' });
  assert.equal(second.id, first.id);
  assert.equal(listItems(home).length, 1);
  assert.equal(listItems(home)[0].count, 2);
  assert.equal(listItems(home)[0].repeatCount, 2);
});

test('durable producer keys survive aggregation, seen state and retries', async t => {
  const home = seat(t);
  const a = await addItem(home, { text: '同じ作業 1', dedupeKey: 'job:1' });
  const b = await addItem(home, { text: '同じ作業 2', dedupeKey: 'job:2' });
  assert.notEqual(a.id, b.id);
  markSeen(home, a.id);
  const retry = await addItem(home, { text: '同じ作業 1', dedupeKey: 'job:1' });
  assert.equal(retry.id, a.id); assert.equal(retry.status, 'seen');
  const unkeyed = await addItem(home, { text: '同じ作業 3' });
  assert.notEqual(unkeyed.id, b.id); assert.equal(listItems(home).length, 3);
});

test('redacted and truncated keys retain unique identities through direct delivery and spool retries', async t => {
  const home = seat(t);
  const keys = ['a'.repeat(64), 'b'.repeat(64), 'sk-abcdefghijklmnopqr', 'sk-abcdefghijklmnopqs',
    'x:'.repeat(2100) + '1', 'x:'.repeat(2100) + '2'];
  for (const [index, key] of keys.entries()) {
    const dedupeKey = inboxDedupeKey(key);
    assert.equal(redactSecrets(dedupeKey), dedupeKey);
    assert.equal(inboxDedupeKey(dedupeKey), dedupeKey);
    assert.ok(!dedupeKey.includes(key));
    const item = await addItem(home, { text: `notice ${index}`, dedupeKey: key });
    markSeen(home, item.id);
    spoolItem(home, { text: `notice ${index}`, dedupeKey: key });
  }
  await drainSpool(home);
  assert.equal(listItems(home).length, keys.length);
  assert.ok(listItems(home).every(item => item.status === 'seen'));
});
test('ask は毎回提示し回答後に消える。info は確認できるが ask は確認だけで消せない', async t => {
  const home = seat(t); const ask = await addItem(home, { kind: 'ask', text: '判断してください\n詳細', source: '試験' });
  const info = await addItem(home, { kind: 'info', text: '完了' });
  assert.match(ask.id, /^ki-\d{14}-[a-f0-9]{4}$/);
  const output = [];
  const hook = session_id => main(['--context'], { home, stdout: s => output.push(JSON.parse(s)), readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id }) });
  await hook('s1'); await hook('s1'); await hook('s2');
  assert.match(output[0].hookSpecificOutput.additionalContext, /判断してください/);
  assert.match(output[1].hookSpecificOutput.additionalContext, /判断してください/);
  assert.match(output[2].hookSpecificOutput.additionalContext, /判断してください/);
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
  assert.ok(items.some(i => context.includes(i.id)), 'items should appear in context'); assert.ok(items.filter(i => i.shownCount > 0).length <= 8);
  const shown = items.filter(i => i.shownCount > 0); assert.ok(shown.every(i => context.includes(i.id)));
});
test('kim-discord-allowlist は常に空で discordAllowed は常に false（2026-11-10 全廃）', t => {
  const home = seat(t); const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-repo-')); t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, 'config'));
  fs.writeFileSync(path.join(repoRoot, 'config/kim-discord-allowlist.json'), JSON.stringify({ entries: [{ category: '定時', pattern: '^定時' }] }));
  fs.writeFileSync(path.join(home, '.claude/kim-discord-allowlist.json'), JSON.stringify({ entries: [{ category: '追加', pattern: '^追加' }] }));
  const loaded = loadAllowlist({ home, repoRoot });
  assert.ok(Array.isArray(loaded) && loaded.length === 0, `許可リストは空になっているべき: ${loaded.length}`);
  // ファイルが存在しても discordAllowed は常に false
  for (const text of ['定時本文', '追加本文', '未許可', '緊急の障害', '【進捗まとめ】']) {
    assert.equal(discordAllowed(text, { home, repoRoot }).allowed, false, `「${text}」が許可されています`);
  }
  // 明示 allowlist を渡しても常に false
  assert.equal(discordAllowed('未許可', { allowlist: [{ category: '全件', pattern: '.*' }] }).allowed, false, '明示allowlistが許可を返しています');
});
test('通知は fetch ゼロで台帳に ask と sessionId を保存し24時間抑制も維持する', async t => {
  const home = seat(t); const options = { home, plainJa: false, fetchImpl: async () => assert.fail('Discord を呼ばない'), kind: 'ask', sessionId: 'abcdef12-3456' };
  const a = await notifyKim('自動進行が判断待ちです: 判断してください', options);
  assert.equal(a.delivered, 'session-inbox'); assert.equal(a.kind, 'ask');
  assert.equal((await notifyKim('自動進行が判断待ちです: 判断してください', options)).delivered, 'suppressed');
  assert.equal(listItems(home).length, 1);
  assert.equal(listItems(home)[0].sessionId, options.sessionId);
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
test('複数プロセスの info と ask はそれぞれ1件に集約する', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const home = seat(t), file = path.join(home, '本文.txt'); fs.writeFileSync(file, '同時追加');
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url)), '--add', '--body-file', file], { env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true })));
  assert.equal(new Set(results.map(r => JSON.parse(r.stdout).id)).size, 1);
  assert.equal(listItems(home).length, 1); assert.equal(listItems(home)[0].repeatCount, 4);
  const asks = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url)), '--add', '--kind', 'ask', '--body-file', file], { env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true })));
  assert.equal(new Set(asks.map(r => JSON.parse(r.stdout).id)).size, 1);
  assert.equal(listItems(home).filter(i => i.kind === 'ask').length, 1);
  assert.equal(listItems(home).find(i => i.kind === 'ask').count, 4);
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

function writeItem(home, item) {
  fs.writeFileSync(path.join(home, '.claude/kim-inbox', `${item.id}.json`), JSON.stringify(item));
}
test('同文 info 30件は1件に集約し、異なる本文は別件として残す', async t => {
  const home = seat(t);
  for (let n = 0; n < 30; n++) await addItem(home, { text: '連絡が届いていません' });
  const [item] = listItems(home, { status: 'open' });
  assert.equal(listItems(home).length, 1); assert.equal(item.repeatCount, 30);
  assert.ok(Number.isFinite(Date.parse(item.lastAt)));
  const first = await addItem(home, { text: '【送信元A】\nPC011 2026-11-02T14:04:00Z 作業 0c1acc2f 連絡失敗' });
  const latest = await addItem(home, { text: '【送信元B】\nPC022 2026-11-04T15:05:12Z 作業 abcdefab 連絡失敗' });
  assert.notEqual(first.id, latest.id); assert.equal(latest.repeatCount, 1);
  assert.match(latest.text, /PC022/);
  assert.ok(selectContext([latest]).includes(latest.id), 'context should include the latest item');
  markSeen(home, latest.id);
  assert.notEqual((await addItem(home, { text: latest.text })).id, latest.id);
});
test('古い雑多な info 50件より新しい完了通知を先に表示する', async t => {
  const home = seat(t);
  for (let n = 0; n < 50; n++) {
    const item = await addItem(home, { text: `雑多な連絡 ${String.fromCharCode(0x3041 + n)}` });
    writeItem(home, { ...item, createdAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-01T00:00:00Z' });
  }
  const done = await addItem(home, { text: '完了: OpenRouter の設定を更新しました' });
  const context = selectContext(listItems(home));
  assert.match(context, /完了: OpenRouter/);
  assert.ok(context.indexOf(done.id) < context.indexOf('雑多な連絡'));
  assert.ok(context.length <= CONTEXT_LIMIT);
});
test('長い ask が多数あっても未表示の進捗 info を表示枠から追い出さない', async t => {
  const home = seat(t);
  for (let n = 0; n < 8; n++) await addItem(home, { kind: 'ask', text: `判断依頼 ${n}\n` + 'い'.repeat(600) });
  const done = await addItem(home, { text: '【kim-PC の Claude Code】プロジェクト: x ／ 作業ID: deadbeef\n完了: 別セッションの検証が通りました' });
  const context = selectContext(listItems(home), { sessionId: '0c1acc2f-0000' });
  assert.match(context, /完了: 別セッションの検証が通りました/);
  assert.ok(context.length <= CONTEXT_LIMIT);
});
test('hook の session_id と一致する作業IDの info を ask より先に表示する', async t => {
  const home = seat(t);
  await addItem(home, { kind: 'ask', text: '先に届いた質問' });
  await addItem(home, { text: '完了: 別セッション 作業ID: deadbeef' });
  const own = await addItem(home, { text: '進捗 作業ID: 0c1acc2f' });
  const output = [];
  assert.equal(await main(['--context'], { home, stdout: x => output.push(JSON.parse(x)), readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: '0c1acc2f-1234' }) }), 0);
  const context = output[0].hookSpecificOutput.additionalContext;
  assert.ok(context.includes(own.id), 'own item should appear in context');
});
test('100番目の現在セッション ask を別枠の先頭に4行の判断形式で表示する', async t => {
  const home = seat(t);
  const base = await addItem(home, { kind: 'ask', text: '基準' });
  const old = Array.from({ length: 100 }, (_, n) => ({ ...base, id: `old-${n}`, text: `既表示 ${n}`, shownCount: 400,
    createdAt: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00Z`, shownSessions: [] }));
  const detail = '現在セッションの判断依頼\n' + '詳'.repeat(500) + '全文末尾';
  const ownAsk = { ...base, id: 'own-ask', text: `セッション abcdef12 ${detail}`, createdAt: '2026-11-06T00:00:00Z', shownCount: 0, shownSessions: [] };
  const context = selectContext([...old, ownAsk], { sessionId: 'abcdef12-3456', now: Date.parse('2026-11-06T09:00:00Z') });
  assert.ok(context.includes('（own-ask）'), `own ask id should appear in context`);
  assert.doesNotMatch(context, /全文末尾/);
  assert.match(context, /現在セッションの判断依頼/);
  assert.equal(ownAsk.shownCount, 1);
});
test('別セッションでは未表示 ask を400回表示済み ask より先にする', async t => {
  const home = seat(t);
  const base = await addItem(home, { kind: 'ask', text: '基準' });
  const shown = Array.from({ length: 100 }, (_, n) => ({ ...base, id: `shown-${n}`, text: `既表示 ${n}`, shownCount: 400,
    createdAt: '2026-11-06T00:00:00Z', shownSessions: [] }));
  const unseen = { ...base, id: 'unseen', text: 'セッション abcdef12 未表示の判断依頼', createdAt: '2026-11-01T00:00:00Z', shownCount: 0, shownSessions: [] };
  const context = selectContext([...shown, unseen], { sessionId: '99999999-0000', now: Date.parse('2026-11-06T09:00:00Z') });
  assert.ok(context.includes(unseen.id), 'unseen should appear in context');
  // unseen (shownCount=0, stale) should appear before any shown-N (shownCount=400)
  const shownInContext = shown.filter(s => context.includes(s.id));
  if (shownInContext.length > 0) {
    assert.ok(context.indexOf(unseen.id) < context.indexOf(shownInContext[0].id), 'unseen before shown items');
  }
});
test('ask は表示回数の少ない順、同数なら新しい順で、表示するたびに順番が回る', async t => {
  const base = await addItem(seat(t), { kind: 'ask', text: '判断' });
  const items = [400, 2, 1, 1].map((shownCount, n) => ({ ...base, id: `rotation-${n}`, shownCount,
    createdAt: `2026-11-0${n + 1}T00:00:00Z`, shownSessions: [], text: `${n}\n${'詳'.repeat(599)}` }));
  const first = selectContext(items, { now: Date.parse('2026-11-06T09:00:00Z') });
  assert.ok(first.includes('rotation-3'), 'rotation-3 (newest with shownCount=1) should appear');
  assert.ok(first.indexOf('rotation-3') < first.indexOf('rotation-2'));
  const rotation = Array.from({ length: 10 }, (_, n) => ({ ...base, id: `fair-${n}`, shownCount: 1,
    createdAt: '2026-11-06T00:00:00Z', shownSessions: [] }));
  selectContext(rotation, { sessionId: 'other' });
  selectContext(rotation, { sessionId: 'other' });
  assert.ok(rotation.every(item => item.shownCount === 2));
});
test('3日超の未表示 ask を新しい未表示 ask より優先し、境界と既表示を区別する', async t => {
  const base = await addItem(seat(t), { kind: 'ask', text: '判断' });
  const now = Date.parse('2026-11-06T09:00:00Z');
  const items = [
    { ...base, id: 'recent', createdAt: new Date(now).toISOString() },
    { ...base, id: 'boundary', createdAt: new Date(now - 3 * 86400000).toISOString() },
    { ...base, id: 'stale', createdAt: new Date(now - 3 * 86400000 - 1).toISOString() },
    { ...base, id: 'seen', createdAt: new Date(now - 10 * 86400000).toISOString(), shownCount: 1 },
  ];
  const context = selectContext(items, { now });
  assert.ok(context.includes('stale'), 'stale (unshown for 3+ days) should appear first');
  assert.ok(context.indexOf('stale') < context.indexOf('recent') || !context.includes('recent'), 'stale before recent');
});
test('現在セッション ask は各形式で特定し、急ぎ・期限より先に4行の判断形式を再提示する', async t => {
  const base = await addItem(seat(t), { kind: 'ask', text: '判断' });
  const own = [
    { ...base, id: 'own-text', text: `作業ID: ABCDEF12\n資料確認\n${'詳'.repeat(700)}` },
    { ...base, id: 'own-session', text: `セッション abcdef12\n${'詳'.repeat(700)}` },
    { ...base, id: 'own-field', sessionId: 'abcdef12-5678', urgent: true, text: '資料確認\n' + '詳'.repeat(700) },
  ].map(item => ({ ...item, createdAt: '2026-11-01T00:00:00Z', shownSessions: [] }));
  const urgent = { ...base, id: 'other-urgent', urgent: true };
  const deadline = { ...base, id: 'other-deadline', kind: 'deadline', text: '期限本文', remainingDays: -1 };
  const sessionId = 'abcdef12-3456', now = Date.parse('2026-11-06T09:00:00Z');
  for (let n = 1; n <= 2; n++) {
    const context = selectContext([...own, urgent, deadline], { sessionId, now });
    assert.ok(context.includes('（own-text') || context.includes('（own-session') || context.includes('（own-field'), `own ask ids should appear in context`);
    assert.ok(context.length <= CONTEXT_LIMIT);
    for (const item of own) {
      assert.ok(context.includes(item.id), `item ${item.id} should appear in context`);
      assert.ok(!context.includes(item.text.slice(0, 600)));
      assert.ok(context.indexOf(item.id) < context.indexOf('期限本文'));
      assert.equal((context.match(new RegExp(`（${item.id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}）`, 'g')) || []).length, 1, `item ${item.id} appears exactly once`);
      assert.equal(item.shownCount, n);
      assert.deepEqual(item.shownSessions, [sessionId]);
    }
  }
});
test('セッション判定は8桁の境界を守り、期限にも適用する', async t => {
  const base = await addItem(seat(t), { kind: 'deadline', key: 'D-test', text: '期限' });
  const items = [
    { ...base, id: 'false-match', text: 'セッション abcdef123 別件', remainingDays: -10 },
    { ...base, id: 'own-deadline', text: 'セッション abcdef12 現在の期限', remainingDays: 30 },
    { ...base, id: 'field-deadline', sessionId: 'abcdef12-3456', text: 'フィールド一致の期限', remainingDays: 7 },
  ];
  const context = selectContext(items, { sessionId: 'abcdef12-5678' });
  assert.ok(context.indexOf('フィールド一致の期限') < context.indexOf('現在の期限'));
  assert.ok(context.indexOf('現在の期限') < context.indexOf('別件'));
});
test('未表示 high を既表示 high とその他より優先し、表示上限後もその他で追い越さない', async t => {
  const home = seat(t);
  const base = await addItem(home, { text: '通常連絡' });
  const highs = Array.from({ length: 7 }, (_, n) => ({ ...base, id: `ki-20261104000000-${n.toString(16).padStart(4, '0')}`, text: `完了: ${n}`, createdAt: `2026-11-0${n + 1}T00:00:00Z`, lastAt: `2026-11-0${n + 1}T00:00:00Z`, shownCount: n === 6 ? 1 : 0 }));
  const context = selectContext([base, ...highs]);
  assert.ok(context.indexOf(highs[5].id) > 0);
  assert.doesNotMatch(context, /通常連絡/);
  assert.equal(highs[6].shownCount, 1);
  assert.ok(highs.filter(i => i.lastShownAt).length <= 5);
  assert.ok(context.length <= CONTEXT_LIMIT);
});
test('--compact は旧データの重複を最新へ合算し ask・high・閉じた項目を保持する', async t => {
  const home = seat(t);
  const base = await addItem(home, { text: '通常連絡 1' });
  delete base.repeatCount; delete base.lastAt;
  writeItem(home, { ...base, createdAt: '2026-01-01T00:00:00Z' });
  const newer = { ...base, id: 'ki-20261104000000-0001', text: '通常連絡 2', createdAt: '2026-11-04T00:00:00Z', repeatCount: 4 };
  writeItem(home, newer);
  const protectedItems = ['ask', 'ask', 'info', 'info', 'info', 'info'].map((kind, n) => ({ ...base, id: `ki-20261104000000-00${n + 10}`, kind, text: n < 2 ? base.text : n < 4 ? '完了: 通常連絡' : '進捗 作業ID: 0c1acc2f' }));
  protectedItems.push({ ...base, id: 'ki-20261104000000-0020', status: 'seen' });
  protectedItems.forEach(item => writeItem(home, item));
  const output = [];
  assert.equal(await main(['--compact'], { home, stdout: x => output.push(JSON.parse(x)) }), 0);
  assert.deepEqual(output[0], { groups: 1, merged: 1 });
  const all = listItems(home);
  assert.equal(all.find(i => i.id === newer.id).repeatCount, 5);
  assert.equal(all.find(i => i.id === base.id).status, 'merged');
  assert.equal(all.find(i => i.id === base.id).mergedInto, newer.id);
  for (const item of protectedItems) assert.deepEqual(all.find(i => i.id === item.id), item);
  await main(['--compact'], { home, stdout: x => output.push(JSON.parse(x)) });
  assert.deepEqual(output[1], { groups: 0, merged: 0 });
});

test('期限は残日数順に先頭5件、upsertは表示回数を増やさずclose-keyで閉じる', async t => {
  const home = seat(t);
  await addItem(home, { kind: 'ask', text: '質問' });
  await addItem(home, { kind: 'info', text: '完了: 進捗' });
  for (const n of [30, 7, -8, 3, 0, 14]) await addItem(home, { kind: 'deadline', key: `D-${n + 10}`, remainingDays: n, text: `期限${n} ${'あ'.repeat(200)}` });
  const first = listItems(home).find(i => i.key === 'D-2');
  const again = await addItem(home, { kind: 'deadline', key: 'D-2', remainingDays: -8, text: '期限-8 更新' });
  assert.equal(first.id, again.id); assert.equal(again.shownCount, 0);
  const items = listItems(home); const context = selectContext(items, { sheetUrl: 'https://example.test/ledger' });
  assert.ok(context.startsWith('[kim-inbox 期限 6 / 未回収 ask 1 / 未確認 info 1]'));
  assert.ok(context.indexOf('期限-8 更新') < context.indexOf('期限0 '));
  assert.ok(context.indexOf('期限0 ') < context.indexOf('期限3 '));
  assert.doesNotMatch(context, /期限30 /); assert.ok(context.length <= CONTEXT_LIMIT);
  const shownDeadlines = items.filter(i => i.kind === 'deadline' && i.shownCount);
  assert.ok(shownDeadlines.length > 0 && shownDeadlines.length <= 5);
  assert.match(context, /ほか \d+ 件/);
  for (const item of shownDeadlines) assert.match(context, new RegExp(`返事の例: ${item.key} 完了／延期 11/20／不要`));
  assert.ok(context.indexOf('期限-8 更新') < context.indexOf('一覧:'), 'deadline before general info');
  assert.equal(await main(['--close-key', 'D-2'], { home, stdout: () => {} }), 0);
  assert.equal(listItems(home, { status: 'open' }).filter(i => i.key === 'D-2').length, 0);
});

test('未達とgate-reportのinfoは抑止、掃除はsourceも検索しaskを保持', async t => {
  const home = seat(t);
  for (const options of [{ text: '別のパソコン（PC）へ送った連絡が届いていません' }, { source: 'gate-report', text: '統計' }]) {
    assert.equal((await addItem(home, options)).status, 'suppressed');
  }
  const legacy = await addItem(home, { text: '旧通知' });
  writeItem(home, { ...legacy, source: 'gate-report' });
  await addItem(home, { kind: 'ask', source: 'gate-report', text: '判断が必要' });
  assert.equal(await main(['--seen-matching', '^gate-report', '--kind', 'info'], { home, stdout() {} }), 0);
  assert.equal(listItems(home, { status: 'open' }).length, 1);
  assert.equal(listItems(home, { status: 'open' })[0].kind, 'ask');
});

test('notify CLI spools while aggregation is locked, then addItem imports exactly once', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { drainSpool } = await import('./kim-inbox.mjs');
  const home = seat(t), dir = path.join(home, '.claude/kim-inbox');
  fs.mkdirSync(dir);
  const lock = path.join(dir, 'info-aggregation.lock');
  fs.writeFileSync(lock, String(process.pid));
  const started = performance.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./notify-kim.mjs', import.meta.url)), '--kind', 'info', '--source', 'spool-test', '進捗: 通知退避の検証 token=private'], {
    env: { ...process.env, ORGIAST_HOME: home, NOTIFY_PLAIN_JA: '0' }, encoding: 'utf8', timeout: 25000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).delivered, 'spooled');
  assert.ok(performance.now() - started >= 9900);
  const spoolDir = path.join(dir, 'spool'), name = fs.readdirSync(spoolDir)[0];
  const record = fs.readFileSync(path.join(spoolDir, name), 'utf8');
  assert.doesNotMatch(record, /private/);
  fs.unlinkSync(lock);
  await addItem(home, { text: '別の通知' });
  assert.equal(fs.readdirSync(spoolDir).length, 0);
  assert.equal(listItems(home).filter(i => i.source === 'spool-test').length, 1);
  // Simulate a crash after inbox persistence but before removing the spool file.
  fs.writeFileSync(path.join(spoolDir, name), record);
  await drainSpool(home);
  assert.equal(listItems(home).filter(i => i.source === 'spool-test').length, 1);
  assert.equal(listItems(home).find(i => i.source === 'spool-test').repeatCount, 1);
});

test('notify CLI exits 1 when both inbox and spool writes fail', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const home = seat(t);
  fs.writeFileSync(path.join(home, '.claude/kim-inbox'), 'not a directory');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./notify-kim.mjs', import.meta.url)), '--kind', 'info', '進捗: 保存不能の検証'], {
    env: { ...process.env, ORGIAST_HOME: home, NOTIFY_PLAIN_JA: '0' }, encoding: 'utf8', timeout: 25000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).delivered, 'none');
  assert.match(JSON.parse(result.stdout).reason, /spool/);
});

test('context imports spooled notifications before selecting what to show', async t => {
  const { spoolItem } = await import('./kim-inbox.mjs');
  const home = seat(t), output = [];
  spoolItem(home, { kind: 'ask', text: '退避していた判断依頼', sessionId: 'abcdef12-3456' });
  assert.equal(await main(['--context'], { home, stdout: line => output.push(line), readStdin: async () => '{"hook_event_name":"UserPromptSubmit","session_id":"spool-context"}' }), 0);
  assert.match(output[0], /退避していた判断依頼/);
  assert.equal(listItems(home)[0].shownCount, 1);
  assert.equal(listItems(home)[0].sessionId, 'abcdef12-3456');
});

test('concurrent spool consumers preserve a single forwarding attempt and retry failed forwarding', async t => {
  const { spoolItem, drainSpool } = await import('./kim-inbox.mjs');
  const home = seat(t, '作業用011');
  spoolItem(home, { kind: 'ask', text: '転送する判断依頼' });
  await drainSpool(home, { execImpl: async () => { throw new Error('offline'); } });
  assert.equal(fs.readdirSync(path.join(home, '.claude/kim-inbox/spool')).length, 1);
  let calls = 0;
  const execImpl = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { stdout: '送信済み: mail-spool\n' }; };
  await Promise.all([drainSpool(home, { execImpl }), drainSpool(home, { execImpl })]);
  assert.equal(calls, 1);
  assert.equal(listItems(home).length, 1);
  assert.equal(listItems(home)[0].status, 'forwarded');
  assert.equal(fs.readdirSync(path.join(home, '.claude/kim-inbox/spool')).length, 0);
});

test('an answered spool item with an old forwarding error does not block later notifications', async t => {
  const { spoolItem, drainSpool } = await import('./kim-inbox.mjs');
  const home = seat(t, '作業用011');
  spoolItem(home, { kind: 'ask', text: 'ローカルで回答する依頼' });
  await drainSpool(home, { execImpl: async () => { throw new Error('offline'); } });
  answerItem(home, listItems(home)[0].id, '回答済み');
  let forwarded = false;
  await drainSpool(home, { execImpl: async () => { forwarded = true; throw new Error('must not forward answered item'); } });
  assert.equal(forwarded, false);
  assert.equal(fs.readdirSync(path.join(home, '.claude/kim-inbox/spool')).length, 0);
});

test('--urgent を保存し、古い通常 ask 150件・期限・セッション進捗より先に本文を出す', async t => {
  const home = seat(t), file = path.join(home, 'urgent.txt');
  const body = '開示可否の確認\n' + '至急の詳細。'.repeat(80);
  fs.writeFileSync(file, body);
  assert.equal(await main(['--add', '--kind', 'ask', '--urgent', '--body-file', file], { home, stdout: () => {} }), 0);
  const [urgent] = listItems(home);
  assert.equal(urgent.urgent, true);
  const normal = Array.from({ length: 150 }, (_, n) => ({ ...urgent, id: `normal-${n}`, urgent: false, createdAt: '2026-01-01T00:00:00Z', text: `通常質問${n}`, shownSessions: [] }));
  const deadline = { ...urgent, id: 'deadline', kind: 'deadline', text: '期限の確認', due: '2026-11-05', shownSessions: [] };
  const info = { ...urgent, id: 'info', kind: 'info', text: '進捗 作業ID: deadbeef', shownSessions: [] };
  const items = [...normal, deadline, info, urgent];
  for (let n = 0; n < 2; n++) {
    const context = selectContext(items, { sessionId: 'deadbeef-1234' });
    assert.ok(context.includes(`（${urgent.id}）`), `urgent id should appear in context`);
    assert.ok(context.indexOf(`（${urgent.id}）`) < context.indexOf(deadline.text) || context.indexOf(urgent.id) < context.indexOf(deadline.text), 'urgent before deadline');
    assert.ok(context.indexOf(`（${urgent.id}）`) < context.indexOf(info.text) || context.indexOf(urgent.id) < context.indexOf(info.text), 'urgent before info');
    assert.equal((context.match(/ normal-/g) || []).length, 5);
  }
  assert.equal(urgent.shownCount, 2);
});

test('急ぎは短い要約を保ち、未表示優先・最大5件・open限定で通常枠と分離する', async t => {
  const home = seat(t);
  const base = await addItem(home, { kind: 'ask', text: '通常', urgent: false });
  assert.equal(base.urgent, undefined);
  const urgent = Array.from({ length: 7 }, (_, n) => ({ ...base, id: `urgent-${n}`, urgent: true,
    createdAt: `2026-11-0${n + 1}T00:00:00Z`, text: `${n}` + 'あ'.repeat(599) + '切り捨て部分',
    shownCount: n === 6 ? 1 : 0, shownSessions: [] }));
  const closed = { ...base, id: 'closed-urgent', urgent: true, status: 'answered', text: '回答済み' };
  const context = selectContext([base, ...urgent, closed], { sessionId: 's', now: Date.parse('2026-11-11T00:00:00Z') });
  assert.ok(context.length <= CONTEXT_LIMIT);
  const displayed = urgent.slice(1, 6).filter(item => context.includes(item.id));
  assert.ok(displayed.length > 0 && displayed.length <= 5, 'briefs are shown until the context budget or item limit is full');
  for (const item of displayed) {
    assert.equal(item.shownCount, 1);
    assert.deepEqual(item.shownSessions, ['s']);
  }
  assert.match(context, /ほか \d+ 件/);
  assert.doesNotMatch(context, /urgent-0|urgent-6|closed-urgent/);
  for (const item of displayed) assert.ok(context.includes(item.text.slice(0, 80)), 'topic keeps the first 80 characters');
  assert.equal(urgent[0].shownCount, 0);
  assert.equal(urgent[6].shownCount, 1);
});


test('進捗を先頭に出し現在セッションの承認待ちを一度だけ表示する', async t => {
  const home = seat(t);
  const own = await addItem(home, { kind: 'ask', sessionId: 'abcdef12-3456', priority: 'high', source: 'auto-progress-done', text: '承認依頼\n判断に必要な詳細' });
  const done = await addItem(home, { source: 'auto-progress-done', text: '完了通知', dedupeKey: 'merge:done' });
  const progress = await addItem(home, { source: 'auto-progress-heartbeat', text: '進捗通知\n進捗詳細', dedupeKey: 'merge:progress' });
  const approval = await addItem(home, { kind: 'ask', priority: 'high', text: '別件の承認依頼' });
  const items = listItems(home);
  assert.equal(items.find(i => i.id === own.id).priority, 'high');
  for (let n = 1; n <= 2; n++) {
    const context = selectContext(items, { sessionId: 'abcdef12-3456' });
    if (n === 1) assert.ok(context.includes(`（${progress.id}）`), `progress should appear in context`);
    assert.equal((context.split(`（${own.id}）`).length - 1) + (context.split(`${own.id}（`).length - 1), 1);
    assert.match(context, /別件の承認依頼/);
    if (n === 1) {
      assert.match(context, /完了通知/);
      assert.match(context, /進捗通知/);
    }
    for (const item of [own, approval]) assert.equal(items.find(i => i.id === item.id).shownCount, n);
  }
});
test('通常枠が空でも完了・進捗・承認待ちを表示する', async t => {
  const home = seat(t);
  await addItem(home, { source: 'auto-progress-done', text: '完了だけの通知' });
  const context = selectContext(listItems(home));
  assert.match(context, /kim-inbox 完了・進捗・承認待ち/);
  assert.match(context, /完了だけの通知/);
});
test('oneScreenSummary: 30件のaskと30件のinfoで2000バイト以内・件数正・古い順5件', async t => {
  const home = seat(t);
  const now = Date.now();
  fs.mkdirSync(path.join(home, '.claude/kim-inbox'), { recursive: true });
  for (let n = 0; n < 30; n++) {
    const id = `ki-${new Date(now - (30 - n) * 60000).toISOString().replace(/\D/g, '').slice(0, 14)}-${n.toString(16).padStart(4, '0')}`;
    writeItem(home, { id, kind: 'ask', status: 'open', createdAt: new Date(now - (30 - n) * 60000).toISOString(), text: `依頼${n} あいうえおかきくけこさしすせそたちつてとなにぬねの`, shownSessions: [], shownCount: 0, source: 'test', from: 'test' });
  }
  for (let n = 0; n < 30; n++) {
    const id = `ki-${new Date(now - (30 - n) * 60000 + 1000).toISOString().replace(/\D/g, '').slice(0, 14)}-${(n + 30).toString(16).padStart(4, '0')}`;
    writeItem(home, { id, kind: 'info', status: 'open', createdAt: new Date(now - (30 - n) * 60000 + 1000).toISOString(), text: `進捗${n} かきくけこさしすせそたちつてとなにぬねのはひふへほ`, shownSessions: [], shownCount: 0, source: 'test', from: 'test' });
  }
  const items = listItems(home).filter(i => i.status === 'open');
  assert.equal(items.filter(i => i.kind === 'ask').length, 30);
  assert.equal(items.filter(i => i.kind === 'info').length, 30);
  const summary = oneScreenSummary(items);
  const bytes = Buffer.from(summary, 'utf8').length;
  assert.ok(bytes <= 2000, `summary ${bytes} bytes > 2000`);
  const lines = summary.split('\n');
  assert.match(lines[0], /^📌 kim の返事待ち 30件/);
  for (let n = 0; n < 5; n++) {
    assert.match(lines[1 + n], /\(ki-/);
  }
  const askHeader = lines[0];
  assert.ok(lines[6] === '📲 自動進行の結果' || lines[6] === 'ほか', '6行目は 📲 または ほか');
  const ids = lines.slice(1, 6).map(l => { const m = l.match(/\(([^)]+)\)/); return m ? m[1] : ''; });
  const itemMap = Object.fromEntries(items.map(i => [i.id, i]));
  const sorted = ids.map(id => itemMap[id]).filter(Boolean);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].createdAt <= sorted[i].createdAt, `${sorted[i - 1].id} が ${sorted[i].id} より新しい`);
  assert.match(summary, /ほか \d+件: node tools\/kim-inbox\.mjs --list/);
});
test('oneScreenSummary: ask 0件ならヘッダー行だけ', async t => {
  const home = seat(t);
  const now = Date.now();
  fs.mkdirSync(path.join(home, '.claude/kim-inbox'), { recursive: true });
  for (let n = 0; n < 30; n++) {
    const id = `ki-${new Date(now - (30 - n) * 60000 + 1000).toISOString().replace(/\D/g, '').slice(0, 14)}-${(n + 60).toString(16).padStart(4, '0')}`;
    writeItem(home, { id, kind: 'info', status: 'open', createdAt: new Date(now - (30 - n) * 60000 + 1000).toISOString(), text: `進捗${n} てすと`, shownSessions: [], shownCount: 0, source: 'test', from: 'test' });
  }
  const items = listItems(home).filter(i => i.status === 'open');
  assert.equal(items.filter(i => i.kind === 'ask').length, 0);
  const summary = oneScreenSummary(items);
  assert.equal(summary, '📌 kim の返事待ち 0件');
});
test('UserPromptSubmit では1画面ブロックが付かない／ask の秘密値が伏せ字になる', async t => {
  const home = seat(t);
  await addItem(home, { kind: 'ask', text: 'sk-abcdefghijklmnopqr の判断' });
  // UserPromptSubmit: 1画面ブロックなし
  const output = [];
  await main(['--context'], { home, stdout: s => output.push(JSON.parse(s)), readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }) });
  assert.doesNotMatch(output[0].hookSpecificOutput.additionalContext, /📌 kim の返事待ち/);
  // 秘密値は selectContext の redactSecrets で伏せる
  assert.doesNotMatch(output[0].hookSpecificOutput.additionalContext, /abcdefghijklmnopqr/);
  // SessionStart も追跡される注入だけ。未追跡の ask を重ねない。
  output.length = 0;
  await main(['--context'], { home, stdout: s => output.push(JSON.parse(s)), readStdin: async () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's2' }) });
  assert.doesNotMatch(output[0].hookSpecificOutput.additionalContext, /📌 kim の返事待ち/);
  // oneScreenSummary の戻り値も handler で redactSecrets を通す
  assert.doesNotMatch(output[0].hookSpecificOutput.additionalContext, /abcdefghijklmnopqr/);
});

test('add with --done-when-gmail stores doneWhen', async t => {
  const home = seat(t);
  const file = path.join(home, 'ask.txt');
  fs.writeFileSync(file, '自動車保険更新');
  await main(['--add', '--kind', 'ask', '--done-when-gmail', 'seisaku-team@orgiast.jp|【自動車保険】継続手続完了のお知らせ', '--body-file', file], { home, stdout: () => {} });
  const items = listItems(home);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].doneWhen, {
    gmail: {
      user: 'seisaku-team@orgiast.jp',
      query: '【自動車保険】継続手続完了のお知らせ'
    }
  });
});

test('autoCloseByGmail closes an open ask when search returns newer message', async t => {
  const home = seat(t);
  const createdAt = '2026-11-12T09:00:00.000Z';
  const item = await addItem(home, {
    kind: 'ask',
    text: '自動車保険継続',
    doneWhen: { gmail: { user: 'seisaku-team@orgiast.jp', query: '継続手続完了' } }
  });
  fs.writeFileSync(path.join(home, '.claude/kim-inbox', `${item.id}.json`), JSON.stringify({ ...item, createdAt }));

  const search = async (user, query) => {
    assert.equal(user, 'seisaku-team@orgiast.jp');
    assert.match(query, /継続手続完了 after:2026\/11\/12/);
    return {
      messages: [{
        id: 'msg-999',
        internalDate: Date.parse('2026-11-12T09:40:00.000Z'),
        subject: '【自動車保険】継続手続完了のお知らせ'
      }]
    };
  };

  const closed = await autoCloseByGmail(home, { search, now: Date.parse('2026-11-12T09:45:00.000Z') });
  assert.deepEqual(closed, [{ id: item.id, closed: true }]);

  const updated = listItems(home).find(i => i.id === item.id);
  assert.equal(updated.status, 'answered');
  assert.equal(updated.answerSession, 'auto-gmail');
  assert.match(updated.answer, /自動クローズ: seisaku-team@orgiast\.jp に「【自動車保険】継続手続完了のお知らせ」/);
  assert.match(updated.answer, /gmail:msg-999/);
});

test('message older than createdAt does not close', async t => {
  const home = seat(t);
  const createdAt = '2026-11-12T09:00:00.000Z';
  const item = await addItem(home, {
    kind: 'ask',
    text: '自動車保険継続',
    doneWhen: { gmail: { user: 'seisaku-team@orgiast.jp', query: '継続手続完了' } }
  });
  fs.writeFileSync(path.join(home, '.claude/kim-inbox', `${item.id}.json`), JSON.stringify({ ...item, createdAt }));

  const search = async () => ({
    messages: [{
      id: 'old-msg',
      internalDate: Date.parse('2026-11-12T08:59:59.000Z'),
      subject: '旧メール'
    }]
  });

  const closed = await autoCloseByGmail(home, { search, now: Date.parse('2026-11-12T09:45:00.000Z') });
  assert.deepEqual(closed, []);
  const updated = listItems(home).find(i => i.id === item.id);
  assert.equal(updated.status, 'open');
  assert.equal(updated.answer, null);
});

test('throttle: second call within 10 minutes does not call search', async t => {
  const home = seat(t);
  const item = await addItem(home, {
    kind: 'ask',
    text: '自動車保険継続',
    doneWhen: { gmail: { user: 'seisaku-team@orgiast.jp', query: '継続手続完了' } }
  });

  let calls = 0;
  const search = async () => { calls++; return { messages: [] }; };

  const t1 = Date.parse('2026-11-12T10:00:00.000Z');
  await autoCloseByGmail(home, { search, now: t1 });
  assert.equal(calls, 1);

  const t2 = Date.parse('2026-11-12T10:05:00.000Z');
  await autoCloseByGmail(home, { search, now: t2 });
  assert.equal(calls, 1);

  const t3 = Date.parse('2026-11-12T10:11:00.000Z');
  await autoCloseByGmail(home, { search, now: t3 });
  assert.equal(calls, 2);
});

test('search throwing records lastError and does not throw', async t => {
  const home = seat(t);
  const item = await addItem(home, {
    kind: 'ask',
    text: '自動車保険継続',
    doneWhen: { gmail: { user: 'seisaku-team@orgiast.jp', query: '継続手続完了' } }
  });

  const search = async () => { throw new Error('Gmail API ネットワークエラー'); };
  const closed = await autoCloseByGmail(home, { search, now: Date.parse('2026-11-12T10:00:00.000Z') });
  assert.deepEqual(closed, []);

  const updated = listItems(home).find(i => i.id === item.id);
  assert.equal(updated.status, 'open');
  assert.equal(updated.doneWhen.lastError, 'Gmail API ネットワークエラー');
  assert.ok(updated.doneWhen.lastCheckedAt);
});

test('items without doneWhen are untouched', async t => {
  const home = seat(t);
  const ask = await addItem(home, { kind: 'ask', text: '通常の質問' });
  const info = await addItem(home, { kind: 'info', text: '通常の通知' });

  const search = async () => { assert.fail('search should not be called'); };
  const closed = await autoCloseByGmail(home, { search, now: Date.now() });
  assert.deepEqual(closed, []);

  const items = listItems(home);
  assert.equal(items.find(i => i.id === ask.id).status, 'open');
  assert.equal(items.find(i => i.id === info.id).status, 'open');
});

test('CLI --auto-close prints JSON of closed items', async t => {
  const home = seat(t);
  await addItem(home, {
    kind: 'ask',
    text: '自動車保険継続',
    doneWhen: { gmail: { user: 'seisaku-team@orgiast.jp', query: '継続手続完了' } }
  });
  const output = [];
  await main(['--auto-close'], { home, stdout: s => output.push(JSON.parse(s)) });
  assert.ok(Array.isArray(output[0]));
});

test('answer closes open asks for the same ledger row or dedupe key', async t => {
  const home = seat(t);
  const ts = '2026-11-18T00:00:00.000Z';
  const sessionId = 'abcdef12-full-session';
  const text = (days, time = ts) => `【要対応・kim の判断待ち ${days}日】確認（元の約束: 作業 / セッション abcdef12 / 台帳 ts ${time}）`;
  const original = await addItem(home, { kind: 'ask', text: text(2), sessionId });
  const sameRow = await addItem(home, { kind: 'ask', text: text(3) });
  const sameKey = await addItem(home, { kind: 'ask', text: '旧形式', dedupeKey: `auto-progress-escalate:${sessionId}${ts}` });
  const otherRow = await addItem(home, { kind: 'ask', text: text(2, '2026-11-17T00:00:00.000Z') });

  const answered = answerItem(home, original.id, '承認');
  const items = new Map(listItems(home).map(item => [item.id, item]));
  for (const duplicate of [sameRow, sameKey]) {
    const saved = items.get(duplicate.id);
    assert.equal(saved.status, 'superseded');
    assert.equal(saved.supersededInto, answered.id);
    assert.equal(saved.answer, answered.answer);
    assert.equal(saved.answeredAt, answered.answeredAt);
  }
  assert.equal(items.get(otherRow.id).status, 'open');
});

test('answer is persisted while the aggregation lock is held', async t => {
  const home = seat(t);
  const ask = await addItem(home, { kind: 'ask', text: '確認', dedupeKey: 'job:1' });
  const lock = path.join(home, '.claude/kim-inbox/info-aggregation.lock');
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  const waitSetting = 'ORGIAST_INBOX_GROUP_LOCK_WAIT_MS';
  const previousWait = process.env[waitSetting];
  process.env[waitSetting] = '0';
  t.after(() => {
    if (previousWait === undefined) delete process.env[waitSetting];
    else process.env[waitSetting] = previousWait;
  });
  const log = t.mock.method(console, 'error', () => {});

  const answered = answerItem(home, ask.id, '承認');

  assert.equal(answered.status, 'answered');
  assert.deepEqual(listItems(home, { status: 'answered' }), [answered]);
  assert.equal(answered.answer, '承認');
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], /回答は記録済み.*台帳が使用中です/);
});

test('drop closes only open asks with the matching key for ordinary questions', async t => {
  const home = seat(t);
  const original = await addItem(home, { kind: 'ask', text: '確認', dedupeKey: 'job:1' });
  const duplicate = await addItem(home, { kind: 'ask', text: '別文面' });
  const sameText = await addItem(home, { kind: 'ask', text: original.text });
  const info = await addItem(home, { kind: 'info', text: '報告', dedupeKey: 'job:2' });
  for (const item of [duplicate, info]) {
    const file = path.join(home, '.claude/kim-inbox', item.id + '.json');
    fs.writeFileSync(file, JSON.stringify({ ...item, dedupeKey: original.dedupeKey }));
  }

  const dropped = dropItem(home, original.id, '不要');
  const items = new Map(listItems(home).map(item => [item.id, item]));
  const saved = items.get(duplicate.id);
  assert.equal(saved.status, 'superseded');
  assert.equal(saved.supersededInto, dropped.id);
  assert.equal(saved.answer, '不要');
  assert.ok(dropped.answeredAt);
  assert.equal(saved.answeredAt, dropped.answeredAt);
  assert.equal(items.get(sameText.id).status, 'open');
  assert.equal(items.get(info.id).status, 'open');
});
