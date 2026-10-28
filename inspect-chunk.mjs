import cp from 'child_process';

const chunkUrl = 'https://event-shop.jp/_next/static/immutable/chunks/3douyljdx_-l2.js';
try {
  const content = cp.execFileSync('curl.exe', ['-sL', chunkUrl], { encoding: 'utf8' });
  console.log('Chunk length:', content.length);
  const nextMatch = content.match(/16\.[0-9]+\.[0-9]+/g);
  console.log('Next versions found in chunk:', nextMatch);
  // Also search for Next.js in general
  const allMatches = content.match(/next[^\s"']{0,30}/gi);
  if (allMatches) {
    console.log('Next mentions:', [...new Set(allMatches)].slice(0, 10));
  }
} catch (e) {
  console.error(e);
}
