import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeIndex } from './onboarding-sync.mjs';

// 索引(自動ロード層)の上限。2026-10-12 に kim 決定の §1.18.4（着手前のレーン生存確認）を
// ONBOARDING.md へ追加した時点で実測 8244 bytes になり、旧上限 8000 では収まらなくなった。
// §1.18.4 は索引に載る必要がある規則なので、上限を 8400 へ引き上げ、無制限に伸びないよう
// ここで歯止めを掛け直す。次に足す時は、まず既存の見出し/要約行を削ってこの枠に収めること。
const INDEX_MAX_BYTES = 8400;
test('配布する実文書の索引が8400bytes以下で結論と新規約を含む', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const index = makeIndex(body);
  assert(Buffer.byteLength(index) <= INDEX_MAX_BYTES, `${Buffer.byteLength(index)} bytes`);
  for (const line of body.split(/\r?\n/).filter(l => /^\*{0,2}\s*(?:🔴|🛑|⚙️|🔁)/u.test(l))) assert([...line].length <= 200, line);
  assert.match(index, /1\.20 auto mode classifier/);
  assert.match(index, /effortLevel.*medium/);
  assert.match(index, /planIncluded.*監督.*全用途禁止/);
  assert.match(index, /setup --converge.*allow/);
  assert.doesNotMatch(index, /丸1日|1-00:57|コマンド置換として実行/);
  const appendix = body.split('## 付録: 事故履歴と根拠')[1];
  assert(appendix);
  assert.doesNotMatch(appendix, /^### /m);
  assert.match(appendix, /1-00:57/);
});
