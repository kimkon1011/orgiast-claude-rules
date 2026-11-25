// setup-manifest.json の required な CLAUDE.md 検査語が ONBOARDING.md の現行文言とずれると、
// 全PRの clean-install が setup.mjs --verify の required NG で落ちる。
// 2026-10-23 実害: #1062 が Discord 連絡ルールの文言を変えたのに manifest は旧文言のままだったため、
// main の clean-install が赤くなり pr-merge が止まった（bootstrap を最後まで走らせないと気づけない）。
// 文言を変える PR がこのテストで即座に落ちるようにし、CI の 15 分を待たない。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(toolsDir);
const manifest = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8'));
const onboarding = fs.readFileSync(path.join(repoDir, 'ONBOARDING.md'), 'utf8');

test('required CLAUDE.md checks match the wording shipped by ONBOARDING.md', () => {
  const checks = manifest.items.filter((item) =>
    item.type === 'file-contains'
    && item.severity === 'required'
    && item.spec?.path === '.claude/CLAUDE.md');
  assert.ok(checks.length > 0, 'no required .claude/CLAUDE.md checks found');
  for (const item of checks) {
    const ok = item.spec.regex
      ? new RegExp(item.spec.regex).test(onboarding)
      : onboarding.includes(item.spec.contains);
    assert.ok(ok, `${item.id} does not match ONBOARDING.md (rewording broke the clean-install verifier)`);
  }
});
