import test from 'node:test';
import assert from 'node:assert/strict';
import { isKimDelivered } from './kim-delivery.mjs';

test('dm・session-inbox・spooled を配信済みとして扱う', () => {
  for (const delivered of ['dm', 'session-inbox', 'spooled']) {
    assert.equal(isKimDelivered({ delivered }), true, delivered);
  }
});

test('none・suppressed・結果なしは既定で未配信として扱う', () => {
  assert.equal(isKimDelivered({ delivered: 'none' }), false);
  assert.equal(isKimDelivered({ delivered: 'suppressed' }), false);
  assert.equal(isKimDelivered(null), false);
  assert.equal(isKimDelivered(), false);
});

test('呼び出し側が指定した成功値を追加できる', () => {
  const extra = ['webhook', 'suppressed'];
  for (const delivered of extra) {
    assert.equal(isKimDelivered({ delivered }), false);
    assert.equal(isKimDelivered({ delivered }, { extra }), true);
  }
  assert.equal(isKimDelivered({ delivered: 'spooled' }, { extra }), true);
});
