// Extract fileContent and TESTED-LIVE info from original session
import fs from 'node:fs';

const path = 'C:/Users/kimko/.claude/projects/c--Users-kimko-OneDrive--------CLAUDE-md--/ab021efd-91e8-44d4-ac02-b1a204b74090.jsonl';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('fileContent') && l.includes('Checklist_getItems')) {
    console.log('=== Line ' + i + ' ===');
    try {
      const obj = JSON.parse(l);
      // extract from toolUseResult
      const toolResult = obj.toolUseResult || '';
      if (toolResult) {
        const parsed = JSON.parse(toolResult);
        console.log(JSON.stringify(parsed, null, 2).slice(0, 3000));
      } else {
        // try from MCP structured content
        const mcp = obj.mcpMeta?.structuredContent?.fileContent;
        if (mcp) {
          console.log(mcp.slice(0, 3000));
        } else {
          console.log('no recognized structure');
        }
      }
    } catch(e) {
      console.log('Parse error:', e.message);
      const idx = l.indexOf('fileContent');
      console.log(l.slice(idx, idx + 800));
    }
    console.log('');
  }
}

// Also find the original session's conclusion about C4
console.log('\n=== Looking for TESTED-LIVE summary ===');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('TESTED-LIVE')) {
    try {
      const obj = JSON.parse(l);
      if (obj.type === 'text' && obj.content) {
        console.log('Line ' + i + ': ' + obj.content.slice(0, 500));
      }
    } catch(e) {}
  }
}

// Check for the aftermath - did the session confirm 設営初日/設営二日目?
console.log('\n=== Looking for evidence of 設営初日/設営二日目 confirmation ===');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('設営初日') || l.includes('設営二日目')) {
    try {
      const obj = JSON.parse(l);
      if (obj.type === 'text' && obj.content) {
        const c = obj.content;
        if (c.includes('TESTED') || c.includes('確認') || c.includes('check') || c.includes('Checklist')) {
          console.log('Line ' + i + ': ' + c.slice(0, 500));
        }
      }
    } catch(e) {}
  }
}