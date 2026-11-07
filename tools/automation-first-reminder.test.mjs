import test from 'node:test';
import assert from 'node:assert/strict';
import { additionalContext, getComplianceContext } from './automation-first-reminder.mjs';

test('認証の取得・設定は keyserve と専用ツールを案内する', () => {
  assert.match(additionalContext, /keyserve-status\.mjs/);
  assert.match(additionalContext, /env-kv\.mjs/);
  assert.doesNotMatch(additionalContext, /transcript|\.env\.local|gh secret set/);
  assert.match(additionalContext, /一括拒否から個別不可を推定せず、手渡し前に最小単位で1回試す/);
  assert.match(additionalContext, /\(0\) 外部 SaaS の所有アカウント・ログイン先は、Gmail で業者名（receipts\/notifications\/invoice）を検索し、memory の reference_\* と照合して特定する/);
});

test('getComplianceContext は遵守状況メッセージを返す', () => {
  const context = getComplianceContext();
  assert.match(context, /\[遵守状況\]/);
  assert.match(context, /handoff-quality/);
});
