import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyAbandoned, decideLaunch, evaluateSessionCap, findHourlySessions, HOURLY_MARKER } from './session-cap-guard.mjs';

const hourly = (pid) => ({ Name: 'claude.exe', ProcessId: pid, CommandLine: `claude -p "${HOURLY_MARKER}"` });

test('below the cap allows launch and ignores unrelated Claude processes', () => {
  const result = evaluateSessionCap([hourly(1), { Name: 'claude.exe', CommandLine: 'claude --interactive' }], { limit: 2 });
  assert.equal(result.allow, true);
  assert.equal(result.active.length, 1);
});

test('at the cap skips launch', () => {
  const result = evaluateSessionCap([hourly(1), hourly(2)], { limit: 2 });
  assert.equal(result.allow, false);
});

test('abandoned boundary is inclusive and closed sessions are excluded', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const sessions = [
    { sessionId: 'before', lastActivity: '2026-11-17T09:00:00.001Z', closed: false },
    { sessionId: 'boundary', lastActivity: '2026-11-17T09:00:00.000Z', closed: false },
    { sessionId: 'closed', lastActivity: '2026-11-17T08:00:00.000Z', closed: true },
  ];
  assert.deepEqual(classifyAbandoned(sessions, now, 3).map((row) => row.sessionId), ['boundary']);
});

test('enumeration failure warns and fails open', () => {
  const result = decideLaunch({ enumerateProcesses: () => { throw new Error('CIM unavailable'); }, listSessions: () => [] });
  assert.equal(result.allow, true);
  assert.match(result.warning, /CIM unavailable/);
});

test('non-hourly Claude launch bypasses the hourly cap', () => {
  const result = decideLaunch({
    isHourlyLaunch: () => false,
    enumerateProcesses: () => [hourly(1), hourly(2)],
    listSessions: () => { throw new Error('must not scan'); },
  });
  assert.equal(result.allow, true);
  assert.equal(result.applicable, false);
});

test('findHourlySessions skips files older than scanHours', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-guard-test-'));
  try {
    const projects = path.join(tmp, '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    const now = Date.parse('2026-11-17T12:00:00.000Z');
    // file modified 96h ago — well beyond the default 48h scan window
    const oldFile = path.join(projects, 'old-session.jsonl');
    fs.writeFileSync(oldFile, HOURLY_MARKER, 'utf8');
    fs.utimesSync(oldFile, new Date(now - 96 * 60 * 60 * 1000), new Date(now - 96 * 60 * 60 * 1000));
    // file modified 1h ago — within scan window
    const freshFile = path.join(projects, 'fresh-session.jsonl');
    fs.writeFileSync(freshFile, HOURLY_MARKER, 'utf8');
    fs.utimesSync(freshFile, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));
    const result = findHourlySessions(tmp, { now, scanHours: 48 });
    assert.equal(result.length, 1);
    assert.equal(result[0].sessionId, 'fresh-session');
    assert.equal(fs.existsSync(oldFile), true); // file survives, just not scanned
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findHourlySessions respects custom scanHours', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-guard-test-'));
  try {
    const projects = path.join(tmp, '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    const now = Date.parse('2026-11-17T12:00:00.000Z');
    // file modified 72h ago — outside 48h default but inside 96h custom
    const oldFile = path.join(projects, 'ninety-six.jsonl');
    fs.writeFileSync(oldFile, HOURLY_MARKER, 'utf8');
    fs.utimesSync(oldFile, new Date(now - 72 * 60 * 60 * 1000), new Date(now - 72 * 60 * 60 * 1000));
    const resultDefault = findHourlySessions(tmp, { now });
    assert.equal(resultDefault.length, 0);
    const resultCustom = findHourlySessions(tmp, { now, scanHours: 96 });
    assert.equal(resultCustom.length, 1);
    assert.equal(resultCustom[0].sessionId, 'ninety-six');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findHourlySessions detects marker in head and closed status from tail', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-guard-test-'));
  try {
    const projects = path.join(tmp, '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    const now = Date.parse('2026-11-17T12:00:00.000Z');
    // file with marker in the first 64KB and session-close in the tail
    const head = `${'x'.repeat(1024)}\n${HOURLY_MARKER}`.padEnd(50000, 'y');
    const tail = `${'z'.repeat(200000)}\n<command-name>/session-close</command-name>`;
    const closedFile = path.join(projects, 'closed-session.jsonl');
    fs.writeFileSync(closedFile, head + tail, 'utf8');
    fs.utimesSync(closedFile, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));
    // file with marker but no session-close
    const head2 = `${'a'.repeat(1024)}\n${HOURLY_MARKER}`.padEnd(50000, 'b');
    const tail2 = 'c'.repeat(200);
    const openFile = path.join(projects, 'open-session.jsonl');
    fs.writeFileSync(openFile, head2 + tail2, 'utf8');
    fs.utimesSync(openFile, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));
    // file without marker at all — should be skipped
    const noMarkerFile = path.join(projects, 'no-marker.jsonl');
    fs.writeFileSync(noMarkerFile, `{"message":"nothing here"}`, 'utf8');
    fs.utimesSync(noMarkerFile, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));
    const result = findHourlySessions(tmp, { now, scanHours: 48 });
    result.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    assert.equal(result.length, 2);
    assert.equal(result[0].sessionId, 'closed-session');
    assert.equal(result[0].closed, true);
    assert.equal(result[1].sessionId, 'open-session');
    assert.equal(result[1].closed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
