import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CaptionAssembler,
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
  startMeetBot,
  checkPlaywrightAvailable,
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

test('CaptionAssembler: 字幕の重複除去、1.5秒確定、話者切替', t => {
  const assembler = new CaptionAssembler({ finalizeDelayMs: 1500 });
  const start = 1000000;

  // 1. Single speaker growing text
  assembler.pushMutation({ speaker: '田中', text: 'こんにちは', timestamp: start });
  assembler.pushMutation({ speaker: '田中', text: 'こんにちは、オージャストの', timestamp: start + 500 });
  assembler.pushMutation({ speaker: '田中', text: 'こんにちは、オージャストの田中です。', timestamp: start + 1000 });

  assert.equal(assembler.finalizedLines.length, 0, '確定前は0件');

  // 2. Tick after 1.5s pause
  const newlyFinalized = assembler.tick(start + 2600);
  assert.equal(newlyFinalized.length, 1);
  assert.equal(newlyFinalized[0].speaker, '田中');
  assert.equal(newlyFinalized[0].text, 'こんにちは、オージャストの田中です。');
  assert.equal(assembler.finalizedLines.length, 1);

  // 3. Speaker switch immediately finalizes previous
  assembler.pushMutation({ speaker: '佐藤', text: 'よろしくお願いします。', timestamp: start + 3000 });
  const switched = assembler.pushMutation({ speaker: '鈴木', text: '本日はお時間ありがとうございます。', timestamp: start + 3200 });

  assert.equal(switched.length, 1);
  assert.equal(switched[0].speaker, '佐藤');
  assert.equal(switched[0].text, 'よろしくお願いします。');
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
  assembler.tick(3000);

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

  assert.equal(await isProfileSignedIn(tmpDir), false);

  const defaultDir = path.join(tmpDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.writeFileSync(path.join(defaultDir, 'Cookies'), 'dummy sqlite cookie content with SID inside', 'utf8');

  assert.equal(await isProfileSignedIn(tmpDir), true);
});
