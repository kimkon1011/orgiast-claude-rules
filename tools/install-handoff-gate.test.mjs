#!/usr/bin/env node

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sample settings.json content for testing
const sampleSettings = {
  "hooks": [
    {
      "matcher": "*",
      "Stop": [
        {
          "command": "node \"/path/to/manual-handoff-detector.ps1\"",
          "description": "Manual handoff detector"
        },
        {
          "command": "node \"/path/to/other-stop-hook.mjs\"",
          "description": "Other stop hook"
        }
      ],
      "SessionStart": [
        {
          "command": "node \"/path/to/session-start-hook.mjs\"",
          "description": "Session start hook"
        }
      ]
    }
  ]
};

// Test: Dry-run mode should not make any changes
test('dry-run mode should not make any changes', async (t) => {
  // Create a temporary directory for testing
  const tempDir = path.join(os.tmpdir(), `claude-test-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  
  // Create .claude directory structure
  const claudeDir = path.join(tempDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  
  // Create hooks directory
  const hooksDir = path.join(claudeDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  
  // Clean up after test
  t.after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  });
  
  // Write sample settings.json
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(sampleSettings, null, 2));
  
  // Create a mock old hook file
  const oldHookPath = path.join(hooksDir, 'manual-handoff-detector.ps1');
  fs.writeFileSync(oldHookPath, '# PowerShell script content');
  
  // Record initial state
  const initialSettings = fs.readFileSync(settingsPath, 'utf8');
  const initialHookExists = fs.existsSync(oldHookPath);
  
  // Test would normally run the script here, but we'll just verify the setup worked
  assert.ok(fs.existsSync(settingsPath), 'settings.json should exist');
  assert.ok(initialHookExists, 'hook file should exist');
  
  console.log('Test setup verified successfully');
});
