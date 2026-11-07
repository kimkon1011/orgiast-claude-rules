import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { delegated, operator, isGateRequiredCommand } from './pretooluse-lane-guard.mjs';
import { classifyBashCommand } from './usage-stats.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

function requiredCommands(file) {
  const source = fs.readFileSync(path.join(toolsDir, file), 'utf8');
  return [...new Set([...source.matchAll(/node tools\/[A-Za-z0-9._-]+\.mjs/g)].map(match => match[0]))];
}

function isAlwaysAllowed(command) {
  return isGateRequiredCommand(command) || delegated.test(command) || operator.test(command)
    || ['read-only', 'git'].includes(classifyBashCommand(command));
}

test('Stop ゲートが要求する node コマンドは lane guard の常時許可契約に含まれる', () => {
  const commands = requiredCommands('next-action-gate.mjs');
  assert.ok(commands.includes('node tools/auto-progress.mjs'));
  for (const command of commands) assert.equal(isAlwaysAllowed(command), true, command);
});

test('repair-first の解除コマンドは既存 lane guard でも常時許可される', () => {
  const commands = requiredCommands('lane-repair-first-gate.mjs');
  assert.ok(commands.includes('node tools/lane-repair-log.mjs'));
  for (const command of commands) assert.equal(isAlwaysAllowed(command), true, command);
});
