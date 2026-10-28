import fs from 'fs';
import cp from 'child_process';

try {
  const html = cp.execFileSync('curl.exe', ['-sL', 'https://event-shop.jp/'], { encoding: 'utf8' });
  console.log('HTML length:', html.length);
  
  const m = html.match(/"buildId":"([^"]+)"/);
  console.log('buildId:', m ? m[1] : 'not found');
  
  const staticMatches = html.match(/\/_next\/static\/[^"]+\.js/g);
  console.log('static JS count:', staticMatches ? staticMatches.length : 0);
  if (staticMatches) {
    console.log('Sample static JS:', staticMatches.slice(0, 5));
  }

  // Also check session 5e1d2c93 for earlier chunks/buildId
  const file = 'C:/Users/kimko/.claude/projects/C--Users-kimko--claude-quota-sweep-repo/5e1d2c93-3fc3-4141-b4f8-0c3c8c61d873.jsonl';
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  for (const line of lines) {
    if (line.includes('0c430877') || line.includes('1df5bdff') || line.includes('chunks')) {
      const obj = JSON.parse(line);
      if (obj.message && obj.message.role === 'assistant') {
        for (const p of obj.message.content) {
          if (p.type === 'text' && p.text.includes('0c430877')) {
            console.log('--- Historical assistant text:');
            console.log(p.text);
          }
        }
      }
    }
  }
} catch (e) {
  console.error('Error:', e);
}
