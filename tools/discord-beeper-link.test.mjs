import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDiscordLink, getDiscordChannelID, extractDiscordUserID } from './discord-beeper-link.mjs';

/**
 * Creates a temporary SQLite database with fixture data for testing.
 */
function createFixtureDb(t, { discordChannelID = '1547513352513790113' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-beeper-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'BeeperTexts', 'index.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (threadID TEXT, accountID TEXT, thread TEXT)');
  const thread = JSON.stringify({
    id: '!7WqVOzgmzsHP3reyxbmy:beeper.local',
    extra: {
      bridge: {
        bridgebot: '@discordgobot:beeper.local',
        channel: { id: discordChannelID, 'fi.mau.receiver': '715210673642012733' },
        protocol: { id: 'discordgo', displayname: 'Discord' },
      },
    },
    type: 'group',
  });
  db.prepare('INSERT INTO threads (threadID, accountID, thread) VALUES (?, ?, ?)').get('!7WqVOzgmzsHP3reyxbmy:beeper.local', 'discordgo.715210673642012733', thread);
  db.close();
  return { dir, dbPath };
}

function openDb(dir) {
  return new DatabaseSync(path.join(dir, 'BeeperTexts', 'index.db'), { readOnly: true });
}

test('getDiscordChannelID: 正常に Discord チャンネルIDを取得', t => {
  const { dir } = createFixtureDb(t);
  const db = openDb(dir);
  const id = getDiscordChannelID(db, '!7WqVOzgmzsHP3reyxbmy:beeper.local');
  assert.equal(id, '1547513352513790113');
  db.close();
});

test('getDiscordChannelID: 存在しないスレッドIDは null', t => {
  const { dir } = createFixtureDb(t);
  const db = openDb(dir);
  assert.equal(getDiscordChannelID(db, '999'), null);
  db.close();
});

test('getDiscordChannelID: DB がない場合は null', () => {
  assert.equal(getDiscordChannelID(null, '828'), null);
});

test('extractDiscordUserID: 正規の senderID からユーザーIDを抽出', () => {
  assert.equal(extractDiscordUserID('@discordgo_964571963634876476:beeper.local'), '964571963634876476');
  assert.equal(extractDiscordUserID('@discordgo_1423319951980232744:beeper.local'), '1423319951980232744');
});

test('extractDiscordUserID: 非 Discord の senderID は null', () => {
  assert.equal(extractDiscordUserID('@kimkon1011:beeper.com'), null);
  assert.equal(extractDiscordUserID(null), null);
  assert.equal(extractDiscordUserID(''), null);
});

test('resolveDiscordLink: 優先度① ネイティブ Discord URL があればそれを返す', () => {
  const chat = { id: '828', title: '相談' };
  const msg = { discordUrl: 'https://discord.com/channels/@me/123456789012345678/234567890123456789' };
  assert.equal(resolveDiscordLink(chat, msg), 'https://discord.com/channels/@me/123456789012345678/234567890123456789');
});

test('resolveDiscordLink: 優先度② DB からチャンネルIDを取得してリンクを作成', t => {
  const { dir } = createFixtureDb(t);
  const chat = { id: '!7WqVOzgmzsHP3reyxbmy:beeper.local', title: '相談' };
  const msg = {};
  const link = resolveDiscordLink(chat, msg, { appData: dir });
  assert.equal(link, 'https://discord.com/channels/@me/1547513352513790113');
});

test('resolveDiscordLink: 優先度② メッセージIDもあればチャンネル＋メッセージリンク', t => {
  const { dir } = createFixtureDb(t);
  const chat = { id: '!7WqVOzgmzsHP3reyxbmy:beeper.local', title: '相談' };
  const msg = { discordMessageID: '234567890123456789' };
  const link = resolveDiscordLink(chat, msg, { appData: dir });
  assert.equal(link, 'https://discord.com/channels/@me/1547513352513790113/234567890123456789');
});

test('resolveDiscordLink: 優先度③ 個人DMで相手のDiscordユーザーIDからリンク', () => {
  const chat = { type: 'single', title: '白石秋子' };
  const msg = { senderID: '@discordgo_964571963634876476:beeper.local' };
  assert.equal(resolveDiscordLink(chat, msg), 'https://discord.com/users/964571963634876476');
});

test('resolveDiscordLink: 優先度③ 参加者リストから相手のユーザーID', () => {
  const chat = {
    type: 'single',
    title: '白石秋子',
    participants: { items: [
      { id: '@kimkon1011:beeper.com', isSelf: true },
      { id: '@discordgo_964571963634876476:beeper.local', isSelf: false },
    ]},
  };
  const msg = {};
  assert.equal(resolveDiscordLink(chat, msg), 'https://discord.com/users/964571963634876476');
});

test('resolveDiscordLink: 優先度④ Discord情報がなければ会話名', () => {
  const chat = { id: '828', title: '相談', deepLink: 'beeper://room/abc' };
  assert.equal(resolveDiscordLink(chat, {}), '会話名: 相談');
});

test('resolveDiscordLink: 優先度④ 何もなければ会話名でフォールバック', () => {
  const chat = { id: '828', title: '相談' };
  assert.equal(resolveDiscordLink(chat, {}), '会話名: 相談');
});

test('resolveDiscordLink: DB がなくても会話名でフォールバック', () => {
  const chat = { id: '!7WqVOzgmzsHP3reyxbmy:beeper.local', title: '相談' };
  // DB が存在しないディレクトリを指定
  const link = resolveDiscordLink(chat, {}, { appData: '/nonexistent/path' });
  assert.equal(link, '会話名: 相談');
});

test('resolveDiscordLink: タイトルが無ければ ID でフォールバック', () => {
  const chat = { id: 'unknown-room' };
  assert.equal(resolveDiscordLink(chat, {}), '会話名: unknown-room');
});

test('実DB形状: API room IDで解決し、Beeper localChatID/messageIDをリンクに使わない', t => {
  const { dir } = createFixtureDb(t);
  const c = { id: '!7WqVOzgmzsHP3reyxbmy:beeper.local', localChatID: '828', type: 'group' };
  assert.equal(resolveDiscordLink(c, { id: '7405' }, { appData: dir }), 'https://discord.com/channels/@me/1547513352513790113');
  assert.equal(resolveDiscordLink({ id: '828', title: '相談' }, { id: '7405' }, { appData: dir }), '会話名: 相談');
});

test('優先度①: 同じroom・messageのイベントexternal_urlだけを採用', t => {
  const { dir, dbPath } = createFixtureDb(t);
  const room = '!7WqVOzgmzsHP3reyxbmy:beeper.local';
  const url = 'https://discord.com/channels/@me/1547513352513790113/234567890123456789';
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE mx_room_messages (id INTEGER, roomID TEXT, eventID TEXT, message TEXT); CREATE TABLE mx_events (roomID TEXT, eventID TEXT, event TEXT)');
  db.prepare('INSERT INTO mx_room_messages VALUES (?, ?, ?, ?)').run(7405, room, '$event', '{}');
  db.prepare('INSERT INTO mx_events VALUES (?, ?, ?)').run(room, '$event', JSON.stringify({ content: { external_url: url } }));
  db.close();
  const c = { id: room, localChatID: '828' };
  assert.equal(resolveDiscordLink(c, { id: '7405' }, { appData: dir }), url);
  assert.equal(resolveDiscordLink(c, { id: '7406' }, { appData: dir }), 'https://discord.com/channels/@me/1547513352513790113');
});

test('優先度③: グループは質問者のプロフィールと会話名、無関係な参加者を使わない', () => {
  const c = { type: 'group', title: '相談', participants: { items: [{ id: '@discordgo_1423319951980232744:beeper.local' }] } };
  assert.equal(resolveDiscordLink(c, { senderID: '@discordgo_964571963634876476:beeper.local' }), 'https://discord.com/users/964571963634876476\n会話名: 相談');
  assert.equal(resolveDiscordLink(c, {}), '会話名: 相談');
});

test('不正なbridge IDと壊れたJSONは安全にフォールバック', t => {
  const { dir, dbPath } = createFixtureDb(t, { discordChannelID: '828' });
  const c = { id: '!7WqVOzgmzsHP3reyxbmy:beeper.local', title: '相談' };
  assert.equal(resolveDiscordLink(c, {}, { appData: dir }), '会話名: 相談');
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE threads SET thread=?').run('{broken'); db.close();
  assert.equal(resolveDiscordLink(c, {}, { appData: dir }), '会話名: 相談');
});
