import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CaptionAssembler,
  normalizeCaptionRows,
  CueTracker,
  STANDARD_CARDS,
  BOT_DISPLAY_NAME_DEFAULT,
  buildJevState,
  buildJevQuestions,
  parseJevResponse,
  buildDocHeaderRequests,
  buildDocCueRequests,
  parseSimulateTranscript,
  runDecisionRound,
  sanitizeCardData,
  formatJstDateTime,
  formatJstTime,
  formatJstSessionDate,
  resolveBotDisplayName,
} from './lib/meet-cue-core.mjs';

import {
  generateSessionId,
  saveLatestSessionId,
  getLatestSessionId,
  getLlmAskPath,
  main,
} from './meet-cue.mjs';

import {
  isProfileSignedIn,
  copyMeetBotProfile,
  startMeetBot,
  checkPlaywrightAvailable,
  detectMeetJoinState,
  dismissMeetPopups,
  enableMeetCaptions,
  watchMeetCaptions,
  findMeetJoinButton,
  joinMeetPage,
} from './lib/meet-cue-browser.mjs';

test('getLlmAskPath: Windows 形式の file URL から llm-ask.mjs の正しい絶対パスを解決できること', () => {
  const winFileUrl = 'file:///C:/x/tools/meet-cue.mjs';
  const resolved = getLlmAskPath(winFileUrl);

  if (process.platform === 'win32') {
    assert.equal(resolved, 'C:\\x\\tools\\llm-ask.mjs');
  } else {
    assert.equal(resolved, '/C:/x/tools/llm-ask.mjs');
  }

  const defaultResolved = getLlmAskPath();
  assert.ok(defaultResolved.endsWith('llm-ask.mjs'));
  assert.doesNotMatch(defaultResolved, /^file:\/\//);
  assert.doesNotMatch(defaultResolved, /\\C:\\C:\\|\/C:\/C:/);
});

test('STANDARD_CARDS: データの捏造数字なし・Reブース再利用カード・言い切り60字以内', () => {
  assert.equal(STANDARD_CARDS.length, 7, '定番カードは7枚');

  const reuseCard = STANDARD_CARDS.find(c => c.id === 'reuse');
  assert.ok(reuseCard, 'reuse カードが存在すること');
  assert.equal(reuseCard.title, '再利用の提案');
  assert.match(reuseCard.say, /Reブース/);

  for (const card of STANDARD_CARDS) {
    assert.equal(card.data, '', `カード ${card.id} の data は空文字であること`);
    assert.ok(card.say.length <= 60, `カード ${card.id} の say は60字以内であること (${card.say.length}字)`);
    assert.doesNotMatch(card.say, /\d+/, `カード ${card.id} の say に数字を含めないこと`);
  }
});

test('sanitizeCardData: brief に存在しない数字を消去・brief にある数字は保持', () => {
  // Case 1: Fake percentage in card data, empty brief -> data cleared
  const fakeCard = { id: 'c1', say: 'テスト', data: '満足度98%' };
  const sanitized1 = sanitizeCardData(fakeCard, '');
  assert.equal(sanitized1.data, '', 'brief にない数字は消去されること');

  // Case 2: Number present in brief -> data kept
  const validCard = { id: 'c2', say: 'テスト', data: '予算500万円以内のプラン' };
  const sanitized2 = sanitizeCardData(validCard, 'ご予算は500万円希望です。');
  assert.equal(sanitized2.data, '予算500万円以内のプラン', 'brief に存在する数字は保持されること');

  // Case 3: No numbers in card data -> data kept as is
  const noNumCard = { id: 'c3', say: 'テスト', data: '比較表付きの資料' };
  const sanitized3 = sanitizeCardData(noNumCard, '予算相談');
  assert.equal(sanitized3.data, '比較表付きの資料', '数字がない data は保持されること');
});

test('buildDocCueRequests: data が空なら根拠行を出さないこと', () => {
  const cueReqs = buildDocCueRequests({
    timestampStr: '10:05:00',
    say: 'ご予算に合わせて配分を変えたプランもお出しできます。',
    data: '',
    url: '',
    isKim: false,
    insertIndex: 1,
  });

  const text = cueReqs.requests[0].insertText.text;
  assert.doesNotMatch(text, /根拠:/, 'data が空の場合に根拠行が出ないこと');
  assert.doesNotMatch(text, /資料:/, 'url が空の場合に資料行が出ないこと');
});

test('JST 日時・セッション ID フォーマット検証', () => {
  // Fixed UTC Date: 2026-11-12 02:25:30 UTC -> JST 2026-11-12 11:25:30
  const utcDate = new Date('2026-11-12T02:25:30.000Z');

  assert.equal(formatJstDateTime(utcDate), '2026-11-12 11:25');
  assert.equal(formatJstTime(utcDate), '11:25:30');
  assert.equal(formatJstSessionDate(utcDate), '20261112-112530');
});

test('CaptionAssembler: 1文字ずつ伸びても句点で終わった文だけを2.5秒後に確定する', () => {
  const assembler = new CaptionAssembler();
  const sentence = '展示会のブースについて、ご予算はどのくらいをお考えでしょうか。';
  const input = sentence + '過';
  for (let i = 1; i <= input.length; i++) {
    assert.deepEqual(assembler.pushMutation({ rowId: 'a', speaker: 'あなた', text: input.slice(0, i), timestamp: i * 100 }), []);
  }

  const deadline = sentence.length * 100 + 2500;
  assert.deepEqual(assembler.tick(deadline - 1), []);
  assert.deepEqual(assembler.tick(deadline).map(line => line.text), [sentence]);
  assert.deepEqual(assembler.tick(deadline + 100), []);
});

test('CaptionAssembler: 認識結果が書き換わると安定時間を数え直す', () => {
  const assembler = new CaptionAssembler();
  const push = (text, timestamp) => assembler.pushMutation({ rowId: 'a', text, timestamp });
  push('展示会のコースについて伺います。', 0);
  push('展示会のブースについて伺います。', 2000);
  assert.deepEqual(assembler.tick(2500), []);
  assert.deepEqual(assembler.tick(4499), []);
  assert.deepEqual(assembler.tick(4500).map(line => line.text), ['展示会のブースについて伺います。']);
  assert.deepEqual(assembler.tick(7000), []);
});

test('CaptionAssembler: 先頭が途中まで消えても文やその断片を二重に確定しない', () => {
  const assembler = new CaptionAssembler();
  const push = (text, timestamp, rowId = 'a') => assembler.pushMutation({ rowId, text, timestamp });
  push('ご予算を伺います。過去の事例もご紹介できます。', 0);
  assert.equal(assembler.tick(2500).length, 2);
  push('伺います。過去の事例もご紹介できます。いかがでしょうか？', 3000);
  push('過去の事例もご紹介できます。いかがでしょうか？', 4000);
  assert.deepEqual(assembler.tick(5500).map(line => line.text), ['いかがでしょうか？']);
  push('過去の事例もご紹介できます。いかがでしょうか?', 6000, 'b');
  assert.deepEqual(assembler.tick(8500), []);
});

test('CaptionAssembler: 句点のない末尾は4秒の無変化を待ち、句点を補わない', () => {
  const assembler = new CaptionAssembler();
  const push = (text, timestamp, rowId = 'a') => assembler.pushMutation({ rowId, text, timestamp });
  push('ご予算は', 0);
  push('はい？', 1000, 'b');
  assert.deepEqual(assembler.tick(3500).map(line => line.text), ['はい？']);
  assert.deepEqual(assembler.tick(4999), []);
  assert.deepEqual(assembler.tick(5000).map(line => line.text), ['ご予算は']);
  push('ご予算は。', 5100);
  assert.deepEqual(assembler.tick(7600), []);
  push('次の展示会は', 8000);
  assert.deepEqual(assembler.flush(11999), []);
});

test('buildJevState & buildJevQuestions: 120秒窓、簡略化されたカード一覧、質問生成', () => {
  const cards = [
    { id: 'c1', title: '予算', trigger: '予算超過' },
    { id: 'c2', title: '納期', trigger: '短納期' },
  ];

  const state = buildJevState({
    captionsText: '[14:00:00] 田中: 費用が高くて困っています。',
    cards,
    lastCue: { title: '予算' },
    lastCueAgeSec: 60,
    brief: '予算を気にするお客様への対応',
  });

  assert.match(state, /【打合せ概要】/);
  assert.match(state, /予算を気にするお客様/);
  assert.match(state, /直前に出したカンペ: 予算 \(60秒前\)/);
  assert.match(state, /- c1: \[予算\]/);

  const questions = buildJevQuestions(cards);
  assert.equal(questions.phase.type, 'choice');
  assert.equal(questions.action.type, 'choice');
  assert.ok(questions.action.criteria.c1);
  assert.ok(questions.action.criteria.c2);
  assert.ok(questions.action.criteria.none);
  assert.ok(questions.action.criteria.generate);
});

test('parseJevResponse: confidence < 0.7 や未知 ID、エラー応答の処理', () => {
  const cards = [{ id: 'card-budget', title: '予算' }];

  // Normal valid response
  const valid = parseJevResponse({
    ok: true,
    answers: {
      phase: { choice: 'hearing' },
      action: { choice: 'card-budget', confidence: 0.95 },
    },
  }, cards);
  assert.equal(valid.phase, 'hearing');
  assert.equal(valid.action, 'card-budget');

  // Low confidence (< 0.7) -> none
  const lowConf = parseJevResponse({
    ok: true,
    answers: {
      phase: 'price',
      action: { choice: 'card-budget', confidence: 0.5 },
    },
  }, cards);
  assert.equal(lowConf.action, 'none');

  // Unknown card ID -> none
  const unknownId = parseJevResponse({
    ok: true,
    answers: {
      phase: 'price',
      action: 'card-unknown-99',
    },
  }, cards);
  assert.equal(unknownId.action, 'none');

  // Jev error response -> none
  const errRes = parseJevResponse({ ok: false, reason: 'timeout' }, cards);
  assert.equal(errRes.action, 'none');
});

test('CueTracker: 40秒クールダウンと5分間の同一カード再掲禁止', () => {
  const tracker = new CueTracker({ globalCooldownMs: 40000, cardRepeatCooldownMs: 300000 });
  const start = 1000000;

  // First cue allowed
  assert.equal(tracker.canPresentCue('card-budget', start), true);
  tracker.recordCuePresented('card-budget', { title: '予算の懸念' }, start);

  // Global cooldown active (20s later)
  assert.equal(tracker.canPresentCue('card-schedule', start + 20000), false);

  // Global cooldown passed (50s later), but same card blocked by 5m repeat rule
  assert.equal(tracker.canPresentCue('card-budget', start + 50000), false);

  // Global cooldown passed (50s later), different card allowed
  assert.equal(tracker.canPresentCue('card-schedule', start + 50000), true);

  // After 5 minutes (310s later), same card allowed again
  assert.equal(tracker.canPresentCue('card-budget', start + 310000), true);
});

test('buildDocHeaderRequests & buildDocCueRequests: Google Docs batchUpdate 構成検証', () => {
  const headerReqs = buildDocHeaderRequests({ title: '要件確認', staff: 'kim@orgiast.jp', dateStr: '2026-11-12 10:00' });
  assert.ok(headerReqs.requests.length >= 2);
  assert.equal(headerReqs.requests[0].insertText.location.index, 1);
  assert.match(headerReqs.requests[0].insertText.text, /【Meetカンペ】要件確認/);

  // Normal cue
  const cueReqs = buildDocCueRequests({
    timestampStr: '10:05:00',
    say: '予算について柔軟な提案が可能です。',
    data: '満足度98%',
    url: 'https://example.com/doc',
    isKim: false,
    insertIndex: 1,
  });

  assert.ok(cueReqs.requests.length >= 2);
  assert.match(cueReqs.requests[0].insertText.text, /【言うこと】予算について/);
  assert.match(cueReqs.requests[0].insertText.text, /根拠: 満足度98%/);
  assert.match(cueReqs.requests[0].insertText.text, /資料: https:\/\/example.com\/doc/);

  // Kim cue (red text)
  const kimReqs = buildDocCueRequests({
    timestampStr: '10:06:00',
    say: 'クロージングを強めに行ってください',
    isKim: true,
    insertIndex: 1,
  });

  assert.match(kimReqs.requests[0].insertText.text, /【kimより】クロージング/);
  const colorStyle = kimReqs.requests[1].updateTextStyle.textStyle.foregroundColor;
  assert.ok(colorStyle && colorStyle.color.rgbColor.red > 0.5);
});

test('parseSimulateTranscript: シミュレーション字幕テキストのパース', () => {
  const text = `
[14:00:00] 田中: こんにちは。
[14:00:05] お客様：費用感が合わないのですが、安くなりますか？
無記名の発言
  `;

  const lines = parseSimulateTranscript(text);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].speaker, '田中');
  assert.equal(lines[0].text, 'こんにちは。');
  assert.equal(lines[1].speaker, 'お客様');
  assert.equal(lines[1].text, '費用感が合わないのですが、安くなりますか？');
  assert.equal(lines[2].speaker, '参加者');
  assert.equal(lines[2].text, '無記名の発言');
});

test('セッション ID 生成と latest 読み書き', t => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-id-test-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const id = generateSessionId();
  assert.match(id, /^\d{8}-\d{6}-[a-f0-9]{4}$/);

  saveLatestSessionId(id, tmpHome);
  assert.equal(getLatestSessionId(tmpHome), id);
});

test('CLI start の必須引数チェック（未指定時 exit 2）', async () => {
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('exit'); };

  try {
    await main(['start']);
  } catch (e) {
    assert.equal(e.message, 'exit');
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exitCode, 2);
});

test('runDecisionRound: スタブで予算懸念 -> budget カードが Doc 差し込み関数に渡り、40秒以内の2回目は出ないこと', async () => {
  const assembler = new CaptionAssembler();
  assembler.pushMutation({ speaker: 'お客様', text: '予算が厳しくて費用が高すぎます', timestamp: 1000 });
  assembler.tick(5000);

  const tracker = new CueTracker({ globalCooldownMs: 40000 });
  const cards = [...STANDARD_CARDS];

  const mockAskJev = async () => ({
    ok: true,
    answers: {
      phase: 'price',
      action: { choice: 'card-budget', confidence: 0.95 },
    },
  });

  const insertedCues = [];
  const mockInsertCue = async (cue) => {
    insertedCues.push(cue);
  };

  // 1st round at now = 10000
  const res1 = await runDecisionRound({
    assembler,
    tracker,
    cards,
    brief: '予算相談',
    now: 10000,
    askJev: mockAskJev,
    insertCue: mockInsertCue,
  });

  assert.equal(res1.presented, true);
  assert.equal(insertedCues.length, 1);
  assert.equal(insertedCues[0].id, 'card-budget');

  // 2nd round at now = 20000 (10 seconds later, within 40s global cooldown)
  const res2 = await runDecisionRound({
    assembler,
    tracker,
    cards,
    brief: '予算相談',
    now: 20000,
    askJev: mockAskJev,
    insertCue: mockInsertCue,
  });

  assert.equal(res2.presented, false);
  assert.equal(insertedCues.length, 1, '40秒以内の2回目は差し込まれない');
});

test('resolveBotDisplayName: 既定値・安全弁・正常値の解決', () => {
  // Default (no config)
  assert.equal(resolveBotDisplayName({}), BOT_DISPLAY_NAME_DEFAULT);
  assert.equal(resolveBotDisplayName({ botDisplayName: '' }), BOT_DISPLAY_NAME_DEFAULT);
  assert.equal(resolveBotDisplayName({ botDisplayName: '   ' }), BOT_DISPLAY_NAME_DEFAULT);

  // Safety valve: internal terms fall back to default
  assert.equal(resolveBotDisplayName({ botDisplayName: 'オージャスト カンペAI' }), BOT_DISPLAY_NAME_DEFAULT);
  assert.equal(resolveBotDisplayName({ botDisplayName: 'cue bot' }), BOT_DISPLAY_NAME_DEFAULT);
  assert.equal(resolveBotDisplayName({ botDisplayName: '指示出し君' }), BOT_DISPLAY_NAME_DEFAULT);
  assert.equal(resolveBotDisplayName({ botDisplayName: '台本くん' }), BOT_DISPLAY_NAME_DEFAULT);

  // Normal name passes through
  assert.equal(resolveBotDisplayName({ botDisplayName: 'オージャスト議事録' }), 'オージャスト議事録');
  assert.equal(resolveBotDisplayName({ botDisplayName: 'オージャストAI' }), 'オージャストAI');
  assert.equal(resolveBotDisplayName({ botDisplayName: 'Meeting Bot' }), 'Meeting Bot');
});

test('再発防止ゲート: meet-cue-browser.mjs のソースに「カンペ」が含まれないこと', () => {
  const browserPath = new URL('./lib/meet-cue-browser.mjs', import.meta.url);
  const source = fs.readFileSync(browserPath, 'utf8');
  // The word "カンペ" may appear in comments or log messages about the old name,
  // but must NOT appear in any string literal that would be displayed as a guest name.
  // Check that no string literal contains "カンペ" as a display name value.
  // We specifically check that the hardcoded 'オージャスト カンペAI' is gone.
  assert.doesNotMatch(source, /オージャスト\s*カンペAI/,
    'ソースに「オージャスト カンペAI」というハードコード文字列が残っていてはいけません');
});

test('isProfileSignedIn: Google ログイン状態の cookie ファイル存在確認', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-signin-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  assert.equal((await isProfileSignedIn(tmpDir)).signedIn, false);

  const defaultDir = path.join(tmpDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(defaultDir, 'Cookies'), 'dummy sqlite cookie content with SID inside', 'utf8');

  assert.equal((await isProfileSignedIn(tmpDir)).signedIn, false);

  fs.writeFileSync(path.join(defaultDir, 'Cookies'), 'dummy sqlite cookie content with SID and HSID', 'utf8');
  assert.equal((await isProfileSignedIn(tmpDir)).signedIn, true);
});

test('copyMeetBotProfile: ログイン用ファイルを複製し、各階層のロックを除外する', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-cue-profile-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source');
  const files = ['Local State', 'Default/Cookies', 'Default/Network/Cookies'];
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'Default/Network/lockfile'];
  for (const file of [...files, ...locks]) {
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file);
  }

  const first = path.join(tmp, 'first', 'profile');
  const second = path.join(tmp, 'second', 'profile');
  copyMeetBotProfile(source, first);
  copyMeetBotProfile(source, second);
  for (const file of files) {
    assert.equal(fs.readFileSync(path.join(first, file), 'utf8'), file);
    assert.equal(fs.readFileSync(path.join(second, file), 'utf8'), file);
  }
  for (const lock of locks) {
    assert.equal(fs.existsSync(path.join(first, lock)), false);
    assert.equal(fs.readFileSync(path.join(source, lock), 'utf8'), lock);
  }
  fs.writeFileSync(path.join(first, 'Default', 'Network', 'Cookies'), 'updated');
  assert.equal(fs.readFileSync(path.join(second, 'Default', 'Network', 'Cookies'), 'utf8'), 'Default/Network/Cookies');
  assert.equal(fs.readFileSync(path.join(source, 'Default', 'Network', 'Cookies'), 'utf8'), 'Default/Network/Cookies');
});

const meetCode = 'jdo-fpvd-xau';
const meetingUrl = `https://meet.google.com/${meetCode}`;
const meetHome = 'https://meet.google.com/';

function stubMeetDom({ url = meetingUrl, buttons = [], texts = [], inCall = false } = {}) {
  return {
    url: () => url,
    viewportSize: () => ({ width: 1280, height: 720 }),
    locator: () => ({ first: () => ({ isVisible: async () => inCall }) }),
    getByText: (pattern) => ({
      all: async () => texts.filter(({ text }) => pattern.test(text)).map(item => ({
        isVisible: async () => !item.hidden,
        evaluate: async fn => fn({ closest: () => item.button ? {} : null }),
      })),
    }),
    getByRole: () => ({
      filter: ({ hasText }) => ({
        all: async () => buttons.filter(({ text }) => hasText.test(text)).map(item => ({
          innerText: async () => item.visibleText ?? item.text,
          isVisible: async () => !item.hidden,
          isEnabled: async () => !item.disabled,
          boundingBox: async () => ({ x: item.x ?? 620, y: 345, width: 40, height: 30 }),
          click: async () => item.click?.(),
        })),
      }),
    }),
  };
}

test('参加ボタンは表示テキストの完全一致を指定順で探す', async () => {
  const labels = ['今すぐ参加', 'Join now', '参加をリクエスト', 'Ask to join', '参加'];
  const decoys = [
    { text: '今すぐ参加する方法' },
    { text: '今すぐ参加', hidden: true },
    { text: '今すぐ参加', visibleText: '' },
    { text: '今すぐ参加', disabled: true },
    { text: '参加', x: 100 },
  ];
  for (const [index, label] of labels.entries()) {
    const buttons = [...decoys, ...labels.slice(index).reverse().map(text => ({ text }))];
    const page = stubMeetDom({ buttons });
    assert.equal((await findMeetJoinButton(page, meetCode)).label, label);
  }
  assert.equal(await findMeetJoinButton(stubMeetDom({ buttons: decoys }), meetCode), null);
  assert.equal(await findMeetJoinButton(stubMeetDom({
    url: meetHome, buttons: [{ text: '参加' }],
  }), meetCode), null);
});

test('会議コードと表示中の UI から参加状態を判定する', async () => {
  for (const [expected, dom] of [
    ['home', { url: meetHome, inCall: true }],
    ['home', { url: meetingUrl.replace(meetCode, 'abc-defg-hij') }],
    ['prejoin', { texts: [{ text: 'Ask to join', button: true }, { text: 'Asking to join', hidden: true }] }],
    ['in_lobby', { texts: [{ text: '参加をリクエストしています' }] }],
    ['in_lobby', { texts: [{ text: 'Asking to join…' }] }],
    ['in_call', { inCall: true, texts: [{ text: 'Asking to join…' }] }],
  ]) {
    assert.equal(await detectMeetJoinState(stubMeetDom(dom), meetCode), expected);
  }
});

test('/new のリダイレクト先を保持し、ホームへ戻ったときだけ一度開き直す', async () => {
  for (const succeeds of [true, false]) {
    const newUrl = `${meetHome}new`;
    const navigations = [];
    const states = [];
    let activeUrl;
    let inCall = false;
    const getDom = () => stubMeetDom({
      url: activeUrl,
      inCall,
      buttons: [{ text: '今すぐ参加', click: () => {
        if (succeeds && navigations.length === 2) inCall = true;
        else activeUrl = meetHome;
      } }],
    });
    const page = {
      goto: async url => {
        navigations.push(url);
        activeUrl = url;
      },
      waitForTimeout: async () => { activeUrl = meetingUrl; },
      url: () => activeUrl,
      locator: (...args) => getDom().locator(...args),
      getByText: (...args) => getDom().getByText(...args),
      getByRole: (...args) => getDom().getByRole(...args),
    };
    assert.equal(await joinMeetPage(page, {
      url: newUrl,
      preparePrejoin: async () => {},
      onJoinState: state => states.push(state),
      log: () => {},
      uiTimeoutMs: 1000,
    }), succeeds ? null : 'left_meeting_page');
    assert.deepEqual(navigations, [newUrl, meetingUrl]);
    assert.deepEqual(states, ['home', 'prejoin', 'home', 'prejoin', succeeds ? 'in_call' : 'home']);
  }
});

test('字幕ボタンのラベルまたは aria-pressed でオンを確認し、最大3回試す', async () => {
  for (const action of ['already_enabled', 'already_pressed', 'click', 'pressed', 'c', 'retry', 'unconfirmed']) {
    let enabled = ['already_enabled', 'already_pressed'].includes(action);
    const actions = [];
    const locator = (matches) => ({
      matches,
      filter: () => locator(() => false),
      or: other => locator(() => matches() || other.matches()),
      and: other => locator(() => matches() && other.matches()),
      first() { return this; },
      isVisible: async () => matches(),
      click: async () => { actions.push('click'); enabled = true; },
      waitFor: async () => {
        if (!matches()) throw new Error('字幕オンを確認できません');
      },
    });
    const page = {
      locator: selector => locator(() => {
        if (selector === ':visible') return true;
        if (selector.includes('[aria-pressed="true"]:visible') && action === 'already_pressed') {
          return selector.includes('字幕と翻訳');
        }
        if (selector.includes('Turn off captions')) return enabled && !['pressed', 'already_pressed'].includes(action);
        if (selector === '[aria-pressed="true"]') return enabled && action === 'pressed';
        return selector.includes('Turn on captions') && ['click', 'pressed'].includes(action);
      }),
      evaluate: async () => { actions.push('focus'); },
      keyboard: {
        press: async key => {
          actions.push(key);
          enabled = action === 'c' || (action === 'retry' && actions.length === 4);
        },
      },
    };
    assert.equal(await enableMeetCaptions(page), action !== 'unconfirmed');
    const expected = {
      already_enabled: [], already_pressed: [], click: ['click'], pressed: ['click'], c: ['focus', 'c'],
      retry: ['focus', 'c', 'focus', 'c'], unconfirmed: ['focus', 'c', 'focus', 'c', 'focus', 'c'],
    };
    assert.deepEqual(actions, expected[action]);
  }
});

test('実測した字幕の話者と本文を保持し、アイコン名と空行を除外する', () => {
  const html = fs.readFileSync(new URL('./test-fixtures/meet-cue-captions-ja.html', import.meta.url), 'utf8');
  const speaker = html.match(/<span class="NWpY1d">([^<]+)<\/span>/)[1];
  const text = html.match(/<div class="ygicle [^"]+">([^<]+)<\/div>/)[1];
  const icon = html.match(/<i [^>]*>(translate_cc)<\/i>/)[1];
  assert.deepEqual(normalizeCaptionRows([
    { speaker, text: ` ${text} `, rowId: '1:0' },
    { speaker, text: '承知しました', rowId: '2:0', fromFallback: true },
    { speaker, text: 'hello', rowId: '3:0' },
    { speaker, text: 'noise', fromFallback: true },
    ...[icon, 'closed_caption', 'mic_off', 'icon_123', ' '].map(text => ({ speaker, text })),
  ]), [
    {
      speaker: 'あなた',
      text: '本日はお時間をいただきありがとうございます。展示会のブースについて、ご予算はどのくらいをお考えでしょうか。過去の事例もご紹介できます。',
      rowId: '1:0',
    },
    { speaker: 'あなた', text: '承知しました', rowId: '2:0' },
    { speaker: 'あなた', text: 'hello', rowId: '3:0' },
  ]);
});

test('字幕監視: 遅れて現れた領域をポーリングし、Observer と終了直前の読み取りでも通知する', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let regions = [];
  const document = { querySelectorAll: () => regions };
  let notify;
  const observed = new Set();
  class MutationObserver {
    constructor(callback) { notify = callback; }
    observe(region, options) {
      assert.equal(options.characterData, true);
      assert.equal(options.subtree, true);
      observed.add(region);
    }
    disconnect() { observed.clear(); }
  }
  const window = {};
  const page = {
    exposeFunction: async (name, callback) => { window[name] = async value => callback(value); },
    evaluate: async (expression, arg) => runInNewContext(
      typeof expression === 'string' ? expression : `(${expression})(arg)`,
      { window, document, MutationObserver, arg },
    ),
    isClosed: () => false,
  };
  const received = [];
  const errors = [];
  const stop = await watchMeetCaptions(page, { onCaption: caption => received.push(caption), log: msg => errors.push(msg) });
  const poll = async () => {
    t.mock.timers.tick(1500);
    await new Promise(resolve => setImmediate(resolve));
  };
  const insert = text => {
    const body = {
      textContent: text,
      closest: () => null,
      cloneNode() {
        return { textContent: this.textContent, querySelectorAll: () => [] };
      },
    };
    const row = {
      closest: () => null,
      querySelector: selector => selector === '.ygicle' ? body : { textContent: 'あなた' },
    };
    const region = { closest: () => null, querySelectorAll: () => [row] };
    regions = [region];
    return { region, body };
  };
  assert.equal(observed.size, 0);
  const first = insert('本日は');
  await poll();
  assert.ok(observed.has(first.region));
  first.body.textContent = '本日はお時間を';
  notify();
  await poll();
  const second = insert('展示会の');
  await poll();
  assert.deepEqual([...observed], [second.region]);
  second.body.textContent = '展示会のご予算を';
  await stop();

  assert.deepEqual(received.map(row => row.text), ['本日は', '本日はお時間を', '', '展示会の', '展示会のご予算を']);
  assert.equal(received[0].rowId, received[1].rowId);
  assert.notEqual(received[0].rowId, received[3].rowId);
  assert.equal(observed.size, 0);
  assert.deepEqual(errors, []);
});

test('対象ダイアログの閉じるボタンだけを押す', async () => {
  const dialogs = new Set(['会議の準備が整いました', 'Gemini をご利用いただけます', '字幕と翻訳']);
  const page = {
    getByRole(role, { name, exact }) {
      assert.equal(role, 'dialog');
      assert.equal(exact, true);
      return {
        getByRole(childRole, options) {
          assert.equal(childRole, 'button');
          assert.deepEqual(options, { name: '閉じる', exact: true });
          return {
            first() { return this; },
            isVisible: async () => dialogs.has(name),
            click: async () => { dialogs.delete(name); },
          };
        },
      };
    },
  };
  await dismissMeetPopups(page);
  assert.deepEqual([...dialogs], ['字幕と翻訳']);
});
