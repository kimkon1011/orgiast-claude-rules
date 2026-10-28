import cp from 'child_process';

const url = 'https://event-shop.jp/_next/static/immutable/chunks/0aj6ghfe1g-m8.js';
const js = cp.execFileSync('curl.exe', ['-sL', url], { encoding: 'utf8' });
const idx = js.indexOf('16.4.1');
console.log('Snippet around 16.4.1:');
console.log(js.slice(Math.max(0, idx - 100), Math.min(js.length, idx + 100)));
