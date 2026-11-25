import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { judgeUserCodeInput } from './user-code-input-gate.mjs';

const request = 'コード **16RV-4CDYM** を入力して、承認ボタンを押す\nhttps://auth.openai.com/codex/device';
for (const [name, text, expected] of [
  ['actual incident', request, 'block'],
  ['code without URL', 'コード **16RV-4CDYM** を入力して、承認ボタンを押す', 'block'],
  ['English', 'Enter ABCD-1234', 'block'],
  ['inline code is still a request', 'コード `ABCD-1234` を入力', 'block'],
  ['reason', `[CODE-INPUT-UNAVOIDABLE: Windows codex login 不可(実測)、auth.json 複製元も失効]\n${request}`, 'pass'],
  ['short reason', `[CODE-INPUT-UNAVOIDABLE: 不可]\n${request}`, 'block'],
  ['whitespace reason', `[CODE-INPUT-UNAVOIDABLE:                  ]\n${request}`, 'block'],
  ['fenced example', `過去の失敗例:\n\`\`\`text\n${request}\n\`\`\``, 'pass'],
  ['tilde fence', `~~~text\n${request}\n~~~`, 'pass'],
  ['unclosed fence', `\`\`\`text\n${request}`, 'pass'],
  ['blockquote', request.split('\n').map(line => `> ${line}`).join('\n'), 'pass'],
  ['indented code', request.split('\n').map(line => `    ${line}`).join('\n'), 'pass'],
  ['normal prose', 'ブラウザで承認ボタンを押してください。', 'pass'],
  ['SKU', 'SKU: ABCD-1234', 'pass'],
  ['long identifier', '入力 ABCDE-123456', 'pass'],
  ['quoted reason cannot exempt request', `> [CODE-INPUT-UNAVOIDABLE: Windows codex login 不可(実測)]\n${request}`, 'block'],
  ['fenced reason cannot exempt request', `\`\`\`\n[CODE-INPUT-UNAVOIDABLE: Windows codex login 不可(実測)]\n\`\`\`\n${request}`, 'block'],
  ['request after example', `\`\`\`\n${request}\n\`\`\`\n${request}`, 'block'],
]) test(name, () => assert.equal(judgeUserCodeInput(text).decision, expected));
for (const domain of ['auth.openai.com/codex/device', 'github.com/login/device', 'microsoft.com/devicelogin', 'google.com/device']) {
  test(domain, () => assert.equal(judgeUserCodeInput(`https://${domain}`).decision, 'block'));
}
test('converge deploys gate and selfcheck requires its shared Stop entrypoint', async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url)));
  const rows = Object.values(manifest).find(Array.isArray);
  const entry = rows.find(row => row.id === 'hook:user-code-input-gate');
  assert.equal(entry.severity, 'required');
  assert.deepEqual(entry.repair, ['onboarding-sync.mjs', '--force']);
  assert.ok(rows.some(row => row.id === 'settings:stop-gate-runner'));
  const { REQUIRED_HOOKS } = await import('./hook-selfcheck.mjs');
  assert.ok(REQUIRED_HOOKS.some(([event, file]) => event === 'Stop' && file === 'stop-gate-runner.mjs'));
});
