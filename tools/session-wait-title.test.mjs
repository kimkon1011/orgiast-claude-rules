import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply as applyReal, currentTitles, desiredTitle, isCloseRitualOnly, sweepAll as sweepAllReal, waitPrefix } from './session-wait-title.mjs';

const apply = input => applyReal(input, { resolvePcNumber: () => '' });
const sweepAll = options => sweepAllReal({ ...options, resolvePcNumber: () => '' });

const footer = state => `本文\n\n次に kim がすること: なし\nこの後の自動進行: 毎時の見張りが保存を確かめて報告する\nこのセッション: ${state}`;
const ai = JSON.stringify({ type: 'ai-title', aiTitle: 'トークン待ち', sessionId: 's' });
const custom = title => JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 's' });
const WAIT = 'まだ閉じない（作業中・2026-11-02 20:11 まで待つ）';

test('実例の新しいタブで Enter・古いタブを閉じるフッターに【閉じて可】を付ける', () => {
  const text = `次に kim がすること: タブバーの一番右にある新しいタブで Enter を1回押し、この古いタブを ✕ で閉じる
この後の自動進行: なし
このセッション: /session-close は終わっているので、このセッションを閉じてよい`;
  assert.equal(desiredTitle(text, ai), '【閉じて可】トークン待ち');
});

test('Enter・タブを閉じる操作は単独でも閉じて可', () => {
  for (const action of ['新しいタブで Enter を1回押す', 'このタブを ✕ で閉じる']) {
    assert.equal(desiredTitle(withAction(action, CLOSED), ai), '【閉じて可】トークン待ち');
  }
});

test('承認が混ざる操作やサービス登録では閉じて可にしない', () => {
  for (const action of ['PR を承認し、このタブを ✕ で閉じる', 'Resend に登録してキーを貼る']) {
    assert.equal(desiredTitle(withAction(action, CLOSED), ai), null);
  }
});

test('閉じる儀式は各区切りの全文を照合して別作業を除外する', () => {
  for (const action of [
    '右端のタブで /session-start を送る→セッションを閉じる。',
    '新しいタブで Enter を押す，タブを閉じる',
    '、。→，',
  ]) assert.equal(isCloseRitualOnly(action), true, action);
  for (const action of [
    '新しいタブで Enter を押す前に確認する',
    'ログインして新しいタブで Enter を押す',
    '新しいタブで Enter を押す、返信する',
    '設定を確認する→このタブを閉じる',
    '新しいタブをクリックする',
  ]) assert.equal(isCloseRitualOnly(action), false, action);
  assert.equal(isCloseRitualOnly(undefined), false);
  assert.equal(desiredTitle(withAction('このタブを閉じる', WAIT), ai), '【11/02/20:11まで】トークン待ち');
});

test('firstPrompt はスキル展開本文と command タグを飛ばして本当の依頼を拾う', () => {
  const user = content => JSON.stringify({ type: 'user', message: { content } });
  for (const content of ['Base directory for this skill: C:\\x', '<command-name>/session-close</command-name>', '<other>展開本文</other>']) {
    const raw = `${user(content)}\n${user('本当の依頼')}`;
    assert.equal(currentTitles(raw).firstPrompt, '本当の依頼');
    assert.equal(desiredTitle('', raw, '008'), '008｜本当の依頼');
  }
  const raw = `${user([{ type: 'text', text: 'Base directory for this skill: C:\\x' }])}\n${user('本当の依頼')}`;
  assert.equal(currentTitles(raw).firstPrompt, '本当の依頼');
});

test('waitPrefix は年なしの【11/02/20:11まで】', () => {
  assert.equal(waitPrefix(new Date(2026, 10, 2, 20, 11)), '【11/02/20:11まで】');
});

test('まだ閉じない（期限入り）なら ai-title の頭に期限を付ける', () => {
  assert.equal(desiredTitle(footer(WAIT), ai), '【11/02/20:11まで】トークン待ち');
  assert.equal(desiredTitle(footer('/session-close をして（まだ閉じない・2026-11-02 20:11 まで待つ）'), ai), '【11/02/20:11まで】トークン待ち');
});

test('期限が変わったら付け替え、同じなら書かない。旧形式（年あり）は新形式へ付け替える', () => {
  assert.equal(desiredTitle(footer(WAIT), `${ai}\n${custom('【11/01/09:00まで】名前付き')}`), '【11/02/20:11まで】名前付き');
  assert.equal(desiredTitle(footer(WAIT), `${ai}\n${custom('【11/02/20:11まで】名前付き')}`), null);
  assert.equal(desiredTitle(footer(WAIT), `${ai}\n${custom('【26/11/02/20:11まで】名前付き')}`), '【11/02/20:11まで】名前付き');
});

const CLOSED = '/session-close は終わっているので、このセッションを閉じてよい';
const DELETE = '/session-close は不要なので、このセッションを閉じてよい';
const withAction = (action, state) => `本文\n\n次に kim がすること: ${action}\nこの後の自動進行: なし（完了）\nこのセッション: ${state}`;

test('閉じてよい＋kim のやることなしなら期限を外して【閉じて可】を付ける（旧形式も）', () => {
  const closed = footer(CLOSED);
  assert.equal(desiredTitle(closed, custom('【11/01/09:00まで】名前付き')), '【閉じて可】名前付き');
  assert.equal(desiredTitle(closed, custom('【26/11/01/09:00まで】名前付き')), '【閉じて可】名前付き');
  assert.equal(desiredTitle(closed, ai), '【閉じて可】トークン待ち');
  assert.equal(desiredTitle(footer(DELETE), ai), '【閉じて可】トークン待ち');
  assert.equal(desiredTitle(withAction('なし（完了）', DELETE), ai), '【閉じて可】トークン待ち');
  assert.equal(desiredTitle(closed, custom('【閉じて可】名前付き')), null);
});

test('kim のやることが残るなら閉じてよいでも【閉じて可】を付けず、付いていれば外す', () => {
  const pending = withAction('請求書PDFを先方へ手渡しする', DELETE);
  assert.equal(desiredTitle(pending, ai), null);
  assert.equal(desiredTitle(pending, custom('【閉じて可】名前付き')), '名前付き');
  assert.equal(desiredTitle(pending, custom('【11/01/09:00まで】名前付き')), '名前付き');
});

test('再開して待ちに戻ったら【閉じて可】を期限に付け替え、フッター無しなら印を保持する', () => {
  assert.equal(desiredTitle(footer(WAIT), custom('【閉じて可】名前付き')), '【11/02/20:11まで】名前付き');
  assert.equal(desiredTitle('フッターなし', custom('【閉じて可】名前付き')), null);
  assert.equal(desiredTitle('フッターなし', custom('【11/01/09:00まで】名前付き')), null);
  assert.equal(desiredTitle('本文', custom('【閉じて可】名前'), '018'), '018｜【閉じて可】名前');
});

const assistant = text => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('apply は transcript に custom-title 行を追記し、subagent には書かない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${ai}\n${assistant(footer(WAIT))}\n`);
  assert.equal(apply({ transcript_path: file, session_id: 's' }), '【11/02/20:11まで】トークン待ち');
  const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(last, { type: 'custom-title', customTitle: '【11/02/20:11まで】トークン待ち', sessionId: 's', source: 'orgiast-auto' });
  assert.equal(apply({ transcript_path: file, session_id: 's' }), null);
  assert.equal(apply({ transcript_path: path.join(dir, 'subagents', 'x.jsonl'), session_id: 's' }), null);
});

test('sweepAll は全プロジェクトの待ちセッションに付け、1時間以内の再実行は飛ばす', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-all-'));
  const proj = path.join(base, 'projects', 'p1');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'aaaaaaaa-1.jsonl'), `${ai}\n${assistant(footer(WAIT))}\n`);
  fs.writeFileSync(path.join(proj, 'bbbbbbbb-2.jsonl'), `${ai}\n${assistant(footer('/session-close は不要なので、このセッションを閉じてよい'))}\n`);
  const now = Date.now();
  const result = sweepAll({ base, now });
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.titled.sort((a, b) => a.session.localeCompare(b.session)), [
    { session: 'aaaaaaaa', title: '【11/02/20:11まで】トークン待ち' },
    { session: 'bbbbbbbb', title: '【閉じて可】トークン待ち' },
  ]);
  const last = JSON.parse(fs.readFileSync(path.join(proj, 'aaaaaaaa-1.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(last.sessionId, 'aaaaaaaa-1');
  assert.deepEqual(sweepAll({ base, now: now + 1000 }), { skipped: 'cooldown' });
});

const auto = title => JSON.stringify({ type: 'custom-title', customTitle: title, source: 'orgiast-auto' });
test('firstPrompt は Stop hook feedback と他のノイズを空白付きでも飛ばす', () => {
  const user = content => JSON.stringify({ type: 'user', message: { content } });
  for (const noise of ['Stop hook feedback: x', '  <tag>  ', ' Base directory for this skill: C:\\x ', ' [SYSTEM NOTIFICATION x] ', ' Caveat: x ']) {
    const raw = `${user(noise)}\n${user('次の依頼')}`;
    assert.equal(currentTitles(raw).firstPrompt, '次の依頼');
  }
});

test('自動のノイズタイトルより宣言目的を採用して閉じて可を付ける', () => {
  const raw = `${auto('008｜Base directory for this skill: C:\\x')}\n${assistant('**[本セッションの目的]** 道具名 route の昇格を止める')}`;
  assert.equal(desiredTitle(footer(CLOSED), raw, '008'), '008｜【閉じて可】道具名 route の昇格を止める');
});

test('手動 custom-title は宣言目的があっても保持する', () => {
  const raw = `${custom('私の名前')}\n${assistant('**[本セッションの目的]** 宣言された目的')}`;
  assert.equal(desiredTitle(footer(CLOSED), raw, '008'), '008｜【閉じて可】私の名前');
});

test('宣言目的は行内の最初のものを空白正規化して40文字まで採用する', () => {
  const purpose = `道具名   route\tの昇格を止める${'あ'.repeat(40)}`;
  for (const marker of ['[本セッションの目的]', '**[本セッションの目的]**']) {
    const raw = `${ai}\n${auto('008｜以前の自動名')}\n${assistant(`説明 ${marker} ${purpose}\n別の行`)}\n${assistant('[本セッションの目的] 後の目的')}`;
    assert.equal(desiredTitle('', raw, '008'), `008｜${purpose.replace(/\s+/g, ' ').slice(0, 40)}`);
  }
});

test('既存タイトルのPC番号と印を外してノイズなら次の候補へ落とす', () => {
  const prompt = JSON.stringify({ type: 'user', message: { content: '本当の依頼' } });
  const noiseAi = JSON.stringify({ type: 'ai-title', aiTitle: '008｜【閉じて可】Stop hook feedback: x' });
  for (const title of [auto, custom]) {
    assert.equal(desiredTitle('', `${ai}\n${title('008｜【閉じて可】Caveat: x')}`, '008'), '008｜【閉じて可】トークン待ち');
    assert.equal(desiredTitle('', `${title('008｜【閉じて可】<tag>')}\n${noiseAi}\n${prompt}`, '008'), '008｜【閉じて可】本当の依頼');
  }
  assert.equal(desiredTitle('', `${auto('008｜有効な自動名')}\n${noiseAi}`, '008'), null);
  assert.equal(desiredTitle('', noiseAi, '008'), '008｜セッション');
});

test('PC番号: フッターなしでも付与し、同じタイトルは追記しない', () => {
  assert.equal(desiredTitle('本文', ai, '018'), '018｜トークン待ち');
  assert.equal(desiredTitle('本文', custom('018｜トークン待ち'), '018'), null);
  assert.equal(desiredTitle('本文', custom('【11/02/20:11まで】名前'), '018'), '018｜【11/02/20:11まで】名前');
  assert.equal(desiredTitle('本文', custom('018｜【11/02/20:11まで】名前'), '018'), null);
});
test('PC番号: 期限付与・変更・解除でも番号が先頭', () => {
  assert.equal(desiredTitle(footer(WAIT), ai, '018'), '018｜【11/02/20:11まで】トークン待ち');
  assert.equal(desiredTitle(footer(WAIT), custom('018｜【11/01/09:00まで】名前'), '018'), '018｜【11/02/20:11まで】名前');
  assert.equal(desiredTitle(footer('閉じてよい'), custom('018｜【11/02/20:11まで】名前'), '018'), '018｜名前');
});
test('自動タイトルの後のAI名を採用し、人のrenameは保持する', () => {
  const newer = JSON.stringify({ type: 'ai-title', aiTitle: '請求書確認' });
  assert.equal(desiredTitle('', `${auto('018｜最初の発言')}\n${newer}`, '018'), '018｜請求書確認');
  assert.equal(desiredTitle('', `${custom('手で付けた名前')}\n${newer}`, '018'), '018｜手で付けた名前');
  assert.equal(desiredTitle('', `${newer}\n${auto('018｜最初の発言')}`, '018'), null);
  assert.equal(desiredTitle('', `${auto('018｜最初の発言')}\n${newer}\n${custom('手で付けた名前')}`, '018'), '018｜手で付けた名前');
});
test('PC番号なしはフッターなし・期限なしで従来どおり何もしない', () => {
  assert.equal(desiredTitle('', ai, ''), null);
  assert.equal(desiredTitle(footer('閉じてよい'), ai, ''), null);
});
test('sweepAll は注入したPC番号を全件に適用し、追記は冪等', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-pc-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const proj = path.join(base, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's.jsonl');
  fs.writeFileSync(file, ai);
  const options = { base, force: true, resolvePcNumber: () => '018' };
  assert.equal(sweepAllReal(options).titled[0].title, '018｜トークン待ち');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(raw.trim().split('\n').at(-1)).source, 'orgiast-auto');
  assert.equal(sweepAllReal(options).titled.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});
