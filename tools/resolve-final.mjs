import fs from 'node:fs';

let src = fs.readFileSync('tools/auto-progress-digest.mjs', 'utf8');

// Strategy: remove the <<<<<<< and >>>>>>> marker lines, and also ===== lines
// The content between them is already the merged version

const lines = src.split('\n');
const result = [];
for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trim();
  if (trimmed === '<<<<<<< HEAD' || trimmed === '=======' || trimmed.startsWith('>>>>>>> origin')) {
    // Skip marker lines, content stays
    continue;
  }
  result.push(lines[i]);
}

fs.writeFileSync('tools/auto-progress-digest.mjs', result.join('\n'), 'utf8');
console.log('Done - removed all conflict markers');

// Verify syntax
const { execSync } = await import('node:child_process');
try { execSync('node --check tools/auto-progress-digest.mjs', { stdio: 'pipe' }); console.log('Syntax OK'); }
catch (e) { console.log('Syntax error:', e.stderr?.toString() || e.message); }