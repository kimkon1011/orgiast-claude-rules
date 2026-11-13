import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function getTargetFiles() {
  const files = [];

  function collect(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  }

  for (const relative of ['ONBOARDING.md', 'CLAUDE.md.template']) {
    const full = path.join(rootDir, relative);
    if (fs.existsSync(full)) files.push(full);
  }

  for (const folder of ['rules', 'rules-extracted', 'protocols']) {
    collect(path.join(rootDir, folder));
  }

  const skillsDir = path.join(rootDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) files.push(skillMd);
      }
    }
  }

  return files;
}

test('rule consistency: prohibited expressions in rule files', () => {
  const files = getTargetFiles();
  assert.ok(files.length > 0, 'Should find rule markdown files');

  const violations = [];

  const prohibitedRegexes = [
    { pattern: /\/a\/orgiast\.jp\/\s*を必ず/i, name: '`/a/orgiast.jp/` を必ず' },
    { pattern: /迷ったら止まって/i, name: '迷ったら止まって' },
    { pattern: /LLM-PROVIDER-REASON:\s*<理由/i, name: 'LLM-PROVIDER-REASON: <理由' },
    { pattern: /(?:Sonnet|Opus).*(?:承認後|承認が必要)/i, name: 'Sonnet / Opus ... 承認後' },
  ];

  const kimDmProhibitedRegexes = [
    /kim\s*に\s*DM/i,
    /kim\s*の個別\s*DM/i,
    /自PC分を\s*Discord\s*DM/i,
    /朝の\s*DM/i,
  ];

  // Allowlist for DM expressions (e.g. stating DM abolition, or DM to non-kim, or mentioning kim-inbox)
  const isAllowedDmLine = (line) => {
    if (line.includes('全廃') || line.includes('禁止') || line.includes('使わない') || line.includes('除外')) return true;
    if (line.includes('kim 以外') || line.includes('他メンバー') || line.includes('投稿者本人')) return true;
    if (line.includes('kim-inbox')) return true;
    return false;
  };

  for (const file of files) {
    const relativePath = path.relative(rootDir, file);
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      const lineNum = index + 1;

      for (const { pattern, name } of prohibitedRegexes) {
        if (pattern.test(line)) {
          violations.push(`${relativePath}:${lineNum} - Prohibited pattern [${name}]: "${line.trim()}"`);
        }
      }

      for (const pattern of kimDmProhibitedRegexes) {
        if (pattern.test(line) && !isAllowedDmLine(line)) {
          violations.push(`${relativePath}:${lineNum} - Prohibited kim DM pattern: "${line.trim()}"`);
        }
      }
    });
  }

  assert.deepEqual(violations, [], `Found rule consistency violations:\n${violations.join('\n')}`);
});
