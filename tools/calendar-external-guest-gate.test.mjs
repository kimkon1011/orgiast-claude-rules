import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { judge } from './calendar-external-guest-gate.mjs';

// Helper: create a minimal transcript fixture for marker testing
function createFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-guest-test-'));
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
  return {
    tmpDir,
    transcriptPath,
    writeTranscript(entries) {
      const content = entries.map(e => JSON.stringify(e)).join('\n');
      fs.writeFileSync(transcriptPath, content, 'utf8');
    },
    cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    },
  };
}

test('calendar-external-guest-gate: non-matching tools pass', () => {
  const res = judge({ tool_name: 'Write', tool_input: { file_path: 'test.txt' } });
  assert.equal(res.decision, 'pass');
});

test('calendar-external-guest-gate: attendee with external email blocks', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
    tool_input: {
      summary: 'Meeting',
      attendees: ['external@example.com'],
    },
  });
  assert.equal(res.decision, 'block');
  assert.ok(res.reason.includes('external@example.com'));
  assert.ok(res.reason.includes('社外'));
});

test('calendar-external-guest-gate: attendee with external email in object form blocks', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
    tool_input: {
      summary: 'Meeting',
      attendees: [{ email: 'external@example.com' }],
    },
  });
  assert.equal(res.decision, 'block');
  assert.ok(res.reason.includes('external@example.com'));
});

test('calendar-external-guest-gate: internal-only attendees pass', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
    tool_input: {
      summary: 'Internal meeting',
      attendees: ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'],
    },
  });
  assert.equal(res.decision, 'pass');
});

test('calendar-external-guest-gate: update_event with external attendee blocks', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__update_event',
    tool_input: {
      eventId: 'evt123',
      attendees: ['internal@orgiast.jp', 'vendor@gmail.com'],
    },
  });
  assert.equal(res.decision, 'block');
  assert.ok(res.reason.includes('vendor@gmail.com'));
});

test('calendar-external-guest-gate: respond_to_event with external attendee blocks', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__respond_to_event',
    tool_input: {
      eventId: 'evt123',
      attendees: ['partner@other-company.com'],
    },
  });
  assert.equal(res.decision, 'block');
});

test('calendar-external-guest-gate: no attendees passes', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
    tool_input: {
      summary: 'No guests',
      start: { dateTime: '2026-11-13T10:00:00' },
    },
  });
  assert.equal(res.decision, 'pass');
});

test('calendar-external-guest-gate: empty attendees array passes', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
    tool_input: {
      summary: 'Empty guests',
      attendees: [],
    },
  });
  assert.equal(res.decision, 'pass');
});

test('calendar-external-guest-gate: staff gmail addresses are treated as internal', () => {
  // taka05250925@gmail.com is in config/staff-addresses.json
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
    tool_input: {
      summary: 'Staff meeting',
      attendees: ['taka05250925@gmail.com'],
    },
  });
  assert.equal(res.decision, 'pass');
});

test('calendar-external-guest-gate: user approval marker cannot bypass prohibition', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'user', message: { role: 'user', content: '[CAL-GUEST-OK] この会議に社外の人を追加して良いです' } },
    ]);

    const res = judge({
      tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
      tool_input: {
        summary: 'Approved external meeting',
        attendees: ['client@example.com'],
      },
      transcript_path: fix.transcriptPath,
    });
    assert.equal(res.decision, 'block');
  } finally {
    fix.cleanup();
  }
});

test('calendar-external-guest-gate: user approval marker with negation still blocks', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'user', message: { role: 'user', content: '[CAL-GUEST-OK] 使わないで' } },
    ]);

    const res = judge({
      tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
      tool_input: {
        summary: 'Negated approval',
        attendees: ['client@example.com'],
      },
      transcript_path: fix.transcriptPath,
    });
    assert.equal(res.decision, 'block');
  } finally {
    fix.cleanup();
  }
});

test('calendar-external-guest-gate: Bash Calendar API call with external email blocks', () => {
  const res = judge({
    tool_name: 'Bash',
    tool_input: {
      command: 'curl -X POST https://www.googleapis.com/calendar/v3/calendars/primary/events -d \'{"attendees":[{"email":"external@test.com"}]}\'',
    },
  });
  assert.equal(res.decision, 'block');
});

test('calendar-external-guest-gate: Bash without Calendar API call passes', () => {
  const res = judge({
    tool_name: 'Bash',
    tool_input: {
      command: 'echo hello',
    },
  });
  assert.equal(res.decision, 'pass');
});

test('calendar-external-guest-gate: google_workspace MCP prefix also covered', () => {
  const res = judge({
    tool_name: 'mcp__google_workspace_Google_Calendar__create_event',
    tool_input: {
      summary: 'External via workspace MCP',
      attendees: ['outside@other.com'],
    },
  });
  assert.equal(res.decision, 'block');
});

test('calendar-external-guest-gate: mixed internal/external blocks', () => {
  const res = judge({
    tool_name: 'mcp__claude_ai_Google_Calendar__create_event',
    tool_input: {
      summary: 'Mixed',
      attendees: [
        { email: 'colleague@orgiast.jp' },
        { email: 'external@vendor.com' },
      ],
    },
  });
  assert.equal(res.decision, 'block');
  assert.ok(res.reason.includes('external@vendor.com'));
});
for (const [name, args] of [
  ['mcp__google_calendar__create_event', {body: {attendees: [{email:'client@example.com'}]}}],
  ['mcp__codex_apps__google_calendar__update_event', {requestBody: JSON.stringify({attendees:['client@example.com']})}],
  ['mcp__claude_ai_Google_Calendar_2__respond_to_event', {attendees:'client@example.com'}],
]) test(`nested/new MCP: ${name}`, () => assert.equal(judge({tool_name:name,tool_input:args}).decision,'block'));
for (const [tool, command] of [
  ['Bash', 'gcal create --attendees client@example.com'],
  ['PowerShell', 'calendar.events.patch({body: {attendees: [{email: "client@example.com"}]}})'],
  ['Bash', 'calendar.events.insert({requestBody: payload})'],
  ['Bash', 'gcal create --attendees "$GUESTS"'],
]) test(`shell bypass: ${command}`, () => assert.equal(judge({tool_name:tool,tool_input:{command}}).decision,'block'));
test('shell internal guests pass', () => assert.equal(judge({tool_name:'Bash',tool_input:{command:'gcal create --attendees kim@orgiast.jp'}}).decision,'pass'));
test('lookalike domain blocks', () => assert.equal(judge({tool_name:'mcp__google_calendar__create_event',tool_input:{attendees:['client@orgiast.jp.evil.com']}}).decision,'block'));

for (const command of [
  `python -c "service = build('calendar', 'v3'); service.events().insert(body=payload)"`,
  `gcalcli add --guest client@example.com`,
  `curl -X POST https://www.googleapis.com/calendar/v3/calendars/kim@orgiast.jp/events -d @payload.json`,
  `gcal create --attendees $GUESTS --calendar kim@orgiast.jp`,
]) test(`additional shell routes: ${command}`, () => assert.equal(judge({tool_name:'Bash',tool_input:{command}}).decision,'block'));

test('real PreToolUse process emits deny JSON', () => {
  const result = spawnSync(process.execPath, ['tools/calendar-external-guest-gate.mjs'], {
    input: JSON.stringify({tool_name:'mcp__google_calendar__create_event',tool_input:{attendees:['client@example.com']}}), encoding:'utf8', timeout:10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
test('canonical hook matcher and converge required repair include the gate', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('./hook-dispatch-manifest.json',import.meta.url),'utf8'));
  const entries = hooks.events?.PreToolUse || hooks.PreToolUse;
  const hook = entries.find(h => h.command.includes('calendar-external-guest-gate.mjs'));
  assert.ok(hook);
  for (const name of ['Bash','PowerShell','mcp__google_calendar__create_event','mcp__claude_ai_Google_Calendar_2__update_event']) assert.match(name, new RegExp(`^(?:${hook.matcher})$`));
  const setup = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json',import.meta.url),'utf8'));
  const item = setup.items.find(i => i.id === 'settings:calendar-external-guest-gate');
  assert.equal(item.severity,'required');
  assert.deepEqual(item.repair,['register-hooks.mjs','--hooks-only']);
});
