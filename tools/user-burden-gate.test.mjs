import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeUserBurden } from './user-burden-gate.mjs';
const audit = '手間監査: ①Claude の PowerShell 実行は classifier に拒否された。②MCP と fleet の自己修復を試したが権限不足で失敗。user は1操作。';
const launcher = 'C:\\Users\\日本語 user\\OneDrive\\Desktop\\登録（ダブルクリック）.cmd';
for (const cli of ['pwsh -File x.ps1', 'powershell -File x.ps1', 'node x.mjs', 'npm run setup', 'git pull', './登録.ps1', 'bash setup.sh']) {
  test(`blocks command handoff: ${cli}`, () => assert.equal(judgeUserBurden(`実行してください。\n\`\`\`\n${cli}\n\`\`\`\n${audit}`).decision, 'block'));
}
test('launcher with both attempted routes passes', () => {
  assert.equal(judgeUserBurden(`次に kim がすること: ダブルクリックする\n${launcher}\n${audit}`).decision, 'pass');
});
test('no request: Claude command explanation does not trigger', () => {
  assert.equal(judgeUserBurden('Claude 自身が次を実行しました。\n```pwsh\nnode check.mjs\n```').triggered, false);
});
test('launcher requires both attempts on audit line', () => {
  for (const incomplete of ['CLI を試したが拒否。1操作', '権限不足。1操作', '①Claude の実行は拒否。1操作', '②MCP を試したが拒否。1操作']) {
    assert.equal(judgeUserBurden(`次に kim がすること: ダブルクリックする\n${launcher}\n手間監査: ${incomplete}`).decision, 'block');
  }
});
test('explicit request and justified override; incidental command mention is no exemption', () => {
  const response = `実行してください。\n\`\`\`pwsh\nGet-Date\n\`\`\`\n${audit}`;
  assert.equal(judgeUserBurden(response, 'コマンドを教えて').decision, 'pass');
  assert.equal(judgeUserBurden(response, 'コマンドが失敗した').decision, 'block');
  assert.equal(judgeUserBurden(response + '\n[BURDEN-OK] user が本文を希望').decision, 'pass');
});

test('path-only handoff still requires audit evidence', () => {
  assert.equal(judgeUserBurden(launcher).decision, 'block');
  assert.equal(judgeUserBurden(`${launcher}\n${audit}`).decision, 'pass');
});

test('手渡し内の未確認事項を block する', () => {
  const result = judgeUserBurden(`次に kim がすること: OpenRouter の持ち主は未確認のまま開く\n${audit}`);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /^\[UNRESOLVED-IN-HANDOFF\]/);
  const steps = judgeUserBurden(`次に kim がすること: 設定画面を開く\n1. 手順: リンクを開く\n2. 場所: 管理アカウントは要確認\nhttps://example.com/settings\n${audit}`);
  assert.equal(steps.decision, 'block');
  assert.match(steps.reason, /管理アカウントは要確認/);
});

test('手渡し外の未確認は対象外', () => {
  assert.equal(judgeUserBurden(`調査報告: 契約日は未確認です。\n次に kim がすること: ダブルクリックする\n${launcher}\n${audit}`).decision, 'pass');
});

test('未確認事項のない手渡しは従来どおり通過', () => {
  assert.equal(judgeUserBurden(`次に kim がすること: ダブルクリックする\n${launcher}\n${audit}`).decision, 'pass');
});

test('本番デプロイのターミナル手渡しは手順が揃っていても block する', () => {
  const text = `本番に出したいので、PowerShell を開いて次を貼って実行してください。\n\`\`\`bash\ncd D:\\Claude\\event-shop\nnpx vercel deploy --prod --yes\n\`\`\`\n${audit}`;
  const result = judgeUserBurden(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'PROD-DEPLOY-HANDOFF');
});

test('本番反映の1クリック起爆ファイルも block する', () => {
  const result = judgeUserBurden(`次に kim がすること: 本番反映（ダブルクリック）\nC:\\Users\\test\\Desktop\\本番反映.cmd\n${audit}`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'PROD-DEPLOY-HANDOFF');
});

test('コマンド無しの「本番反映を実行してください」も block する', () => {
  const result = judgeUserBurden(`本番反映を実行してください。\n${audit}`);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'PROD-DEPLOY-HANDOFF');
});

test('Claude が実行した報告と、user 自身が実行すると明示した場合だけ通す', () => {
  assert.equal(judgeUserBurden('Claude 側で `npx vercel deploy --prod --yes` を実行しました。`vercel inspect` で新しい id と alias を確認済みです。\n次に kim がすること: なし').triggered, false);
  const explicit = `user がご自身で実行すると仰ったので手順を再掲します。\n\`\`\`bash\nnpx vercel deploy --prod --yes\n\`\`\`\n実行してください。\n[PROD-DEPLOY-HANDOFF-OK] 「自分でデプロイしたい」と user が明示\n${audit}`;
  assert.equal(judgeUserBurden(explicit, 'コマンドを教えて').decision, 'pass');
});
