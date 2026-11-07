import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  isLoginUrl,
  isUnread,
  normalizeHref,
  parseConversations,
  splitConversationText,
  clipSnippet,
  conversationKey,
  selectNew,
  trimSeen,
  formatNotification,
  evaluateStall,
  notifyEachEnabled,
  stallHours,
  DEFAULT_STALL_HOURS,
  STALL_BODY,
  FAILURE_BODY,
  RECOVERY_BODY,
  MAX_SEEN,
} from './messenger-watch.mjs';

test('parseArgs: --login と --dry-run を解釈する', () => {
  assert.deepEqual(parseArgs([]), { login: false, dryRun: false });
  assert.deepEqual(parseArgs(['--login']), { login: true, dryRun: false });
  assert.deepEqual(parseArgs(['--dry-run']), { login: false, dryRun: true });
});

test('isLoginUrl: login を含む URL とパスワード欄で判定する', () => {
  assert.equal(isLoginUrl('https://www.facebook.com/login/'), true);
  assert.equal(isLoginUrl('https://www.facebook.com/login.php?next=x'), true);
  assert.equal(isLoginUrl('https://www.facebook.com/messages/'), false);
  assert.equal(isLoginUrl('https://www.facebook.com/messages/', true), true);
  assert.equal(isLoginUrl(null), false);
});

test('isUnread: aria-label / 太字 / 未読表示のいずれかで未読と判定する', () => {
  assert.equal(isUnread({ ariaLabel: 'Unread message from A' }), true);
  assert.equal(isUnread({ ariaLabel: '未読のメッセージ' }), true);
  assert.equal(isUnread({ bold: true }), true);
  assert.equal(isUnread({ text: 'A 12:00 未読 hello' }), true);
  assert.equal(isUnread({ text: 'A 12:00 hello', ariaLabel: '', bold: false }), false);
  assert.equal(isUnread(null), false);
});

test('normalizeHref: クエリ・ハッシュを落とし末尾スラッシュを揃える', () => {
  assert.equal(normalizeHref('/messages/t/123/?foo=bar#x'), '/messages/t/123/');
  assert.equal(normalizeHref('https://www.facebook.com/messages/t/123'), '/messages/t/123/');
  assert.equal(normalizeHref('messages/t/123'), '/messages/t/123/');
  assert.equal(normalizeHref(''), '');
  assert.equal(normalizeHref(null), '');
});

test('splitConversationText: 名前・時刻・抜粋に分解する', () => {
  assert.deepEqual(splitConversationText('田中 12:34 こんにちは'), { name: '田中', snippet: 'こんにちは', time: '12:34' });
  assert.deepEqual(splitConversationText('田中 こんにちは 12:34'), { name: '田中', snippet: 'こんにちは', time: '12:34' });
  assert.deepEqual(splitConversationText(''), { name: '', snippet: '', time: '' });
});

test('splitConversationText: 実測の未読行（オンライン表示・空白入り会話名・経過時間）', () => {
  assert.deepEqual(
    splitConversationText('オンライン中 AI廃人部（多動か過集中の人、大歓迎） 未読メッセージ: ヤマサン: 速報 · 2時間'),
    { name: 'AI廃人部（多動か過集中の人、大歓迎）', snippet: 'ヤマサン: 速報', time: '' },
  );
});

test('parseConversations: 未読だけを抽出し href を正規化・重複排除する', () => {
  const rows = [
    { href: '/messages/t/1/?x=1', text: 'A 12:00 未読 hello', ariaLabel: 'Unread', bold: true },
    { href: '/messages/t/2/', text: 'B 12:01 bye', ariaLabel: '', bold: false },
    { href: '/messages/t/1/', text: 'A 12:00 未読 hello', ariaLabel: 'Unread', bold: true },
    { href: '/not-messages/3/', text: 'C 未読', ariaLabel: 'Unread', bold: true },
  ];
  const out = parseConversations(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].href, '/messages/t/1/');
  assert.equal(out[0].name, 'A');
  assert.equal(out[0].snippet, '未読 hello');
});

test('parseConversations: 空入力・非配列は空配列', () => {
  assert.deepEqual(parseConversations([]), []);
  assert.deepEqual(parseConversations(null), []);
  assert.deepEqual(parseConversations(undefined), []);
});

test('clipSnippet: 80字で切って省略記号を付ける', () => {
  assert.equal(clipSnippet('x'.repeat(80)).length, 80);
  const clipped = clipSnippet('x'.repeat(100));
  assert.equal(clipped.length, 81);
  assert.ok(clipped.endsWith('…'));
});

test('conversationKey: href と snippet が同じなら同じキー、違えば違うキー', () => {
  const a = { href: '/messages/t/1/', snippet: 'hello' };
  const b = { href: '/messages/t/1/?x=1', snippet: 'hello' };
  const c = { href: '/messages/t/1/', snippet: 'bye' };
  assert.equal(conversationKey(a), conversationKey(b));
  assert.notEqual(conversationKey(a), conversationKey(c));
});

test('selectNew: 既読キーにあるものは除外する', () => {
  const conv = [
    { href: '/messages/t/1/', snippet: 'hello' },
    { href: '/messages/t/2/', snippet: 'bye' },
  ];
  const seen = new Set([conversationKey(conv[0])]);
  const fresh = selectNew(conv, seen);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].href, '/messages/t/2/');
});

test('trimSeen: 500件上限で古いものから捨てる', () => {
  const keys = Array.from({ length: 600 }, (_, i) => `k${i}`);
  const trimmed = trimSeen(keys);
  assert.equal(trimmed.length, MAX_SEEN);
  assert.equal(trimmed[0], 'k100');
  assert.equal(trimmed.at(-1), 'k599');
  assert.equal(trimSeen(['a', 'b']).length, 2);
});

test('formatNotification: 件数表記と80字切り、0件は null', () => {
  assert.equal(formatNotification([]), null);
  const body = formatNotification([
    { name: '田中', snippet: 'x'.repeat(100) },
    { name: '', snippet: 'hi' },
  ]);
  const lines = body.split('\n');
  assert.equal(lines[0], '📩 Messenger 新着 2件');
  assert.ok(lines[1].startsWith('・田中: '));
  assert.ok(lines[1].endsWith('…'));
  assert.equal(lines[2], '・(名前不明): hi');
});

test('playwright-core を import せずにテストが走る（動的 import）', () => {
  const source = fs.readFileSync(new URL('./messenger-watch.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('await import("playwright-core")'));
  assert.ok(!/^import .*playwright-core/m.test(source));
});

test('main: --dry-run は通知せず抽出結果を stdout に出す', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-watch-'));
  const out = [];
  const notified = [];
  const fakePage = {
    goto: async () => {},
    url: () => 'https://www.facebook.com/messages/',
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('input[type="password"]')) return false;
      return [{ href: '/messages/t/1/', text: 'A 12:00 未読 hello', ariaLabel: 'Unread', bold: true }];
    },
  };
  const fakeContext = { pages: () => [fakePage], close: async () => {} };
  const fakeChromium = { launchPersistentContext: async () => fakeContext };
  const { main } = await import('./messenger-watch.mjs');
  const code = await main(['--dry-run'], {
    home,
    stdout: (line) => out.push(line),
    stderr: () => {},
    sleep: async () => {},
    executablePath: 'C:/fake/chrome.exe',
    chromium: fakeChromium,
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  });
  assert.equal(code, 0);
  assert.equal(notified.length, 0);
  const parsed = JSON.parse(out.join('\n'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].href, '/messages/t/1/');
});

test('main: 新着があっても既定では通知しない（取り込みは続く）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-watch-'));
  const notified = [];
  const fakePage = {
    goto: async () => {},
    url: () => 'https://www.facebook.com/messages/',
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('input[type="password"]')) return false;
      return [{ href: '/messages/t/1/', text: 'A 12:00 未読 hello', ariaLabel: 'Unread', bold: true }];
    },
  };
  const fakeContext = { pages: () => [fakePage], close: async () => {} };
  const fakeChromium = { launchPersistentContext: async () => fakeContext };
  const { main } = await import('./messenger-watch.mjs');
  const deps = {
    home,
    stdout: () => {},
    stderr: () => {},
    sleep: async () => {},
    executablePath: 'C:/fake/chrome.exe',
    chromium: fakeChromium,
    env: {},
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  };
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 0);
  // 取り込み自体は続いている: 既読キーが保存され、2回目も新着扱いにならない。
  const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'messenger-watch-state.json'), 'utf8'));
  assert.equal(state.seen.length, 1);
  assert.ok(Number.isFinite(state.lastSuccessAt));
});

test('main: MESSENGER_NOTIFY_EACH=1 で従来どおり新着ごとに通知し、同じ会話は2回目に通知しない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-watch-'));
  const notified = [];
  const fakePage = {
    goto: async () => {},
    url: () => 'https://www.facebook.com/messages/',
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('input[type="password"]')) return false;
      return [{ href: '/messages/t/1/', text: 'A 12:00 未読 hello', ariaLabel: 'Unread', bold: true }];
    },
  };
  const fakeContext = { pages: () => [fakePage], close: async () => {} };
  const fakeChromium = { launchPersistentContext: async () => fakeContext };
  const { main } = await import('./messenger-watch.mjs');
  const deps = {
    home,
    stdout: () => {},
    stderr: () => {},
    sleep: async () => {},
    executablePath: 'C:/fake/chrome.exe',
    chromium: fakeChromium,
    env: { MESSENGER_NOTIFY_EACH: '1' },
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  };
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /Messenger 新着 1件/);
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 1);
});

test('main: 取得エラー（例外）は「止まっている」として1日1回だけ通知する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-watch-'));
  const notified = [];
  const fakePage = {
    goto: async () => { throw new Error('net::ERR_CONNECTION_RESET'); },
    url: () => 'https://www.facebook.com/messages/',
    evaluate: async () => [],
  };
  const fakeContext = { pages: () => [fakePage], close: async () => {} };
  const fakeChromium = { launchPersistentContext: async () => fakeContext };
  const { main } = await import('./messenger-watch.mjs');
  const deps = {
    home,
    stdout: () => {},
    stderr: () => {},
    sleep: async () => {},
    executablePath: 'C:/fake/chrome.exe',
    chromium: fakeChromium,
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  };
  assert.equal(await main([], deps), 1);
  assert.equal(notified.length, 1);
  assert.equal(notified[0], FAILURE_BODY);
  // 内部名・コマンド・エラーコードを本文に出さない。
  assert.ok(!/ERR_CONNECTION_RESET|messenger-watch|node tools/.test(notified[0]));
  // 同じ日の2回目は通知しない。
  assert.equal(await main([], deps), 1);
  assert.equal(notified.length, 1);
});

test('main: 最後の成功から既定6時間以上たつと停止を1回だけ通知し、復旧で1回だけ知らせる', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-watch-'));
  const notified = [];
  const fakePage = {
    goto: async () => {},
    url: () => 'https://www.facebook.com/messages/',
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('input[type="password"]')) return false;
      return [{ href: '/messages/t/1/', text: 'A 12:00 未読 hello', ariaLabel: 'Unread', bold: true }];
    },
  };
  const fakeContext = { pages: () => [fakePage], close: async () => {} };
  const fakeChromium = { launchPersistentContext: async () => fakeContext };
  const { main } = await import('./messenger-watch.mjs');
  const stateFile = path.join(home, '.claude', 'messenger-watch-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const nowMs = Date.parse('2026-10-13T12:00:00Z');
  // 最後の成功は 7 時間前 → 既定 6 時間を超えて停止中。
  fs.writeFileSync(stateFile, JSON.stringify({ seen: [], loginNotifiedAt: null, lastSuccessAt: nowMs - 7 * 3600 * 1000 }));
  const deps = {
    home,
    stdout: () => {},
    stderr: () => {},
    sleep: async () => {},
    now: () => nowMs,
    executablePath: 'C:/fake/chrome.exe',
    chromium: fakeChromium,
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  };
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0], STALL_BODY(DEFAULT_STALL_HOURS));
  assert.match(notified[0], /6時間止まっています/);
  // 停止通知の実行自体は成功しているので、次の実行で復旧を1回だけ知らせる。
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 2);
  assert.equal(notified[1], RECOVERY_BODY);
  // 復旧通知は1回だけ。以降は静か。
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 2);
  // 翌日にまた止まったら、改めて1回だけ停止を知らせる。
  const nextDay = nowMs + 24 * 3600 * 1000;
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), lastSuccessAt: nextDay - 7 * 3600 * 1000 }));
  assert.equal(await main([], { ...deps, now: () => nextDay }), 0);
  assert.equal(notified.length, 3);
  assert.equal(notified[2], STALL_BODY(DEFAULT_STALL_HOURS));
});

test('main: MESSENGER_STALL_HOURS で停止とみなす時間を変えられる', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-watch-'));
  const notified = [];
  const fakePage = {
    goto: async () => {},
    url: () => 'https://www.facebook.com/messages/',
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('input[type="password"]')) return false;
      return [{ href: '/messages/t/1/', text: 'A 12:00 未読 hello', ariaLabel: 'Unread', bold: true }];
    },
  };
  const fakeContext = { pages: () => [fakePage], close: async () => {} };
  const fakeChromium = { launchPersistentContext: async () => fakeContext };
  const { main } = await import('./messenger-watch.mjs');
  const stateFile = path.join(home, '.claude', 'messenger-watch-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const nowMs = Date.parse('2026-10-13T12:00:00Z');
  // 最後の成功は 2 時間前。既定 6 時間では止まっていないが、1 時間設定なら停止。
  fs.writeFileSync(stateFile, JSON.stringify({ seen: [], loginNotifiedAt: null, lastSuccessAt: nowMs - 2 * 3600 * 1000 }));
  const deps = {
    home,
    stdout: () => {},
    stderr: () => {},
    sleep: async () => {},
    now: () => nowMs,
    executablePath: 'C:/fake/chrome.exe',
    chromium: fakeChromium,
    env: { MESSENGER_STALL_HOURS: '1' },
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  };
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0], STALL_BODY(1));
  assert.match(notified[0], /1時間止まっています/);
});

test('evaluateStall: 停止していない時は通知せず、停止→復旧で1回だけ知らせる', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  // 直前に成功していて、停止通知もしていない → 何もしない。
  assert.deepEqual(
    evaluateStall({ now, state: { lastSuccessAt: now - 60 * 1000 } }),
    { notify: false, kind: 'none', body: null, state: { lastSuccessAt: now - 60 * 1000 } },
  );
  // 6時間以上成功していない → 停止を1回通知。
  const stalled = evaluateStall({ now, state: { lastSuccessAt: now - 7 * 3600 * 1000 } });
  assert.equal(stalled.notify, true);
  assert.equal(stalled.kind, 'stall');
  assert.equal(stalled.body, STALL_BODY(DEFAULT_STALL_HOURS));
  // 同じ日の2回目は抑止。
  assert.equal(evaluateStall({ now, state: stalled.state }).notify, false);
  // 復旧 → 1回だけ知らせ、停止フラグを消す。
  const recovered = evaluateStall({ now, state: { ...stalled.state, lastSuccessAt: now } });
  assert.equal(recovered.kind, 'recovery');
  assert.equal(recovered.body, RECOVERY_BODY);
  assert.equal(recovered.state.lastStallNotifiedAt, null);
  // 復旧通知も1回だけ。
  assert.equal(evaluateStall({ now, state: { ...recovered.state, lastSuccessAt: now } }).notify, false);
});

test('evaluateStall: 失敗は1日1回だけ通知し、成功が続けば復旧を知らせる', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const failed = evaluateStall({ now, state: { lastSuccessAt: now - 60 * 1000 }, failure: true });
  assert.equal(failed.kind, 'failure');
  assert.equal(failed.body, FAILURE_BODY);
  assert.equal(evaluateStall({ now, state: failed.state, failure: true }).notify, false);
  const recovered = evaluateStall({ now, state: { ...failed.state, lastSuccessAt: now } });
  assert.equal(recovered.kind, 'recovery');
  assert.equal(recovered.body, RECOVERY_BODY);
});

test('notifyEachEnabled / stallHours: env の解釈', () => {
  assert.equal(notifyEachEnabled({}), false);
  assert.equal(notifyEachEnabled({ MESSENGER_NOTIFY_EACH: '1' }), true);
  assert.equal(notifyEachEnabled({ MESSENGER_NOTIFY_EACH: 'true' }), true);
  assert.equal(notifyEachEnabled({ MESSENGER_NOTIFY_EACH: '0' }), false);
  assert.equal(stallHours({}), DEFAULT_STALL_HOURS);
  assert.equal(stallHours({ MESSENGER_STALL_HOURS: '12' }), 12);
  assert.equal(stallHours({ MESSENGER_STALL_HOURS: '0' }), DEFAULT_STALL_HOURS);
  assert.equal(stallHours({ MESSENGER_STALL_HOURS: 'abc' }), DEFAULT_STALL_HOURS);
});

test('通知本文は内部名・コマンド・エラーコードを含まない', () => {
  for (const body of [STALL_BODY(6), FAILURE_BODY, RECOVERY_BODY]) {
    assert.ok(!/messenger-watch|node tools|\.mjs|Error|ERR_|playwright/i.test(body), body);
  }
  assert.equal(STALL_BODY(6), '⚠️ Messenger のメッセージ取り込みが6時間止まっています。こちらで直します。');
  assert.equal(RECOVERY_BODY, '✅ Messenger の取り込みが元に戻りました');
});

test('main: ログイン切れは1日1回だけ通知して exit 2', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-watch-'));
  const notified = [];
  const fakePage = {
    goto: async () => {},
    url: () => 'https://www.facebook.com/login/',
    evaluate: async (fn) => (String(fn).includes('input[type="password"]') ? true : []),
  };
  const fakeContext = { pages: () => [fakePage], close: async () => {} };
  const fakeChromium = { launchPersistentContext: async () => fakeContext };
  const { main } = await import('./messenger-watch.mjs');
  const deps = {
    home,
    stdout: () => {},
    stderr: () => {},
    sleep: async () => {},
    executablePath: 'C:/fake/chrome.exe',
    chromium: fakeChromium,
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  };
  assert.equal(await main([], deps), 2);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /ログインが切れています/);
  assert.equal(await main([], deps), 2);
  assert.equal(notified.length, 1);
});
