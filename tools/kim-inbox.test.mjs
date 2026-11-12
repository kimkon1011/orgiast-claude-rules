import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, listItems, answerItem, markSeen, dropItem, selectContext, ingestFleetMail, isKimSeat, main, CONTEXT_LIMIT, oneScreenSummary } from './kim-inbox.mjs';
import { inboxSummary } from './lib/kim-inbox-relay-state.mjs';
import { notifyKim } from './notify-kim.mjs';
import { loadAllowlist, discordAllowed } from './lib/kim-discord-allowlist.mjs';
function seat(t, label = 'kim-PC') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-test-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), `REPORTER_LABEL=${label}`);
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ [label]: { account: label === 'kim-PC' ? 'kim@orgiast.jp' : 'test@example.test' } }));
  t.after(() => fs.rmSync(home, { force: true, recursive: true })); return home;
}

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
test('ask は毎回提示し回答後に消える。info は確認できるが ask は確認だけで消せない', async t => {
  const home = seat(t); const ask = await addItem(home, { kind: 'ask', text: '判断してください\n詳細', source: '試験' });
  const info = await addItem(home, { kind: 'info', text: '完了' });
  assert.match(ask.id, /^ki-\d{14}-[a-f0-9]{4}$/);
  const output = [];
  const hook = session_id => main(['--context'], { home, stdout: s => output.push(JSON.parse(s)), readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id }) });
  await hook('s1'); await hook('s1'); await hook('s2');
  assert.match(output[0].hookSpecificOutput.additionalContext, /判断してください 詳細/);
  assert.match(output[1].hookSpecificOutput.additionalContext, /判断してください 詳細/);
  assert.match(output[2].hookSpecificOutput.additionalContext, /判断してください 詳細/);
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
test('複数プロセスの info は集約し ask は全件保存する', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const home = seat(t), file = path.join(home, '本文.txt'); fs.writeFileSync(file, '同時追加');
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url)), '--add', '--body-file', file], { env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true })));
  assert.equal(new Set(results.map(r => JSON.parse(r.stdout).id)).size, 1);
  assert.equal(listItems(home).length, 1); assert.equal(listItems(home)[0].repeatCount, 4);
  const asks = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url)), '--add', '--kind', 'ask', '--body-file', file], { env: { ...process.env, ORGIAST_HOME: home }, windowsHide: true })));
  assert.equal(new Set(asks.map(r => JSON.parse(r.stdout).id)).size, 4);
  assert.equal(listItems(home).filter(i => i.kind === 'ask').length, 4);
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
test('同文 info 30件は1件に集約し、見出し・日時・ID・PC番号の差も吸収する', async t => {
  const home = seat(t);
  for (let n = 0; n < 30; n++) await addItem(home, { text: '連絡が届いていません' });
  const [item] = listItems(home, { status: 'open' });
  assert.equal(listItems(home).length, 1); assert.equal(item.repeatCount, 30);
  assert.ok(Number.isFinite(Date.parse(item.lastAt)));
  const first = await addItem(home, { text: '【送信元A】\nPC011 2026-11-02T14:04:00Z 作業 0c1acc2f 連絡失敗' });
  const latest = await addItem(home, { text: '【送信元B】\nPC022 2026-11-04T15:05:12Z 作業 abcdefab 連絡失敗' });
  assert.equal(first.id, latest.id); assert.equal(latest.repeatCount, 2);
  assert.match(latest.text, /PC022/);
  assert.match(selectContext([latest]), /×2/);
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
  assert.ok(context.indexOf(done.id) < context.indexOf('■ ask'));
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
  assert.equal(context.match(/■ info (ki-[\d-]+[a-f0-9]+)/)[1], own.id);
  assert.ok(context.indexOf(own.id) < context.indexOf('■ ask'));
});
test('100番目の現在セッション ask を別枠の先頭に1行要約で表示する', async t => {
  const home = seat(t);
  const base = await addItem(home, { kind: 'ask', text: '基準' });
  const old = Array.from({ length: 100 }, (_, n) => ({ ...base, id: `old-${n}`, text: `既表示 ${n}`, shownCount: 400,
    createdAt: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00Z`, shownSessions: [] }));
  const detail = '現在セッションの判断依頼\n' + '詳'.repeat(500) + '全文末尾';
  const ownAsk = { ...base, id: 'own-ask', text: `セッション abcdef12 ${detail}`, createdAt: '2026-11-06T00:00:00Z', shownCount: 0, shownSessions: [] };
  const context = selectContext([...old, ownAsk], { sessionId: 'abcdef12-3456', now: Date.parse('2026-11-06T09:00:00Z') });
  assert.ok(context.startsWith('■ ask own-ask'));
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
  assert.ok(context.indexOf('■ ask unseen') < context.indexOf('■ ask shown-'));
  assert.match(context, /⚠未表示5日/);
});
test('ask は表示回数の少ない順、同数なら新しい順で、表示するたびに順番が回る', async t => {
  const base = await addItem(seat(t), { kind: 'ask', text: '判断' });
  const items = [400, 2, 1, 1].map((shownCount, n) => ({ ...base, id: `rotation-${n}`, shownCount,
    createdAt: `2026-11-0${n + 1}T00:00:00Z`, shownSessions: [], text: `${n}\n${'詳'.repeat(599)}` }));
  const first = selectContext(items, { now: Date.parse('2026-11-06T09:00:00Z') });
  assert.equal(first.match(/■ ask (rotation-\d)/)[1], 'rotation-3');
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
  assert.equal(context.match(/■ ask (\w+)/)[1], 'stale');
  assert.match(context, /■ ask stale ⚠未表示3日/);
  assert.equal((context.match(/⚠未表示/g) || []).length, 1);
});
test('現在セッション ask は各形式で特定し、急ぎ・期限より先に1行要約を再提示する', async t => {
  const base = await addItem(seat(t), { kind: 'ask', text: '判断' });
  const own = [
    { ...base, id: 'own-text', text: `作業ID: ABCDEF12\n${'詳'.repeat(700)}` },
    { ...base, id: 'own-session', text: `セッション abcdef12\n${'詳'.repeat(700)}` },
    { ...base, id: 'own-field', sessionId: 'abcdef12-5678', urgent: true, text: '詳'.repeat(700) },
  ].map(item => ({ ...item, createdAt: '2026-11-01T00:00:00Z', shownSessions: [] }));
  const urgent = { ...base, id: 'other-urgent', urgent: true };
  const deadline = { ...base, id: 'other-deadline', kind: 'deadline', text: '期限本文', remainingDays: -1 };
  const sessionId = 'abcdef12-3456', now = Date.parse('2026-11-06T09:00:00Z');
  for (let n = 1; n <= 2; n++) {
    const context = selectContext([...own, urgent, deadline], { sessionId, now });
    assert.ok(context.startsWith('■ ask own-'));
    assert.ok(context.length <= CONTEXT_LIMIT);
    for (const item of own) {
      assert.ok(context.includes(inboxSummary(item)));
      assert.ok(!context.includes(item.text.slice(0, 600)));
      assert.ok(context.indexOf(item.id) < context.indexOf('■ 🔴急ぎ'));
      assert.ok(context.indexOf(item.id) < context.indexOf('期限本文'));
      assert.equal(context.split(`■ ask ${item.id}`).length - 1, 1);
      assert.equal(item.shownCount, n);
      assert.deepEqual(item.shownSessions, [sessionId]);
    }
    assert.equal((context.match(/⚠未表示5日/g) || []).length, n === 1 ? 3 : 0);
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
  assert.equal(items.filter(i => i.kind === 'deadline' && i.shownCount).length, 5);
  assert.ok(context.indexOf('期限-8 更新') < context.indexOf('■ ask'));
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
    assert.ok(context.startsWith(`■ 🔴急ぎ ask ${urgent.id}`));
    assert.ok(context.includes(inboxSummary(urgent)));
    assert.ok(context.indexOf(inboxSummary(urgent)) < context.indexOf(deadline.text));
    assert.ok(context.indexOf(inboxSummary(urgent)) < context.indexOf(info.text));
    assert.equal((context.match(/■ ask normal-/g) || []).length, 5);
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
  assert.ok(context.startsWith('■ 🔴急ぎ ask urgent-5'));
  for (const item of urgent.slice(1, 6)) {
    assert.ok(context.includes(inboxSummary(item)));
    assert.equal(item.shownCount, 1);
    assert.deepEqual(item.shownSessions, ['s']);
  }
  assert.equal((context.match(/■ 🔴急ぎ ask/g) || []).length, 5);
  assert.doesNotMatch(context, /切り捨て部分|urgent-0|urgent-6|closed-urgent/);
  assert.equal(urgent[0].shownCount, 0);
  assert.equal(urgent[6].shownCount, 1);
  assert.ok(context.includes(`■ ask ${base.id}`));
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
    if (n === 1) assert.ok(context.startsWith(`■ info ${progress.id}`));
    assert.equal(context.split(`■ ask ${own.id}`).length - 1, 1);
    assert.match(context, /判断に必要な詳細/);
    assert.match(context, /別件の承認依頼/);
    if (n === 1) {
      assert.match(context, /完了通知/);
      assert.match(context, /進捗詳細/);
      for (const item of [own, done, approval]) assert.ok(context.indexOf(progress.id) < context.indexOf(item.id));
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
