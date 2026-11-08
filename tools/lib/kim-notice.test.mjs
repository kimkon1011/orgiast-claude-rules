import test from 'node:test';
import assert from 'node:assert/strict';
import { formatKimNotice } from './kim-notice.mjs';
import { toPlainJa } from './plain-ja.mjs';

test('detail無しなら必ず3行、次の行動が空でも明示する', () => {
  assert.deepEqual(formatKimNotice({ what: '終わりました。' }).split('\n'), ['終わりました。', '次に自動でやること: なし（これで終わりです）', 'kim がすること: なし']);
});
test('detailのIDはバッククォート内に残り、平易化でも保護される', async () => {
  const text = formatKimNotice({ what: '連絡が届いていません。', next: '再度確認します', kim: 'なし', detail: '`mail-abcdef12`' });
  assert.equal(text.split('\n').length, 4);
  assert.equal(text.split('\n')[3], '`mail-abcdef12`');
  assert.equal(await toPlainJa(text, { ask: () => assert.fail('protected') }), text);
});
test('入力の改行を折りたたみ4行以内にする', () => {
  assert.equal(formatKimNotice({ what: '状況\n説明', next: '次\nの処理', kim: '返信\nする', detail: 'id\nmore' }).split('\n').length, 4);
});
