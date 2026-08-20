import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preprocessMessages, parseClassifications, replaceMarkerSection, appendUniqueProposals, updateTopics, filterDigestLines, runDigest } from './line-digest.mjs';

test('前処理が短文・あいさつ・スタンプ通知を落とす', () => {
  const input = ['こんにちは', 'ありがとうございます', 'スタンプを送信しました', 'GPT-5公開', 'これは十分な長さがある有用な生成AIニュースの本文です'].map((text, i) => ({ id: String(i), text }));
  assert.deepEqual(preprocessMessages(input).map((x) => x.text), ['GPT-5公開', 'これは十分な長さがある有用な生成AIニュースの本文です']);
});

test('同一本文の表記揺れを1件に畳む', () => {
  const items = preprocessMessages([{ text: 'ＡＩに関する同じニュースが公開されました。' }, { text: 'AIに関する同じニュースが公開されました。' }]);
  assert.equal(items.length, 1);
});

test('具体情報を含まない注意書きだけのdigest行を捨てる', () => {
  assert.deepEqual(filterDigestLines([
    '情報は伝聞であり、未検証。',
    '裏付けがありません。',
    'Groqの新モデル情報は未検証。',
    '1Mトークンの料金情報は要検証。',
  ]), ['Groqの新モデル情報は未検証。', '1Mトークンの料金情報は要検証。']);
});

test('壊れた分類JSONを復旧する', () => {
  const raw = '前置き```json\n[{"i":0,"keep":true,"category":"cost","score":3,"why":"値下げ",},]\n```後置き';
  assert.deepEqual(parseClassifications(raw), [{ i: 0, keep: true, category: 'cost', score: 3, why: '値下げ' }]);
});

test('マーカー外を保持し、マーカーなしなら追加する', () => {
  assert.equal(replaceMarkerSection('前\n<!-- AI-NEWS-START -->\n旧\n<!-- AI-NEWS-END -->\n後', '新'), '前\n<!-- AI-NEWS-START -->\n新\n<!-- AI-NEWS-END -->\n後');
  assert.match(replaceMarkerSection('利用者メモ', '新'), /^利用者メモ\n\n<!-- AI-NEWS-START -->/);
});

test('pendingの同一titleは追記しない', () => {
  const old = JSON.stringify({ id: 'P-0001', status: 'pending', title: 'GPT 値下げ' }) + '\n';
  const result = appendUniqueProposals(old, [{ title: 'ＧＰＴ  値下げ', action: '確認', category: 'cost', confidence: 'high' }]);
  assert.equal(result.added.length, 0);
});

test('stateにより2回目は同じメッセージを処理しない', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'line-digest-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'line-openchat'); fs.mkdirSync(dir, { recursive: true });
  const message = { id: 'm1', text: 'Claudeの新モデルが公開され料金情報も更新されたというニュースです。', ts: Date.now() };
  fs.writeFileSync(path.join(dir, '2026-08.jsonl'), JSON.stringify(message) + '\n');
  let calls = 0;
  const llm = async ({ messages }) => { calls++; return { text: messages[0].content.includes('scoreは') ? '[{"i":0,"keep":true,"category":"model-release","score":3,"why":"新モデル"}]' : '{"digest":["参加者による新モデル情報（要検証）","料金情報が更新（要検証）","公式発表の確認が必要"],"proposals":[]}' }; };
  const first = await runDigest({ home, llm, args: [], log() {} });
  const second = await runDigest({ home, llm, args: [], log() {} });
  assert.equal(first.processed, 1); assert.equal(second.processed, 0); assert.equal(calls, 2);
});

test('分類が全滅したとき出力ファイルを一切書かない', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'line-digest-failed-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'line-openchat'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-08.jsonl'), JSON.stringify({ id: 'failed', text: '分類処理に渡すための十分な長さがある生成AI関連ニュースです。', ts: Date.now() }) + '\n');
  await assert.rejects(runDigest({ home, llm: async () => ({ text: '壊れた応答' }), args: [], log() {} }), /処理できたメッセージがありません/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'ai-news-digest.md')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'ai-news-proposals.jsonl')), false);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('topicsは31日前を描画対象から除外しファイル用データからも削除する', () => {
  const now = Date.now();
  const old = { id: 'old', ts: now - 31 * 24 * 60 * 60 * 1000, category: 'tool', line: '古い話題' };
  const recent = { id: 'recent', ts: now - 3 * 24 * 60 * 60 * 1000, category: 'cost', line: '新しい話題' };
  const result = updateTopics(`${JSON.stringify(old)}\n${JSON.stringify(recent)}\n`, [], now, now);
  assert.deepEqual(result.records.map((topic) => topic.line), ['新しい話題']);
  assert.doesNotMatch(result.text, /古い話題/);
});

test('同一トピックは2回追記されない', () => {
  const now = Date.now();
  const first = updateTopics('', ['同じAIニュース（要検証）'], now, now);
  const second = updateTopics(first.text, ['同じAIニュース（要検証）'], now, now);
  assert.equal(second.records.length, 1);
});

test('topicsが0件なら情報なしの1行を描画する', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'line-digest-empty-topics-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'line-openchat'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-08.jsonl'), JSON.stringify({ id: 'low', text: '重要度判定に渡すための十分な長さがある生成AI関連ニュースです。', ts: Date.now() }) + '\n');
  const llm = async () => ({ text: '[{"i":0,"keep":false,"category":"other","score":1,"why":"重要度が低い"}]' });
  await runDigest({ home, llm, args: [], log() {} });
  assert.match(fs.readFileSync(path.join(home, '.claude', 'ai-news-digest.md'), 'utf8'), /（直近30日で拾えた情報はありません）/);
});

async function runClassificationCase(t, classification, summary = '{"digest":["採用された生成AIニュース（要検証）","追加情報を公式確認中","参加者の共有内容"],"proposals":[]}') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'line-digest-classification-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'line-openchat'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-08.jsonl'), JSON.stringify({ id: 'classification', text: '生成AIの料金と新モデルについて十分な長さがある有用なニュースです。', ts: Date.now() }) + '\n');
  const calls = [];
  const llm = async (request) => { calls.push(request); return { text: calls.length === 1 ? classification : summary }; };
  const result = await runDigest({ home, llm, args: [], log() {} });
  return { home, result, calls };
}

test('keep無しの素の配列でもscore 2なら採用する', async (t) => {
  const { home, calls } = await runClassificationCase(t, '[{"i":0,"category":"cost","score":2}]');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.responseFormat), [{ type: 'json_object' }, { type: 'json_object' }]);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'ai-news-topics.jsonl'), 'utf8'), /採用された生成AIニュース/);
});

test('items配列でもscore 2なら採用し、score 1は採用しない', async (t) => {
  const adopted = await runClassificationCase(t, '{"items":[{"i":0,"category":"cost","score":2}]}');
  assert.equal(adopted.calls.length, 2);
  const rejected = await runClassificationCase(t, '{"items":[{"i":0,"category":"tool","score":1}]}');
  assert.equal(rejected.calls.length, 1);
  assert.match(fs.readFileSync(path.join(rejected.home, '.claude', 'ai-news-digest.md'), 'utf8'), /（直近30日で拾えた情報はありません）/);
});

test('分類JSONのパース失敗時は1回だけ再試行して成功する', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'line-digest-retry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'line-openchat'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-08.jsonl'), JSON.stringify({ id: 'retry', text: '再試行を検証するために十分な長さがある生成AI関連ニュースです。', ts: Date.now() }) + '\n');
  const replies = ['壊れた応答', '{"items":[{"i":0,"category":"quality","score":2}]}', '{"digest":["再試行後に採用された話題","品質情報は要検証","公式情報を確認する"],"proposals":[]}'];
  const systems = [];
  await runDigest({ home, llm: async ({ messages }) => { systems.push(messages[0].content); return { text: replies.shift() }; }, args: [], log() {} });
  assert.equal(systems.length, 3);
  assert.match(systems[1], /前回の応答はJSONとして解釈できなかった/);
});

test('2段目のdigestとproposalsをtopicsと本文へ反映する', async (t) => {
  const summary = '{"digest":["要約段で生成した話題（要検証）","関連する価格情報（要検証）","公式発表を確認予定"],"proposals":[{"title":"価格設定を確認","action":"公式料金を確認（要検証）","evidence":"参加者の料金共有","category":"cost","confidence":"medium"}]}';
  const { home } = await runClassificationCase(t, '{"items":[{"i":0,"category":"cost","score":3}]}', summary);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'ai-news-topics.jsonl'), 'utf8'), /要約段で生成した話題/);
  const digest = fs.readFileSync(path.join(home, '.claude', 'ai-news-digest.md'), 'utf8');
  assert.match(digest, /要約段で生成した話題/);
  assert.match(digest, /価格設定を確認/);
});
