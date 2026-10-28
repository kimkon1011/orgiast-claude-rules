import fs from 'fs';

const file = 'C:/Users/kimko/.claude/projects/C--Users-kimko--claude-quota-sweep-repo/5e1d2c93-3fc3-4141-b4f8-0c3c8c61d873.jsonl';
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
console.log('=== Line 40 content:');
const obj40 = JSON.parse(lines[40]);
console.log(obj40.message.content[0].content);

console.log('=== Line 55 content:');
const obj55 = JSON.parse(lines[55]);
console.log(obj55.message.content[0].content);
