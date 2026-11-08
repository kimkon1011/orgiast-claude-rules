// Sandbox-only test harness: preserve execFile callback semantics using file-backed stdio.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
cp.execFile = (file, args, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0011-test-'));
  const files = [path.join(dir, 'out'), path.join(dir, 'err')];
  const fds = files.map(f => fs.openSync(f, 'w'));
  const child = cp.spawn(file, args, {...options, stdio:['ignore', ...fds]});
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout || 30000);
  child.once('error', error => { clearTimeout(timer); callback(error, '', ''); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    const [stdout, stderr] = files.map(f => fs.readFileSync(f, 'utf8'));
    fds.forEach(fd => fs.closeSync(fd)); fs.rmSync(dir, {recursive:true, force:true});
    const error = code === 0 ? null : Object.assign(new Error('subprocess failed'), {code, signal, stdout, stderr});
    callback(error, stdout, stderr);
  });
  return child;
};
cp.execFile[promisify.custom] = (file, args, options = {}) => new Promise((resolve, reject) => cp.execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({stdout, stderr})));
syncBuiltinESMExports();
