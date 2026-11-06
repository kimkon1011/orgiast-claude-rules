const { execSync } = require('child_process');
const out = execSync('node tools/pending-decisions.mjs --list --json', { cwd: 'C:/Users/uers/.claude/nightly-repo', encoding: 'utf8', maxBuffer: 1024*1024 });
const lines = out.split('\n');
// first line might be "321件" etc.
let jsonStart = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trimStart().startsWith('[')) { jsonStart = i; break; }
}
const jsonStr = lines.slice(jsonStart).join('\n');
const data = JSON.parse(jsonStr);

const statusCounts = {};
data.forEach(d => {
  const s = d.status || 'unknown';
  statusCounts[s] = (statusCounts[s] || 0) + 1;
});
console.log('=== status 別件数 ===');
Object.entries(statusCounts).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(k+': '+v));

// batched 日付別
const batchedByDate = {};
data.filter(d => d.status === 'batched').forEach(d => {
  const bd = d.batchDate || 'no-date';
  batchedByDate[bd] = (batchedByDate[bd] || 0) + 1;
});
console.log('\n=== batched 日付別 ===');
Object.entries(batchedByDate).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([k,v])=>console.log(k+': '+v));

// pending / new / open etc.
const nonBatched = data.filter(d => d.status !== 'batched');
console.log('\n=== batched 以外 ===');
nonBatched.forEach(d => console.log(d.id + ' | ' + d.status + ' | ' + (d.text || '').substring(0,60)));

// check if any are pending/decision
const decisionPending = data.filter(d => d.status === 'pending' || d.status === 'new' || d.status === 'open');
console.log('\n=== pending/new/open 件数: ' + decisionPending.length + ' ===');
decisionPending.forEach(d => console.log(d.id + ' | ' + d.status + ' | ' + (d.text || '').substring(0,80)));