import fs from 'fs';

const file = 'C:/Users/kimko/.claude/projects/C--Users-kimko--claude-quota-sweep-repo/5e1d2c93-3fc3-4141-b4f8-0c3c8c61d873.jsonl';
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('試行#1') || line.includes('0c430877') || line.includes('Age:')) {
    console.log(`Line ${i}:`, line.slice(0, 300));
  }
}
