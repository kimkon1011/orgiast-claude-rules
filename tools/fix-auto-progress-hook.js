//!/usr/bin/env node
import fs from 'fs';

const filePath = 'C:\\Users\\kimko\\.claude\\nightly-repo\\tools\\auto-progress-inbox-hook.mjs';
const content = fs.readFileSync(filePath, 'utf8');

// Fix the return statement
const fixedContent = content.replace(
  /return \{ hookSpecificOutput: \{ hookEventName: event, additionalContext: \[warning, context\].filter\(Boolean\)\.join\('\\n'\) \} \};/,
  'const allContext = [warning, mobilePushContext, context].filter(Boolean).join(\'\\n\'); return { hookSpecificOutput: { hookEventName: event, additionalContext: allContext } };'
);

fs.writeFileSync(filePath, fixedContent);
console.log('Fixed auto-progress-inbox-hook.mjs');