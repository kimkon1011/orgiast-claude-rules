import cp from 'child_process';

try {
  const out = cp.execFileSync('node.exe', ['--test', 'tools/fleet-mail.test.mjs'], { encoding: 'utf8' });
  console.log('fleet-mail test pass:\n', out);
} catch (e) {
  console.error('fleet-mail test failed:', e.stdout || e.message);
}
