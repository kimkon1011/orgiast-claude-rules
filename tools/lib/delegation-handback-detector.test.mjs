import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDelegationHandback } from './delegation-handback-detector.mjs';
import { detectSessions } from '../rule-detectors.mjs';

const registry = { rules: [{ id: 'immediate-start-no-handback' }] };

const TP = [
  'Priority Pass の有効化は、以下の手順をお送りします。ご自身で進めてください。',
  'まず試して結果を教えてください。反応がなければ教えてください。',
  '代行しましょうか？ご希望なら進めます。',
  '依頼文の例を送ってください。それが揃ってから方針を出します。',
  'ログインはご自身で操作してください。手順をご案内します。',
];
const TN = [
  'Priority Pass の有効化は、今から自分の到達経路で着手する。人の操作が要る箇所だけ、一度に必要情報を添えて依頼する。',
  '手続き代行の即時開始ルール。検証をユーザーに任せること自体が差し戻しにあたる。ユーザーに試してもらう、反応がなければ教えてもらうといった検証の手間を、ユーザーに渡さない。',
  '「どうやってやるの？」のような手順相談の形でも、説明や「代行しましょうか」の確認で終わらせず、自分で実行できる部分をその場で始める。',
  '方針: 説明で終わらせず、取れる経路をその場で始める。OTP 入力だけ人に一度依頼する。',
  '今日の天気は晴れ。翌日の予定だけ共有する。',
];

test('差し戻し検出: 真陽性', () => {
  for (const text of TP) {
    const r = detectDelegationHandback(text);
    assert.equal(r.applicable, true, text);
    assert.equal(r.violation, true, text);
  }
});

test('差し戻し検出: 真陰性（ルール引用・実行開始・無関係）', () => {
  for (const text of TN) {
    const r = detectDelegationHandback(text);
    if (text.includes('天気')) {
      assert.equal(r.applicable, false, text);
      assert.equal(r.violation, false, text);
    } else {
      assert.equal(r.violation, false, text);
    }
  }
});

test('detectSessions が immediate-start-no-handback を集計する', () => {
  const session = {
    sessionId: 'fixture-handback',
    events: [{
      event: { type: 'assistant', message: { content: [{ type: 'text', text: TP[0] }] } },
      ts: '2026-11-27T00:00:00Z',
      raw: TP[0],
    }],
  };
  const detected = detectSessions([session], registry, {});
  assert.equal(detected['immediate-start-no-handback'].applicable, 1);
  assert.equal(detected['immediate-start-no-handback'].violation, 1);
});
