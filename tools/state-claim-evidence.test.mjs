import test from 'node:test';
import assert from 'node:assert/strict';
import { queriedVendorsFromRaw, claimVendor } from './state-claim-evidence.mjs';
const tool = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
test('vendor CLI, exact/subdomain URL hosts and MCP server map to distinct vendors', () => {
  for (const [name, input, vendor] of [
    ['Bash', { command: 'gh api user' }, 'github'], ['Bash', { command: 'npx vercel env ls' }, 'vercel'],
    ['Bash', { command: 'clasp list' }, 'google'], ['Bash', { command: 'gcloud projects list' }, 'google'],
    ['Bash', { command: 'wrangler deployments list' }, 'cloudflare'], ['Bash', { command: 'supabase projects list' }, 'supabase'],
    ['Bash', { command: 'curl https://api.openai.com/v1/organization/costs' }, 'openai'],
    ['WebFetch', { url: 'https://api.github.com/user' }, 'github'], ['mcp__claude_ai_Google_Drive__search_files', {}, 'google'],
    ['mcp__vercel__list_projects', {}, 'vercel'],
  ]) assert.deepEqual([...queriedVendorsFromRaw(tool(name, input))], [vendor]);
});
test('claim vendors separate AI providers, Google Search Console and GitHub', () => {
  for (const [text, expected] of [['Anthropic Billing', 'anthropic'], ['OpenAI Usage Limits', 'openai'], ['Search Console', 'google'], ['GitHub Actions', 'github'], ['不明なサービス', null]])
    assert.equal(claimVendor(text), expected);
});
