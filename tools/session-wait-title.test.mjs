import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply as applyReal, currentTitles, desiredTitle, isCloseRitualOnly, promptSubmit, sessionStart, sweepAll as sweepAllReal, waitPrefix } from './session-wait-title.mjs';

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

const salesAi = JSON.stringify({ type: 'ai-title', aiTitle: '東邦の売上' });
for (const [name, raw, pc, expected] of [
  ['プロンプトもタイトルも無ければ待機名', JSON.stringify({ type: 'user', message: { content: '売上を確認' } }), '008', '008｜待機中'],
  ['AIタイトルに番号を付ける', salesAi, '008', '008｜東邦の売上'],
  ['同じタイトルもサーバー同期へ渡す', auto('008｜x'), '008', '008｜x'],
  ['番号なしPCは出力しない', salesAi, '', null],
  ['人のrenameを保持する', custom('foo'), '008', '008｜foo'],
  ['人のrenameには期限も追加しない', `${custom('  foo  ')}\n${assistant(footer(WAIT))}`, '008', '008｜  foo  '],
  ['既存番号付きrenameを保持する', custom('018｜foo'), '008', '018｜foo'],
  ['期限footerを反映する', `${salesAi}\n${assistant(footer(WAIT))}`, '008', '008｜【11/02/20:11まで】東邦の売上'],
  ['自動タイトル後のAI名を反映する', `${auto('008｜古い名前')}\n${salesAi}`, '008', '008｜東邦の売上'],
]) {
  test(`promptSubmit: ${name}`, () => {
    const result = promptSubmit({ transcript_path: 's.jsonl', session_id: 's' }, {
      readFile: () => raw, statSize: () => Buffer.byteLength(raw), resolvePcNumber: () => pc,
    });
    assert.deepEqual(result, expected === null ? null : {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: expected },
    });
  });
}

test('promptSubmit: subagent・巨大ファイル・入力不足・例外はfail-open', () => {
  const input = { transcript_path: 's.jsonl', session_id: 's' };
  const options = { resolvePcNumber: () => '008', statSize: () => 1, readFile: () => { assert.fail('読み込まない'); } };
  assert.equal(promptSubmit({ ...input, transcript_path: 'p/subagents/a.jsonl' }, options), null);
  assert.equal(promptSubmit(input, { ...options, statSize: () => 256 * 1024 * 1024 + 1 }), null);
  assert.equal(promptSubmit({}, options), null);
  assert.equal(promptSubmit(input, { ...options, statSize: () => { throw new Error('stat'); } }), null);
  assert.equal(promptSubmit(input, { ...options, readFile: () => { throw new Error('read'); } }), null);
  assert.equal(promptSubmit(input, { ...options, resolvePcNumber: () => { throw new Error('pc'); } }), null);
});

test('--prompt-submit CLI: JSON 1行・読み取り専用・不正入力でもexit 0', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, salesAi);
  const before = fs.statSync(file);
  const run = input => spawnSync(process.execPath, [fileURLToPath(new URL('./session-wait-title.mjs', import.meta.url)), '--prompt-submit'], {
    input, encoding: 'utf8', env: { ...process.env, ORGIAST_PC_NUMBER: '008' },
  });
  const result = run(JSON.stringify({ transcript_path: file, session_id: 's' }));
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: '008｜東邦の売上' } }) + '\n');
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(file).size, before.size);
  assert.equal(fs.readFileSync(file, 'utf8'), salesAi);
  for (const input of ['{', JSON.stringify({ transcript_path: path.join(dir, 'missing'), session_id: 's' })]) {
    const failed = run(input);
    assert.ifError(failed.error);
    assert.equal(failed.status, 0);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr, '');
  }
});

const freshInput = { transcript_path: 's.jsonl', session_id: 's' };
const freshOptions = { resolvePcNumber: () => '999', statSize: () => 0, readFile: () => '' };
test('source なしの待機名はプロンプト冒頭に置き換える', () => {
  for (const title of ['999｜待機中', '待機中', '999｜【11/02/20:11まで】待機中', '999｜【26/11/02/20:11まで】 待機中 ', '999｜【閉じて可】待機中']) {
    const result = promptSubmit({ ...freshInput, prompt: '売上を確認する' }, {
      ...freshOptions, readFile: () => custom(title),
    });
    assert.equal(result.hookSpecificOutput.sessionTitle, '999｜売上を確認する');
  }
});

test('待機名より ai-title を promptSubmit・desiredTitle・apply で採用する', () => {
  for (const placeholder of [custom, auto]) {
    for (const raw of [`${placeholder('999｜待機中')}\n${salesAi}`, `${salesAi}\n${placeholder('999｜待機中')}`]) {
      const options = { ...freshOptions, readFile: () => raw };
      assert.equal(promptSubmit({ ...freshInput, prompt: '別の入力' }, options).hookSpecificOutput.sessionTitle, '999｜東邦の売上');
      assert.equal(desiredTitle('', raw, '999'), '999｜東邦の売上');
      let appended = '';
      assert.equal(applyReal(freshInput, { ...options, appendFile: (_file, text) => { appended += text; } }), '999｜東邦の売上');
      assert.equal(JSON.parse(appended.trim()).customTitle, '999｜東邦の売上');
    }
  }
});

test('source なしでも待機中以外の手動名は保持する', () => {
  for (const title of ['999｜手動の名前', '999｜待機中の調査']) {
    const raw = `${custom(title)}\n${salesAi}`;
    const options = { ...freshOptions, readFile: () => raw };
    assert.equal(promptSubmit({ ...freshInput, prompt: '別の入力' }, options).hookSpecificOutput.sessionTitle, title);
    assert.equal(desiredTitle('', raw, '999'), null);
    assert.equal(applyReal(freshInput, { ...options, appendFile: () => assert.fail('変更不要') }), null);
  }
});

test('SessionStart: 未入力なら待機名、既存タイトルなら保持する', () => {
  assert.deepEqual(sessionStart(freshInput, freshOptions), {
    hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: '999｜待機中' },
  });
  for (const raw of [ai, custom('手動名'), auto('999｜既存名')]) {
    assert.equal(sessionStart(freshInput, { ...freshOptions, readFile: () => raw }), null);
  }
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  for (const options of [{ statSize: missing }, { readFile: missing }]) {
    assert.equal(sessionStart(freshInput, { ...freshOptions, ...options }).hookSpecificOutput.sessionTitle, '999｜待機中');
  }
});

test('SessionStart: 対象外と読み取りエラーはfail-open', () => {
  for (const input of [{}, { transcript_path: 'p/subagents/s.jsonl' }]) {
    assert.equal(sessionStart(input, freshOptions), null);
  }
  for (const options of [
    { resolvePcNumber: () => '' },
    { resolvePcNumber: () => { throw new Error('pc'); } },
    { statSize: () => 256 * 1024 * 1024 + 1 },
    { statSize: () => { throw new Error('stat'); } },
    { readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
  ]) assert.equal(sessionStart(freshInput, { ...freshOptions, ...options }), null);
});

test('promptSubmit: AI名が無ければ今回の冒頭を空白正規化・全角30文字に制限する', () => {
  for (const [prompt, title] of [
    ['  売上\n\t を   確認  ', '売上 を 確認'],
    ['あ'.repeat(31), 'あ'.repeat(30)],
    ['a'.repeat(61), 'a'.repeat(60)],
    ['abc' + 'あ'.repeat(30), 'abc' + 'あ'.repeat(28)],
    ['😀'.repeat(31), '😀'.repeat(30)],
    [' \n\t ', '待機中'],
    [undefined, '待機中'],
  ]) {
    assert.deepEqual(promptSubmit({ ...freshInput, prompt }, freshOptions), {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: `999｜${title}` },
    });
  }
});

test('promptSubmit: closed-sessions.json に登録があれば【閉じて可】を付ける', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-ps-closed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'テスト', sessionId: 's' }));
  const result = promptSubmit({ transcript_path: file, session_id: 's' }, {
    readFile: () => fs.readFileSync(file, 'utf8'),
    statSize: () => fs.statSync(file).size,
    resolvePcNumber: () => '008',
    isClosed: id => id === 's',
  });
  assert.ok(result);
  assert.equal(result.hookSpecificOutput.sessionTitle, '008｜【閉じて可】テスト');
});

test('promptSubmit: closed-sessions.json に無ければ通常のフッター処理', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-ps-not-closed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'テスト', sessionId: 's' }));
  const result = promptSubmit({ transcript_path: file, session_id: 's' }, {
    readFile: () => fs.readFileSync(file, 'utf8'),
    statSize: () => fs.statSync(file).size,
    resolvePcNumber: () => '008',
    isClosed: id => false,
  });
  assert.ok(result);
  assert.equal(result.hookSpecificOutput.sessionTitle, '008｜テスト');
});

test('CLI: hook_event_name で SessionStart と UserPromptSubmit を振り分ける', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  for (const [event, title] of [['SessionStart', '待機中'], ['UserPromptSubmit', '売上確認']]) {
    if (event === 'UserPromptSubmit') fs.writeFileSync(file, '');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./session-wait-title.mjs', import.meta.url))], {
      input: JSON.stringify({ hook_event_name: event, transcript_path: file, session_id: 's', prompt: '売上確認' }),
      encoding: 'utf8', env: { ...process.env, ORGIAST_PC_NUMBER: '999' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: event, sessionTitle: `999｜${title}` } });
  }
});

// --- 全角コロン対応のテスト ---
const FULLWIDTH_FOOTER = `本文

次に kim がすること：なし
この後の自動進行：毎時の見張りが保存を確かめて報告する
このセッション：まだ閉じない（作業中・2026-11-09 12:00 まで待つ）`;

test('全角コロンのフッターでも期限タイトルが付く（PC番号なし）', () => {
  assert.equal(desiredTitle(FULLWIDTH_FOOTER, ai, ''), '【11/09/12:00まで】トークン待ち');
});

test('全角コロンのフッター＋PC番号あり', () => {
  assert.equal(desiredTitle(FULLWIDTH_FOOTER, ai, '018'), '018｜【11/09/12:00まで】トークン待ち');
});

test('全角コロンのフッター（【最終まとめ】はフッターの前）で期限が付く', () => {
  // Actual format from transcript 7bbe3beb: 【最終まとめ】 section is BEFORE the footer
  const text = `【最終まとめ】
① 報告（10:05 時点）
| 項目 | 状態 |
|---|---|
| 夜間再起動 | ✅ 実装済み |
| Windows テスト | ✅ 全部通過 |

次に kim がすること：なし（任意で「wt-rc-keep 削除OK」）
この後の自動進行：修正とレビューの完了通知で自動再開 → 結果を確認 → Windows テスト → 着地 → ここに報告。着地の確認は自動チェックに登録済み（期限 11/09 22:03）
このセッション：まだ閉じない（作業中・2026-11-09 12:00 まで待つ）`;
  assert.equal(desiredTitle(text, ai, '018'), '018｜【11/09/12:00まで】トークン待ち');
});

test('全角コロンの閉じてよいフッターで【閉じて可】が付く', () => {
  const text = `次に kim がすること：なし
この後の自動進行：なし（完了）
このセッション：/session-close は終わっているので、このセッションを閉じてよい`;
  assert.equal(desiredTitle(text, ai, '018'), '018｜【閉じて可】トークン待ち');
});

test('全角コロンの閉じてよいフッター（PC番号なし）で【閉じて可】が付く', () => {
  const text = `次に kim がすること：なし
この後の自動進行：なし（完了）
このセッション：/session-close は終わっているので、このセッションを閉じてよい`;
  assert.equal(desiredTitle(text, ai, ''), '【閉じて可】トークン待ち');
});

test('半角コロンは従来どおり動作する', () => {
  assert.equal(desiredTitle(footer(WAIT), ai, ''), '【11/02/20:11まで】トークン待ち');
});

// --- closed-sessions.json のテスト ---
test('closed-sessions.json に登録があればフッター無しでも【閉じて可】を付ける', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-closed2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${ai}\n`);
  const result = applyReal({ transcript_path: file, session_id: 's' }, {
    readFile: () => fs.readFileSync(file, 'utf8'),
    statSize: () => fs.statSync(file).size,
    resolvePcNumber: () => '008',
    isClosed: id => id === 's',
  });
  assert.equal(result, '008｜【閉じて可】トークン待ち');
  const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1));
  assert.equal(last.customTitle, '008｜【閉じて可】トークン待ち');
});

test('closed-sessions.json に登録が無ければ通常のフッター処理（フッター無しなら何もしない）', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-not-closed2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${ai}\n`);
  const result = apply({ transcript_path: file, session_id: 's' }, {
    readFile: () => fs.readFileSync(file, 'utf8'),
    statSize: () => fs.statSync(file).size,
    resolvePcNumber: () => '008',
    isClosed: id => false,
  });
  assert.equal(result, null);
});

// --- sweepAll のクールダウンテスト ---
test('sweepAll: state ファイルがあっても1時間後に再実行される', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-cooldown-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stateFile = path.join(base, 'session-wait-title-state.json');
  // Write a state file that is 61 minutes old (past the 1-hour cooldown)
  fs.writeFileSync(stateFile, JSON.stringify({ at: Date.now() - 61 * 60 * 1000 }));
  const proj = path.join(base, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), `${ai}\n${assistant(footer(WAIT))}\n`);
  const result = sweepAllReal({ base, now: Date.now(), resolvePcNumber: () => '008' });
  assert.notEqual(result.skipped, 'cooldown');
  assert.equal(result.scanned, 1);
  assert.equal(result.titled[0].title, '008｜【11/02/20:11まで】トークン待ち');
});

test('sweepAll: state ファイルが1時間以内なら cooldown で飛ばす', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-cooldown2-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stateFile = path.join(base, 'session-wait-title-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ at: Date.now() - 30 * 60 * 1000 })); // 30 min ago
  const result = sweepAll({ base, now: Date.now(), resolvePcNumber: () => '008' });
  assert.equal(result.skipped, 'cooldown');
});

// --- エラーログのテスト ---
test('エラー時も fail-open で exit 0（ログファイルに記録）', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, 'invalid json');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./session-wait-title.mjs', import.meta.url))], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: file, session_id: 's' }),
    encoding: 'utf8', env: { ...process.env, ORGIAST_PC_NUMBER: '999' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  // Should not crash; log file may or may not exist depending on write permissions
});

const REOPEN_WAIT = 'まだ閉じない（作業中・2026-11-10 18:00 まで待つ）';
test('closed=true でも最新フッターの待機期限を優先する', () => {
  assert.equal(desiredTitle(footer(REOPEN_WAIT), custom('019｜【閉じて可】案件'), '019', true), '019｜【11/10/18:00まで】案件');
});
test('closed=true でフッター無しなら閉じて可', () => {
  assert.equal(desiredTitle('本文', ai, '', true), '【閉じて可】トークン待ち');
});
test('closed=true で閉じてよい定型文なら閉じて可', () => {
  assert.equal(desiredTitle(footer('/session-close は終わっているので、このセッションを閉じてよい'), ai, '', true), '【閉じて可】トークン待ち');
});
test('closed=true で期限なしの非定型フッターでも閉じて可を維持する', () => {
  assert.equal(desiredTitle(footer('作業を終えました'), custom('【閉じて可】案件'), '019', true), '019｜【閉じて可】案件');
});
test('closed=true で期限なしなら人の作業が残るフッターでも閉じて可を優先する', () => {
  assert.equal(desiredTitle(withAction('返信する', CLOSED), custom('【閉じて可】案件'), '019', true), '019｜【閉じて可】案件');
});
test('apply: 再開時に sessionId を一度除外しログを一行記録する（題名変更不要でも除外）', () => {
  for (const raw of [ai, custom('【11/10/18:00まで】トークン待ち')]) {
    const reopened = [], logs = [];
    applyReal({ transcript_path: 's.jsonl', session_id: 'reopened', last_assistant_message: footer(REOPEN_WAIT) }, {
      readFile: () => raw, statSize: () => 1, resolvePcNumber: () => '', isClosed: () => true,
      appendFile: () => {}, reopen: id => reopened.push(id), log: message => logs.push(message),
    });
    assert.deepEqual(reopened, ['reopened']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /reopened.*closed-sessions.json/);
  }
});
test('apply: reopen 失敗でも待機タイトルを反映する', () => {
  const result = applyReal({ transcript_path: 's.jsonl', session_id: 'reopened', last_assistant_message: footer(REOPEN_WAIT) }, {
    readFile: () => ai, statSize: () => 1, resolvePcNumber: () => '', isClosed: () => true,
    appendFile: () => {}, reopen: () => { throw new Error('denied'); }, log: () => assert.fail('除外失敗を成功扱いにしない'),
  });
  assert.equal(result, '【11/10/18:00まで】トークン待ち');
});
test('apply: 未閉鎖・フッター無し・閉じてよい宣言では reopen しない', () => {
  for (const [closed, text] of [[false, footer(REOPEN_WAIT)], [true, '本文'], [true, footer(CLOSED)]]) {
    applyReal({ transcript_path: 's.jsonl', session_id: 's', last_assistant_message: text }, {
      readFile: () => ai, statSize: () => 1, resolvePcNumber: () => '', isClosed: () => closed,
      appendFile: () => {}, reopen: () => assert.fail('再開対象外'),
    });
  }
});

test('CLI: 再開時は対象IDだけ台帳から外し transcript と他の台帳項目を保持する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-reopen-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  fs.mkdirSync(base, { recursive: true });
  const ledger = path.join(base, 'closed-sessions.json');
  fs.writeFileSync(ledger, JSON.stringify({ ids: ['s', 'other'], note: 'preserve' }));
  const file = path.join(home, 's.jsonl');
  fs.writeFileSync(file, `${ai}\n`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./session-wait-title.mjs', import.meta.url))], {
    input: JSON.stringify({ transcript_path: file, session_id: 's', last_assistant_message: footer(REOPEN_WAIT) }),
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, ORGIAST_PC_NUMBER: '019' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')), { ids: ['other'], note: 'preserve' });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).customTitle, '019｜【11/10/18:00まで】トークン待ち');
  const logs = fs.readFileSync(path.join(base, 'logs', 'session-wait-title.log'), 'utf8').trim().split('\n');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reopened s:/);
});
