#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { readCodexFallbackOrder } from './tools/codex-do.mjs';

// Test to verify the new lane priority
const home = process.env.ORGIAST_HOME || process.env.HOME || '/tmp/test';

console.log('Testing lane priority changes...');

// Read the actual fallback order from the file if it exists
const codexFallbackOrderFile = path.join(home, '.claude', 'codex-fallback-order.json');

let order = [];
try {
  const content = fs.readFileSync(codexFallbackOrderFile, 'utf8');
  order = JSON.parse(content);
  console.log('Current fallback order in codex-fallback-order.json:', order);
} catch (error) {
  console.log('No codex-fallback-order.json file found, using default logic');
}

// Test the readCodexFallbackOrder function
const result = readCodexFallbackOrder(home);
console.log('readCodexFallbackOrder result:', result);

if (result) {
  console.log('✓ Fallback order from file:', result);
  
  // Verify the order matches HANDOVER.md requirements
  if (result.length >= 2 && result[0] === 'cheap-code:deepseek' && result[1] === 'gemini-cli') {
    console.log('✓ Lane priority matches HANDOVER.md requirements (cheap-code:deepseek → gemini-cli)');
  } else {
    console.log('✗ Lane priority does not match HANDOVER.md requirements');
  }
} else {
  console.log('✗ No valid fallback order found');
}

console.log('\nTest completed.');