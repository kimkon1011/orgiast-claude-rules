// Simple verification script for the reopen-lost-sessions fixes
// This script tests the key fixes without running the full test suite

const { execFileSync } = require('node:child_process');
// Test 1: Verify isWaitingSession function
console.log('Testing isWaitingSession function...');

// Import the module using execFile to run ES modules
const { default: reopenLostSessions } = execFileSync('node', ['--eval', 'console.log(JSON.stringify(reopenLostSessions.isWaitingSession("\u5f62\u8a18\u4e0b", { base: \'/test', fsImpl: { existsSync: (p) => p === "/test" }, readFileSync: (p) => "\u5f62\u8a18\u4e0b", readdirSync: (p) => [] } ))', '--input-type=module', '--no-warnings'], { encoding: 'utf8' }, __dirname).stdout;
// We'll use a simpler approach - just check the function directly by importing

// Test waiting session patterns
const testCases = [
  // Traditional waiting session
  { title: '待機中', expected: true },
  // PC-numbered auto titles
  { title: '018-resilient-steele', expected: true },
  { title: '011-morning-report', expected: true },
  // Remote-control prefixed auto titles
  { title: 'remote-control-xxx-yyy', expected: true },
  // Non-waiting sessions
  { title: 'My Session', expected: false },
  { title: 'some-other-session', expected: false },
];

console.log('Waiting session detection test results:');
testCases.forEach(test => {
  const result = reopenLostSessions.isWaitingSession(test.title, {
    base: '/test',
    fsImpl: fs,
    now: () => Date.now()
  });
  const status = result === test.expected ? '✓' : '✗';
  console.log(`  ${status} "${test.title}" -> expected: ${test.expected}, got: ${result}`);
});

// Test 2: Verify exclusion function
console.log('\nTesting exclusion function...');

const local = {
  id: 'test-session',
  cwd: 'C:\\test',
  hasConversation: true,
};

const closed = new Set();
const alive = new Set();
const hidden = new Set();

const result = reopenLostSessions.exclusion(local, closed, alive, hidden);
console.log(`Exclusion test: ${result === null ? '✓ (should be null)' : '✗ (should be null)'}`);

// Test 3: Check if countWindowsClaudeProcesses signature is correct
console.log('\nChecking countWindowsClaudeProcesses function signature...');

const windowsProcessModule = require('./tools/lib/windows-process.mjs');
const func = windowsProcessModule.countWindowsClaudeProcesses;

const funcString = func.toString();
const hasSessionsDirParam = funcString.includes('sessionsDir');
const hasIsWaitingSessionParam = funcString.includes('isWaitingSession');
const hasFsImplParam = funcString.includes('fsImpl');

console.log(`Function has sessionsDir parameter: ${hasSessionsDirParam ? '✓' : '✗'}`);
console.log(`Function has isWaitingSession parameter: ${hasIsWaitingSessionParam ? '✓' : '✗'}`);
console.log(`Function has fsImpl parameter: ${hasFsImplParam ? '✓' : '✗'}`);

console.log('\nVerification completed!');

// Summary
const allPassed = testCases.every(test => 
  reopenLostSessions.isWaitingSession(test.title, {
    base: '/test',
    fsImpl: fs,
    now: () => Date.now()
  }) === test.expected
);

if (allPassed && hasSessionsDirParam && hasIsWaitingSessionParam && hasFsImplParam) {
  console.log('\n✓ All basic verification tests passed!');
  process.exit(0);
} else {
  console.log('\n✗ Some verification tests failed!');
  process.exit(1);
}