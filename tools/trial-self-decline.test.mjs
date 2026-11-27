import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrialSelfDecline, hasTrialStarted, trialDeclineAnswer,
  isTrialMidpointFail, trialFailAnswer, TRIAL_DOC_URL, TRIAL_RESIGN_URL,
} from './lib/trial-self-decline.mjs';

test('キーワードがあるときのみ classification、厳密な boolean 判定', async () => {
  let calls = 0;
  const llm = async ({ category, input }) => {
    calls++;
    assert.equal(category, 'classification');
    assert.match(input.question, /辞退|やめ|辞め/);
    return '{"selfDecline":true}';
  };
  assert.equal(await isTrialSelfDecline(llm, 'こんにちは'), false);
  for (const text of ['辞退します', 'やめます', '辞めます']) {
    assert.equal(await isTrialSelfDecline(llm, text), true);
  }
  assert.equal(calls, 3);
  for (const raw of ['oops', 'null', '{}', '{"selfDecline":"true"}', '{"selfDecline":false}']) {
    assert.equal(await isTrialSelfDecline(async () => raw, '辞退'), false);
  }
  assert.equal(await isTrialSelfDecline(async () => { throw new Error('test'); }, '辞退'), false);
  
  // LLMが ```json フェンス付きで返す場合のテスト
  assert.equal(await isTrialSelfDecline(async () => '```json\n{"selfDecline":true}\n```', '辞退'), true);
});

test('報告らしき文の条件は同じ発言内で成立する必要がある', () => {
  assert.equal(hasTrialStarted(['トライアル 1日目 累計']), true);
  assert.equal(hasTrialStarted(['トライアル 2時間 完了']), true);
  assert.equal(hasTrialStarted(['トライアル', '1日目 累計']), false);
  assert.equal(hasTrialStarted(['トライアル 1日目', '完了']), false);
  assert.equal(hasTrialStarted([]), false);
});

test('指定文面を改行も含め完全一致で検証', () => {
  assert.equal(trialDeclineAnswer(true), `ご連絡ありがとうございます。承知いたしました。

お手数ですが、
こちらの一番下に辞退の手続きがございますので、最後お手間をおかけしますが、実施をおねがいできますでしょうか。

入社トライアルについて　${TRIAL_DOC_URL}

Googleグループへの参加やマニュアルの閲覧申請をされた場合はお手続きをお願い致します。

手続きが完了しましたら、勤務開始している場合は報酬をお支払いさせていただきます。

お手数をおかけして恐縮ですが、何卒よろしくお願いいたします。`);
  assert.equal(trialDeclineAnswer(false), `ご連絡ありがとうございます。承知いたしました。

お手数ですが、
こちらの一番下に辞退の手続きがございますので、最後お手間をおかけしますが、実施をおねがいできますでしょうか。

まだ入社手続きをしていない場合は不要です。

入社トライアルについて　${TRIAL_DOC_URL}

まだ入社手続きを行っておらず、マニュアルの閲覧申請などもされていない場合は不要です。Googleグループへの参加やマニュアルの閲覧申請をされた場合はお手続きをお願い致します。

手続きが完了しましたら、勤務開始している場合は報酬をお支払いさせていただきます。

お手数をおかけして恐縮ですが、何卒よろしくお願いいたします。`);
});

const FAIL_ASK = `お疲れ様です。

昨日のトライアル3日目で到達タスクが20件未満だったのですが、本日も業務を続けてよろしいのでしょうか。`;

const FAIL_REPORT = `1.トライアル：3日目
2.トライアル残り日数：9日
3.それぞれの残タスク数：
イベントタスク：190タスク
6.累計完了タスク数
イベントタスク：8件、チュートリアル情報収集：3件`;

const PASS_REPORT = `1.トライアル：3日目
2.トライアル残り日数：9日
6.累計完了タスク数
イベントタスク：18件、チュートリアル情報収集：6件、マニュアル更新：4件`;

const DAY2_REPORT = `1.トライアル：2日目
2.トライアル残り日数：10日
6.累計完了タスク数
イベントタスク：3件、チュートリアル情報収集：3件`;

test('途中通過条件の未達: 3日目20件未満の質問・報告は true、達成や2日目は false', () => {
  assert.equal(isTrialMidpointFail(FAIL_ASK), true);
  assert.equal(isTrialMidpointFail(FAIL_REPORT), true);
  assert.equal(isTrialMidpointFail(PASS_REPORT), false);
  assert.equal(isTrialMidpointFail(DAY2_REPORT), false);
  assert.equal(isTrialMidpointFail('本日も業務を続けてよろしいのでしょうか。', [FAIL_REPORT]), true);
  assert.equal(isTrialMidpointFail('本日も業務を続けてよろしいのでしょうか。', [PASS_REPORT]), false);
  assert.equal(isTrialMidpointFail('3日目で20件未満の場合はどうなりますか'), false);
  assert.equal(isTrialMidpointFail('初日の完了が0件でした'), true);
  assert.equal(isTrialMidpointFail('副業型で開始から24時間、累計完了タスク数はイベントタスク：10件です'), true);
  assert.equal(isTrialMidpointFail('トライアル2日目でまだ20件未満ですが、続けてよいですか'), false);
});

test('終了案内の定型文はお礼・途中通過条件・辞退手続き・報酬の規定を含む', () => {
  const started = trialFailAnswer(true);
  const notStarted = trialFailAnswer(false);
  assert.match(started, /ありがとうございました/);
  assert.match(started, /途中通過条件/);
  assert.match(started, /20件未満/);
  assert.match(started, /トライアルは終了とさせていただきます/);
  assert.match(started, new RegExp(TRIAL_DOC_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(started, new RegExp(TRIAL_RESIGN_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(started, /月末締め翌月末払い/);
  assert.equal(started.includes('まだ入社手続きをしていない場合は不要です。'), false);
  assert.equal(notStarted.includes('まだ入社手続きをしていない場合は不要です。'), true);
  assert.doesNotMatch(started, /090-\d{4}-\d{4}/);
});
