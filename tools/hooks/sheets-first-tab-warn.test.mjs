import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { warning, HOOK_MATCHER } from './sheets-first-tab-warn.mjs';
const script = fileURLToPath(new URL('./sheets-first-tab-warn.mjs', import.meta.url));
for (const tool_name of HOOK_MATCHER.split('|')) {
  test(`stdin emits nonblocking PreToolUse context: ${tool_name}`, () => {
    const result = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name, tool_input: { fileId: 'abc', exportMimeType: 'text/csv' } }), encoding: 'utf8', timeout: 6000 });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /先頭タブしか返りません/);
    assert.match(output.hookSpecificOutput.additionalContext, /C:\\Users\\uers\\orgiast-main\\tools\\sheet-read.mjs/);
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  });
}
test('unknown file type warns; unrelated tools and missing fileId stay silent', () => {
  const tool_name = HOOK_MATCHER.split('|')[0];
  assert.ok(warning({ tool_name, tool_input: { fileId: 'abc' } }));
  assert.equal(warning({ tool_name, tool_input: {} }), undefined);
  assert.equal(warning({ tool_name: 'Bash', tool_input: { fileId: 'abc' } }), undefined);
});
test('malformed or empty stdin fails open', () => {
  for (const input of ['', '{', 'null']) {
    const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 6000 });
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
