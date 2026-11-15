import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveClaudeExecutableFromDisk } from './claude-exe.mjs';

test('resolveClaudeExecutableFromDisk uses CLAUDE_CLI env var over disk search', async () => {
  const mockProcess = {
    platform: 'win32',
    env: {
      CLAUDE_CLI: 'C:\\mock\\claude.exe',
      USERPROFILE: 'C:\\Users\\test',
      APPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join('C:', 'Users', 'test', 'AppData', 'Local'),
    },
  };
  const { executable } = await resolveClaudeExecutableFromDisk(mockProcess);
  assert.equal(executable, 'C:\\mock\\claude.exe');
});