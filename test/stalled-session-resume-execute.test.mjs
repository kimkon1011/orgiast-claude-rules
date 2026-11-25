import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execute } from '../tools/stalled-session-resume.mjs';

function stubRecord() {
  return {
    sessionId: 'test123',
    displayTitle: '【11/25/10:00まで】テスト',
    file: 'C:/nul/NONEXIST.jsonl',
    cwd: os.homedir(),
    firstPrompt: 'テスト目的',
    lastAssistantText: 'テスト応答',
  };
}

/**
 * Create an io stub that makes executeOverdue / executeFallback
 * return a simulated outcome without running real claude.
 */
function executingIo({ hourlyResume = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssr-exec-test-'));
  // touch a dummy transcript file so stat works
  const projectDir = path.join(tmpDir, '.claude', 'projects', 'main');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, 'test123.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
  return {
    tmpDir: path.resolve(tmpDir),
    transcript,
    io: {
      home: tmpDir,
      fetchClaudePlanUsage: async () => ({ available: false }),
      hourlyResumePolicy: () => ({ hourlyResume, hourlyCap: 4, perSessionDailyCap: 6, planUsageStopPct: 85, reason: '' }),
      // Bypass seat guard
      evaluateGuard: async () => ({ blocked: false }),
      // Make claude --help check throw so we hit the executeFallback path
      execFile: async () => { throw new Error('no claude'); },
      // Simulate a successful fallback run
      runChild: async () => ({ status: 'success', executorUsed: 'test-stub', executorAttempts: [] }),
      // Return a plausible result file
      readReport: async () => null,
      // Provide a stat that finds the transcript
      stat: async (p) => fs.promises.stat(p),
      // We need readFile for the stat to work in executeOverdue's size check
    },
  };
}

describe('execute() hourly mode permission', () => {
  it('hourly=true + hourlyResume=true + autoResumeAllowed=false で disabled を返さない', async () => {
    const { tmpDir, transcript, io } = executingIo({ hourlyResume: true });
    try {
      const record = stubRecord();
      record.file = transcript;
      const result = await execute(record, {
        timeoutMs: 60000,
        resultFile: path.join(tmpDir, 'result.json'),
        previous: [],
        wait: null,
        event: 'hourly',
        hourly: true,
      }, io);
      // Should NOT be disabled (hourly permission should pass)
      assert.notEqual(result.outcome, 'disabled', 'hourly mode should not be disabled when hourlyResume=true');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hourly=false + wait=null + autoResumeAllowed=false で disabled を返す', async () => {
    const { tmpDir, transcript, io } = executingIo({ hourlyResume: true });
    try {
      const record = stubRecord();
      record.file = transcript;
      const result = await execute(record, {
        timeoutMs: 60000,
        resultFile: path.join(tmpDir, 'result.json'),
        previous: [],
        wait: null,
        event: null,
        hourly: false,
      }, io);
      // Should be disabled because autoResumeAllowed() = false
      assert.equal(result.outcome, 'disabled', 'non-hourly mode without wait should be disabled when autoResumeAllowed=false');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hourly=true + hourlyResume=false で disabled を返す', async () => {
    const { tmpDir, transcript, io } = executingIo({ hourlyResume: false });
    try {
      const record = stubRecord();
      record.file = transcript;
      const result = await execute(record, {
        timeoutMs: 60000,
        resultFile: path.join(tmpDir, 'result.json'),
        previous: [],
        wait: null,
        event: 'hourly',
        hourly: true,
      }, io);
      // Should be disabled because hourlyResume=false
      assert.equal(result.outcome, 'disabled', 'hourly mode should be disabled when hourlyResume=false');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
