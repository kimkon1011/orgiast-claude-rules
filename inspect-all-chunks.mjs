import cp from 'child_process';

const html = cp.execFileSync('curl.exe', ['-sL', 'https://event-shop.jp/'], { encoding: 'utf8' });
const staticMatches = html.match(/\/_next\/static\/[^"]+\.js/g) || [];
console.log('Total static files:', staticMatches.length);

for (const path of staticMatches) {
  const url = `https://event-shop.jp${path}`;
  try {
    const js = cp.execFileSync('curl.exe', ['-sL', url], { encoding: 'utf8' });
    const versions = js.match(/16\.[0-9]+\.[0-9]+/g);
    if (versions) {
      console.log(`Found in ${path}:`, versions);
    }
    const nextObj = js.match(/"nextVersion":"([^"]+)"/);
    if (nextObj) {
      console.log(`nextVersion in ${path}:`, nextObj[1]);
    }
  } catch (e) {
    console.error(e.message);
  }
}
