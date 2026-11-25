import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrialSelfDecline, hasTrialStarted, trialDeclineAnswer } from './lib/trial-self-decline.mjs';

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

入社トライアルについて　https://docs.google.com/document/d/1iW5ltEJQSoxrY-znL5khCuSh1HydW4iT_Fq9dmvlUuk/

Googleグループへの参加やマニュアルの閲覧申請をされた場合はお手続きをお願い致します。

手続きが完了しましたら、勤務開始している場合は報酬をお支払いさせていただきます。

お手数をおかけして恐縮ですが、何卒よろしくお願いいたします。`);
  assert.equal(trialDeclineAnswer(false), `ご連絡ありがとうございます。承知いたしました。

お手数ですが、
こちらの一番下に辞退の手続きがございますので、最後お手間をおかけしますが、実施をおねがいできますでしょうか。

まだ入社手続きをしていない場合は不要です。

入社トライアルについて　https://docs.google.com/document/d/1iW5ltEJQSoxrY-znL5khCuSh1HydW4iT_Fq9dmvlUuk/

まだ入社手続きを行っておらず、マニュアルの閲覧申請などもされていない場合は不要です。Googleグループへの参加やマニュアルの閲覧申請をされた場合はお手続きをお願い致します。

手続きが完了しましたら、勤務開始している場合は報酬をお支払いさせていただきます。

お手数をおかけして恐縮ですが、何卒よろしくお願いいたします。`);
});
