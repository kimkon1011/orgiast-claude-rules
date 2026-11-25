import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addItem } from '../tools/kim-inbox.mjs';

const repositoryUrl = 'https://github.com/kimkon1011/orgiast-claude-rules';

async function registerAndReadBack(t, text) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-pr-ref-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const execImpl = async (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 2), ['pr', 'view']);
    return { stdout: JSON.stringify({ url: `${repositoryUrl}/pull/${args[2]}` }) };
  };
  const item = await addItem(home, {
    kind: 'ask',
    text,
    execImpl,
  }, { drain: false, localOnly: true });
  const savedPath = path.join(home, '.claude', 'kim-inbox', `${item.id}.json`);
  return JSON.parse(fs.readFileSync(savedPath, 'utf8')).text;
}

test('registration resolves PR #N references and persists exact text', async t => {
  const cases = [
    {
      name: 'single short reference',
      input: 'PR #2650',
      expected: `PR #2650 (${repositoryUrl}/pull/2650)`,
    },
    {
      name: 'multiple short references',
      input: 'PR #123 と PR #456',
      expected: `PR #123 (${repositoryUrl}/pull/123) と PR #456 (${repositoryUrl}/pull/456)`,
    },
    {
      name: 'existing full URL is idempotent',
      input: `PR #2650 (${repositoryUrl}/pull/2650)`,
      expected: `PR #2650 (${repositoryUrl}/pull/2650)`,
    },
    {
      name: 'references without a valid PR prefix are unchanged',
      input: '#2650 と PR #abc',
      expected: '#2650 と PR #abc',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async t => {
      const actual = await registerAndReadBack(t, entry.input);
      assert.equal(actual, entry.expected);
    });
  }
});
