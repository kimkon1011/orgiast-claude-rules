const fs = require('fs');
const path = require('path');
const home = process.env.ORGIAST_HOME || process.env.HOME || require('os')?.homedir?.() || require('os')?.userInfo?.()?.dir || 'C:/Users/uers';
const file = path.join(home, '.claude', 'pending-decisions.jsonl');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const records = lines.map(l => JSON.parse(l));

const from1009 = records.filter(r => r.capturedAt && r.capturedAt.startsWith('2026-10-09'));
console.log('=== 10/09 登録 ===');
console.log('件数:', from1009.length);
from1009.forEach(r => console.log(r.id, r.status, r.batchDate||'-', (r.text||'').slice(0,80)));

// Also check ID pattern
const oct9ids = records.filter(r => r.id && r.id.startsWith('20261009'));
console.log('\n=== ID 20261009* ===');
oct9ids.forEach(r => console.log(r.id, r.status, r.batchDate||'-', (r.text||'').slice(0,80)));