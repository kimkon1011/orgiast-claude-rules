import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('global intake signals and review/distribution workflow',()=>{
  const s=fs.readFileSync(new URL('../skills/global-rule-rollout/SKILL.md',import.meta.url),'utf8');
  for(const signal of ['組織指示に入れて','全体ルールに追加','全体配布して']) assert.ok(s.split('\n').find(l=>l.startsWith('description:')).includes(signal));
  for(const requirement of ['既実装','番号付き・1項目1〜2行','Google ドキュメント','authuser=kim@orgiast.jp','hook・定期ジョブ','PR','各PCの同期']) assert.ok(s.includes(requirement),requirement);
});
