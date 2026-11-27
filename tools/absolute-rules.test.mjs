import test from 'node:test'; import assert from 'node:assert/strict';
import { withAbsoluteRules, injectAbsoluteRules, ABSOLUTE_RULES_SYSTEM } from './lib/absolute-rules.mjs';
test('全LLM呼び出しの system 先頭に絶対ルールを1回だけ付ける', () => {
  const m = withAbsoluteRules([{ role: 'user', content: 'hi' }]);
  assert.equal(m[0].content, ABSOLUTE_RULES_SYSTEM);
  const s = withAbsoluteRules([{ role: 'system', content: 'JSONのみ' }, { role: 'user', content: 'x' }]);
  assert.ok(s[0].content.startsWith('【絶対ルール】スピードの経済価値を最重視')); assert.match(s[0].content, /JSONのみ$/);
  assert.deepEqual(withAbsoluteRules(s), s);
  const r = injectAbsoluteRules({ url: 'u', init: { body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) } });
  assert.match(JSON.parse(r.init.body).messages[0].content, /バッファ/);
  assert.equal(injectAbsoluteRules(null), null);
});
test('ABSOLUTE_RULES_SYSTEM に認証コード受け取りと空港案内の文言を含む', () => {
  assert.match(ABSOLUTE_RULES_SYSTEM, /受信トレイを直接開き/);
  assert.match(ABSOLUTE_RULES_SYSTEM, /コンコースをまたいで/);
});
