const fs = require('fs');
const cp = require('child_process');

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
} catch (e) {
  console.error('Error:', e);
}
