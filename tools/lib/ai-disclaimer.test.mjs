import assert from 'node:assert/strict';
import test from 'node:test';
import { LINE_AI_DISCLAIMER, MAIL_AI_DISCLAIMER, MESSAGE_AI_DISCLAIMER, channelFromBeeperChat, hasAiDisclaimer, runCli, withAiDisclaimer } from './ai-disclaimer.mjs';

test('チャット本文に空行を挟んで付与し、2回適用しても増えない', () => {
  const once = withAiDisclaimer('こんにちは  \n', { channel: 'discord' });
  assert.equal(once, `こんにちは\n\n${MESSAGE_AI_DISCLAIMER}`);
  assert.equal(withAiDisclaimer(once, { channel: 'discord' }), once);
});

test('過去表記を本文先頭で検出する', () => {
  const text = 'このLINEは、金の指示でAIが代わりに作成・送信しています。\n本文';
  assert.equal(hasAiDisclaimer(text), true);
  assert.equal(withAiDisclaimer(text, { channel: 'line' }), text);
});

test('メールは後半の署名区切り直前に付与する', () => {
  assert.equal(withAiDisclaimer('本文\n続き\n-- \n金 功勇', { channel: 'mail' }), `本文\n続き\n\n${MAIL_AI_DISCLAIMER}\n\n-- \n金 功勇`);
});

test('空本文には付けない', () => assert.equal(withAiDisclaimer('  \n', { channel: 'mail' }), '  \n'));

test('channel 別の文言', () => {
  assert.match(withAiDisclaimer('本文', { channel: 'line' }), new RegExp(LINE_AI_DISCLAIMER));
  assert.match(withAiDisclaimer('本文', { channel: 'mail' }), new RegExp(MAIL_AI_DISCLAIMER));
  assert.match(withAiDisclaimer('本文', { channel: 'other' }), new RegExp(MESSAGE_AI_DISCLAIMER));
});

test('Beeper チャット情報から channel を決める', () => {
  assert.equal(channelFromBeeperChat({ accountID: 'LINE-main' }), 'line');
  assert.equal(channelFromBeeperChat({ network: 'discord' }), 'discord');
  assert.equal(channelFromBeeperChat(null), 'other');
  assert.equal(channelFromBeeperChat({ accountID: 'line', network: 'LINE' }), 'line');
  assert.equal(channelFromBeeperChat({ accountID: 'discordgo', title: 'online 会議' }), 'discord');
  assert.equal(channelFromBeeperChat({ accountID: 'whatsapp', title: 'online' }), 'other');
});

test('CLI は出力ファイルと標準出力を同じ最終本文にする', () => {
  let written = '', stdout = '';
  const result = runCli(['--channel', 'discord', '--in', 'in.txt', '--out', 'out.txt'], {
    readFile: () => '本文', writeFile: (_path, value) => { written = value; }, stdout: value => { stdout = value; },
  });
  assert.equal(written, result);
  assert.equal(stdout, result);
  assert.match(result, /金の指示でAIが/u);
});
