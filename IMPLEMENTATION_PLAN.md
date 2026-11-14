# Implementation Plan: Remote Control Reconnection Fix

## Overview
This plan outlines the implementation of fixes for the Remote Control (RC) reconnection issues in the `reopen-lost-sessions.mjs` tool, based on the detailed implementation instructions provided.

## Issues to Fix

### 1. Fix the load guard's counting logic
**Problem**: The `getLoadGuardStatus` function counts all Claude processes via `countWindowsClaudeProcesses`, but should exclude:
- Waiting sessions (empty transcript)
- Claude Desktop app (main Electron app process and child processes)

**Solution**: 
- Update `countWindowsClaudeProcesses` to accept `sessionsDir` and `isWaitingSession` parameters
- Add filtering logic to exclude waiting sessions and Claude Desktop app from the count
- Update `getLoadGuardStatus` to pass these parameters
- Add `getSessionIdFromPid` helper function to map PIDs to session IDs

### 2. Fix the waiting session name detection regex
**Problem**: The current regex `/^(\d{3}｜)?待機中$/` is too narrow and doesn't match actual waiting session names like `018-resilient-steele`.

**Solution**:
- Update `isWaitingSession` function to use more comprehensive regex patterns:
  - Traditional waiting: `/^待機中$/`
  - PC-numbered auto titles: `/^\d{3}-[a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+$/`
  - Remote-control prefixed: `/^remote-control-[a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+$/`
- Update `exclusion` function to use `isWaitingSession` for proper session filtering

### 3. Handle "Missing RC credentials" error cause
**Problem**: The error occurs during specific time period (2026-11-13T20:45Z〜2026-11-14T02:15Z) and causes silent failures.

**Solution**:
- Identify root cause by examining credential handling code
- Add proper error handling and logging
- Implement fallback mechanisms when credentials fail
- Add notification to kim-inbox for persistent credential errors
- Add alternative path (agents registry fallback)

### 4. Add tests for pure functions and ensure existing tests pass
**Problem**: Some existing tests are failing due to the changes made.

**Solution**:
- Fix the `countWindowsClaudeProcesses` function to work with ES modules
- Remove CommonJS `require('node:fs')` usage
- Ensure function signatures are compatible with tests
- Update tests to work with new function signatures

### 5. Run the tool to verify it works
**Steps**:
- Create test scenarios for different load conditions
- Verify the tool behaves correctly with waiting sessions
- Test credential error handling
- Validate that the load guard properly filters sessions

### 6. Create a commit and PR
**Steps**:
- Stage all modified files
- Create meaningful commit message describing the fixes
- Push to branch and create PR
- Include test results and verification details

## Files to Modify

1. `tools/lib/windows-process.mjs`:
   - `countWindowsClaudeProcesses` function
   - `getSessionIdFromPid` function

2. `tools/reopen-lost-sessions.mjs`:
   - `isWaitingSession` function (new)
   - `exclusion` function (updated to use isWaitingSession)
   - `getLoadGuardStatus` function
   - `reopenLost` function (updated to pass new parameters)
   - `watchReopen` function

3. `tools/reopen-lost-sessions.test.mjs`:
   - Update or fix failing tests

## Testing Strategy

1. **Unit Tests**: Test pure functions in isolation
2. **Integration Tests**: Test the whole flow
3. **Edge Cases**: Test various scenarios (high CPU, high claudeCount, credential errors)
4. **Load Guard Tests**: Specifically test the load guard behavior

## Verification Criteria

1. Load guard correctly excludes waiting sessions from count
2. Waiting session detection matches all auto-title patterns
3. "Missing RC credentials" errors are properly handled and logged
4. All existing tests pass (112 pass, 6 fail → target 118 pass)
5. Tool behaves correctly under various load conditions

## Priority

1. Fix test failures (ensure all 118 tests pass)
2. Fix load guard counting logic
3. Fix waiting session detection
4. Add credential error handling
5. Full integration testing

## Timeline

- **Phase 1 (Days 1-2)**: Fix test failures and load guard logic
- **Phase 2 (Days 3-4)**: Implement waiting session detection
- **Phase 3 (Day 5)**: Add credential error handling
- **Phase 4 (Day 6)**: Integration testing and verification
- **Day 7**: Final review and PR creation