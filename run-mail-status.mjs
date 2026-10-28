import cp from 'child_process';

const out = cp.execFileSync('node.exe', ['tools/fleet-mail.mjs', '--sent-status', 'mail-1793013144457-df34035a'], { encoding: 'utf8' });
console.log(out);
