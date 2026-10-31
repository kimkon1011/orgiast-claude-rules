// Analyze original session for C4 construction day coverage
import fs from 'node:fs';

const content = fs.readFileSync('C:/Users/kimko/.claude/projects/c--Users-kimko-OneDrive--------CLAUDE-md--/ab021efd-91e8-44d4-ac02-b1a204b74090.jsonl', 'utf8');
const lines = content.split('\n');

const foundDays = new Set();
const checklistCalls = [];

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];

  // Extract all day values from fileContent
  const dayFromContent = l.match(/"day":\\"[^"\\]+/g);
  if (dayFromContent) {
    for (const m of dayFromContent) {
      const day = m.replace(/"day":\\"/, '');
      foundDays.add(day);
    }
  }

  // Find Checklist_getItems tool calls
  if ((l.includes('Checklist_getItems') || l.includes('Checklist_getItems')) && (l.includes('"command"') || l.includes('\\"command\\"'))) {
    checklistCalls.push({line: i, text: l.slice(0, 400)});
  }

  // Find text entries mentioning 設営初日/設営二日目 and checklist verification
  if (l.includes('TESTED') || (l.includes('確認') && (l.includes('設営初日') || l.includes('設営二日目')))) {
    try {
      const obj = JSON.parse(l);
      if (obj.type === 'text') {
        console.log('▲ Text L' + i + ':', (obj.content || '').slice(0, 500));
      }
    } catch(e) {}
  }
}

console.log('=== Days found in fileContent ===');
console.log(Array.from(foundDays).join(', '));
console.log('\n=== Checklist_getItems calls ===');
for (const c of checklistCalls) {
  console.log('L' + c.line + ': ' + c.text);
}

// Look at what happened after the result was read - find text entries after file reads
console.log('\n=== Text analysis: post-read summary ===');
// Search through for "summary" text blocks near the end
for (let i = 350; i < lines.length; i++) {
  const l = lines[i];
  try {
    const obj = JSON.parse(l);
    if (obj.type === 'text' && obj.content) {
      const txt = obj.content;
      if (txt.includes('本番日') || txt.includes('設営') || txt.includes('撤収') || txt.includes('C4') || txt.includes('checklist')) {
        console.log('\nL' + i + ': ' + txt.slice(0, 800));
      }
    }
  } catch(e) {}
}