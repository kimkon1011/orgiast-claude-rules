import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesBeeperText, matchesStandingReadback } from './beeper-send.mjs';

// Representation read from the Desktop API for the 2026-11-20 daily post.
const text = '【今日のインスタ用 写真のお願い】11/20（金）\nテーマ：蒸し牡蠣プラン開始\nお願い：夕食の蒸し牡蠣を湯気が出ているうちに真上と斜めから2枚。レモン・網焼きは写さない。\n\nこのグループに、写真1〜3枚と一言コメント（20字くらい）をお昼12時までに送ってください。\n写真の明るさ調整と投稿文はこちらで作ります。お客様のお顔・車のナンバーは写さないでください。';
const html = '<p>【今日のインスタ用 写真のお願い】11/20（金）<br>テーマ：蒸し牡蠣プラン開始<br>お願い：夕食の蒸し牡蠣を湯気が出ているうちに真上と斜めから2枚。レモン・網焼きは写さない。</p>\n<p>このグループに、写真1〜3枚と一言コメント（20字くらい）をお昼12時までに送ってください。<br>写真の明るさ調整と投稿文はこちらで作ります。お客様のお顔・車のナンバーは写さないでください。</p>';
const message = { id: '17763', chatID: 'fixture-chat', senderID: '@kimkon1011:beeper.com', isSender: true,
  isDeleted: false, mentions: null, timestamp: '2026-11-20T00:00:13.453Z', text: html };
const scope = { text, chatID: 'fixture-chat', dispatchedAt: Date.parse('2026-11-20T00:00:11.499Z'), observedAt: Date.parse('2026-11-20T00:00:29.383Z') };

test('observed HTML body matches every character and line of the sent daily post', () => {
  assert.notEqual(html, text, 'old strict comparison reproduces the failure');
  assert.equal(matchesStandingReadback(message, scope), true);
  assert.equal(matchesStandingReadback({ ...message, text, mentions: [] }, scope), true);
});

for (const [label, change] of [
  ['changed suffix', { text: html.replace('写さないでください。', '写してください。') }],
  ['missing paragraph break', { text: html.replace('</p>\n<p>', '<br>') }],
  ['extra whitespace', { text: html.replace('テーマ：', 'テーマ： ') }],
  ['mention anchor', { text: '<a href="https://matrix.to/#/@other:beeper.com">@other</a><br>' + html, mentions: ['@other:beeper.com'] }],
  ['hidden markup', { text: html.replace('<p>', '<p style="display:none">') }],
  ['other sender', { isSender: false }],
  ['other identity', { senderID: '@other:beeper.com' }],
  ['missing identity', { senderID: undefined }],
  ['other chat', { chatID: 'other-chat' }],
  ['missing chat', { chatID: undefined }],
  ['deleted message', { isDeleted: true }],
  ['missing message ID', { id: '' }],
  ['before dispatch', { timestamp: '2026-11-20T00:00:11.498Z' }],
  ['after observation', { timestamp: '2026-11-20T00:00:29.384Z' }],
  ['invalid timestamp', { timestamp: 'invalid' }],
]) test(`strict readback rejects ${label}`, () => {
  assert.equal(matchesStandingReadback({ ...message, ...change }, scope), false);
});

test('HTML escaping is decoded once; significant whitespace and unsupported markup stay distinct', () => {
  assert.equal(matchesBeeperText('<p>A &amp; B &lt; C &quot;D&quot; &#39;E&#39;<br>F</p>', 'A & B < C "D" \'E\'\nF'), true);
  assert.equal(matchesBeeperText('<p>&amp;lt;</p>', '&lt;'), true);
  assert.equal(matchesBeeperText('<p>&amp;lt;</p>', '<'), false);
  assert.equal(matchesBeeperText('<p>A  B</p>', 'A B'), false);
  assert.equal(matchesBeeperText('<p>A<br><br>B</p>', 'A\nB'), false);
  assert.equal(matchesBeeperText('<p><a href="https://matrix.to/#/@x">A</a></p>', 'A'), false);
});
