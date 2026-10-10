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

test('main: 新着を通知し、同じ会話は2回目に通知しない', async () => {
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
    notify: async (text) => { notified.push(text); return { delivered: 'dm' }; },
  };
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /Messenger 新着 1件/);
  assert.equal(await main([], deps), 0);
  assert.equal(notified.length, 1);
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
