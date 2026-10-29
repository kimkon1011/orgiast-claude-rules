import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, HOOK_MATCHER } from './kim-discord-report-gate.mjs';
const input = (tool_name, tool_input) => ({ tool_name, tool_input });
test('kim 宛 DM と claude-code 投稿を拒否し他メンバーは許可する', () => {
  for (const user_id of ['715210673642012733', 'kim', '金功勇']) assert.equal(judge(input('mcp__claude_ai_Discord__send_dm', { user_id, content: '報告' }), { allowlist: [] }).decision, 'block');
  for (const action of ['send_message', 'reply_message']) assert.equal(judge(input(`mcp__claude_ai_Discord_2__${action}`, { channel_id: '1508437329247862794', content: '報告' }), { allowlist: [] }).decision, 'block');
  assert.equal(judge(input('mcp__claude_ai_Discord__send_dm', { user_id: '123' }), { allowlist: [] }).decision, 'pass');
  assert.match('PowerShell', new RegExp(HOOK_MATCHER));
});
test('直接 API・webhook は拒否し正規 CLI と dry-run と許可カテゴリは通す', () => {
  for (const tool of ['Bash', 'PowerShell']) {
    for (const command of ['curl https://discord.com/api/v10/channels/1508437329247862794/messages', 'curl $(cat orgiast-discord-webhook.txt)', 'Invoke-RestMethod https://discordapp.com/api -Body 715210673642012733']) assert.equal(judge(input(tool, { command }), { allowlist: [] }).decision, 'block');
    for (const command of ['node tools/notify-kim.mjs "報告"', 'node tools/discord-dm.mjs kim --body-file x', 'curl https://discord.com/api 715210673642012733 --dry-run']) assert.equal(judge(input(tool, { command }), { allowlist: [] }).decision, 'pass');
  }
  assert.equal(judge(input('mcp__claude_ai_Discord__send_dm', { user_id: 'kim', content: '定時報告' }), { allowlist: [{ category: '定時', pattern: '^定時' }] }).decision, 'pass');
});
