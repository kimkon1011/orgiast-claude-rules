import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const token = 'ORG1.test-only.signature';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));

function run(file, home, url, preload, extra = {}) {
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_KEYSERVE_URL: url,
    ORGIAST_KEYSERVE_SECRET: '', ORGIAST_KEYSERVE_PC: '', ...extra };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, path.join(toolsDir, file),
      ...(file === 'onboarding-sync.mjs' ? ['--keys-only', '--force'] : ['--json'])], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', s => { stdout += s; });
    child.stderr.on('data', s => { stderr += s; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('enroll recovery and compatibility work through real CLI requests on Japanese hostname', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-recovery-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const preload = path.join(base, 'hostname.mjs');
  fs.writeFileSync(preload, "import os from 'node:os'; os.hostname = () => '作業用011';\n");
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ files: { 'keyserve.env': 'ORGIAST_KEYSERVE_SECRET=new-primary\n' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/keys`;
  for (const mode of ['enroll-file', 'legacy-env', 'legacy-file', 'primary']) {
    await t.test(mode, async () => {
      const home = path.join(base, mode), dir = path.join(home, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'enroll.env'), `${mode.startsWith('legacy') ? '' : `ORGIAST_ENROLL_TOKEN=${token}\n`}ORGIAST_KEYSERVE_PC=cr-PC\n`);
      if (mode === 'primary') fs.writeFileSync(path.join(dir, 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET=old-primary\nORGIAST_KEYSERVE_PC=cr-PC\n');
      if (mode === 'legacy-file') fs.writeFileSync(path.join(dir, 'keyserve.env'), `ORGIAST_KEYSERVE_SECRET=${token}\n`);
      const extra = mode === 'legacy-env' ? { ORGIAST_KEYSERVE_SECRET: token } : {};
      const before = requests.length;
      const result = await run('onboarding-sync.mjs', home, url, preload, extra);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1)['x-orgiast-pc'], 'cr-PC');
      assert.equal(requests.at(-1)['x-orgiast-enroll'], mode === 'primary' ? undefined : token);
      if (mode.startsWith('legacy')) assert.match(result.stderr, /enroll トークンは enroll.env の ORGIAST_ENROLL_TOKEN/);
      else assert.doesNotMatch(result.stderr, /今回は enroll 経路/);
      assert.ok(!result.stderr.includes(token));
      assert.equal(fs.existsSync(path.join(dir, 'enroll.env')), false);
      if (mode === 'legacy-file') assert.equal(fs.existsSync(path.join(dir, 'keyserve-prev.env')), false);
      const status = await run('keyserve-status.mjs', home, url, preload, extra);
      assert.equal(JSON.parse(status.stdout).auth, 'primary');
      assert.equal(JSON.parse(status.stdout).status, 200);
      assert.equal(requests.at(-1)['x-orgiast-pc'], 'cr-PC');
      assert.equal(requests.at(-1)['x-orgiast-enroll'], undefined);
    });
  }
  await t.test('unresolved identity reports explicit error without HTTP', async () => {
    const home = path.join(base, 'unknown'), dir = path.join(home, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'enroll.env'), `ORGIAST_ENROLL_TOKEN=${token}\n`);
    const before = requests.length;
    const result = await run('onboarding-sync.mjs', home, url, preload);
    assert.match(result.stderr, /PC名を決められない/);
    assert.equal(requests.length, before);
    assert.equal(fs.existsSync(path.join(dir, 'enroll.env')), true);
    fs.writeFileSync(path.join(dir, 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET=primary\n');
    const status = await run('keyserve-status.mjs', home, url, preload);
    assert.match(JSON.parse(status.stdout).error, /PC名を決められない/);
    assert.equal(requests.length, before);
  });
});
