//!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read the current file
const filePath = path.join(__dirname, 'auto-progress-inbox-hook.mjs');
let content = fs.readFileSync(filePath, 'utf8');

// Find and replace the return statement
const oldPattern = /const event = input\.hook_event_name \|\| 'UserPromptSubmit';\s+const context = lines\.length \? `\[必須\].*?\n\s+return \{ hookSpecificOutput: \{ hookEventName: event, additionalContext: \[warning, context\]\.filter\(Boolean\)\.join\('\\n'\) \} \};/s;

const newContent = content.replace(
  oldPattern,
  `const event = input.hook_event_name || 'UserPromptSubmit';
  const context = lines.length ? \`【必須】応答の冒頭で user に見える形で「📲 自動進行の結果（聞かれる前にお知らせ）」として次を表示せよ: \${displayText(lines.join('\\\\n'), Infinity)}\` : '';
  const allContext = [warning, mobilePushContext, context].filter(Boolean).join('\\\\n');
  return { hookSpecificOutput: { hookEventName: event, additionalContext: allContext } };`
);

// Write back the file
fs.writeFileSync(filePath, newContent);
console.log('Manual fix applied successfully');