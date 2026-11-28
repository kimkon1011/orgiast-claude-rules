import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAsk, pendingFromChat, readKimInboxOpen, renderMarkdown } from './internal-pending-replies.mjs';

const NOW = Date.parse('2026-11-27T10:00:00Z');
const at = h => new Date(NOW - h * 3600000).toISOString();
const chat = { id: '!room307:beeper.local', localChatID: '307', title: '古川未歩', type: 'single' };

test('質問・依頼は拾い、締めのあいさつだけは拾わない', () => {
  assert.equal(isAsk('こちらのPDF自筆の署名じゃないですがよろしでしょうか？'), true);
  assert.equal(isAsk('お声掛けしたほうがよろしいでしょうか'), true);
  assert.equal(isAsk('マニュアルに追記しました。ご確認お願いします。'), true);
  assert.equal(isAsk('承知しました。'), false);
  assert.equal(isAsk('ありがとうございます！'), false);
  assert.equal(isAsk(''), false);
});

test('2026-11-26 の古川さんの質問（画像つき・未返信）を拾う', () => {
  const msgs = [
    { id: '47911', timestamp: at(17), isSender: true, text: '署名した紙の写真を送ってください' },
    { id: '47984', timestamp: at(16), isSender: false, senderName: '古川未歩', text: '', attachments: [{ fileName: 'IMG_9917.jpg' }] },
    { id: '47986', timestamp: at(16), isSender: false, senderName: '古川未歩', text: 'こちら送りました。<br>一点気になりましたが、こちらのPDF自筆の署名じゃないですがよろしでしょうか？' },
    { id: '47989', timestamp: at(15.9), isSender: false, senderName: '古川未歩', text: '自筆の署名対応の場合、本日22時以降の対応になるかと思います。' },
  ];
  const it = pendingFromChat(chat, msgs, { now: NOW });
  assert.ok(it);
  assert.equal(it.chatID, '307');
  assert.equal(it.attachments, 1);
  assert.match(it.asks.map(a => a.text).join('\n'), /自筆の署名じゃないですがよろしでしょうか/);
});

test('こちらが返事した後なら拾わない', () => {
  const msgs = [
    { id: '1', timestamp: at(3), isSender: false, senderName: 'A', text: '確認お願いします' },
    { id: '2', timestamp: at(2), isSender: true, text: '確認しました' },
  ];
  assert.equal(pendingFromChat(chat, msgs, { now: NOW }), null);
});

test('30分未満は次の回に回し、7日より古いものは対象外', () => {
  const fresh = [{ id: '1', timestamp: at(0.2), isSender: false, text: 'いいですか？' }];
  const old = [{ id: '1', timestamp: at(24 * 8), isSender: false, text: 'いいですか？' }];
  assert.equal(pendingFromChat(chat, fresh, { now: NOW }), null);
  assert.equal(pendingFromChat(chat, old, { now: NOW }), null);
});

test('グループは金さん宛てのときだけ拾う', () => {
  const g = { ...chat, type: 'group', title: '倉庫×プロデューサー' };
  assert.equal(pendingFromChat(g, [{ id: '1', timestamp: at(2), isSender: false, text: '大平さん、確認お願いします' }], { now: NOW }), null);
  assert.ok(pendingFromChat(g, [{ id: '1', timestamp: at(2), isSender: false, text: '金功勇 確認お願いします' }], { now: NOW }));
  // 転送文の中に「金さん」とあるだけの社員どうしの会話は拾わない
  assert.equal(pendingFromChat(g, [{ id: '1', timestamp: at(2), isSender: false, text: '↷ Forwarded 金さんの予定と重複 澤山さん 何でやり取りしてましたか？' }], { now: NOW }), null);
});

test('kim-inbox で止まっている判断待ちは、質問の言い回しがなくても拾う', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ipr-'));
  const dir = path.join(home, '.claude', 'kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ki-1.json'), JSON.stringify({ id: 'ki-1', createdAt: at(5), status: 'open', source: 'discord-beeper-autoreply', dedupeKey: `decision:dm:${chat.id}:900`, text: '判断理由: 添付取得失敗: a.png' }));
  fs.writeFileSync(path.join(dir, 'ki-2.json'), JSON.stringify({ id: 'ki-2', createdAt: at(5), status: 'answered', source: 'discord-beeper-autoreply', dedupeKey: `decision:dm:${chat.id}:901` }));
  const open = readKimInboxOpen(home, { now: NOW });
  assert.equal(open.size, 1);
  const it = pendingFromChat(chat, [{ id: '900', timestamp: at(5), isSender: false, text: '', attachments: [{}] }], { now: NOW, kimInboxOpen: open });
  assert.ok(it);
  assert.equal(it.kimInboxId, 'ki-1');
  assert.match(it.reason, /kim-inbox で止まっている/);
  assert.match(renderMarkdown([it], { now: NOW }), /古川未歩（chat 307/);
});

test('ボット・通知の会話は対象外', () => {
  const bot = { ...chat, title: 'clawd-connector' };
  assert.equal(pendingFromChat(bot, [{ id: '1', timestamp: at(2), isSender: false, text: '確認お願いします' }], { now: NOW }), null);
});
