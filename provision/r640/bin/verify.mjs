#!/usr/bin/env node
import fs from 'node:fs';
import { atomic, readJson, run, compose, versions } from '../lib/core.mjs';
import { secrets } from '../lib/keyserve.mjs';

const rows = [];
function check(name, test) { try { rows.push([test() ? 'PASS' : 'FAIL', name]); } catch { rows.push(['FAIL', name]); } }
try {
  const site = readJson('/etc/orgiast-r640/site.json');
  const pins = versions();
  check('Ubuntu 24.04', () => /VERSION_ID="24.04"/.test(fs.readFileSync('/etc/os-release', 'utf8')));
  check('RAM within 5% of configured capacity', () => +/MemTotal:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1] / 1024**2 >= site.memoryGiB * .95);
  check('Intel I350/igb present; linked physical NIC', () => {
    const links = fs.readdirSync('/sys/class/net').filter(n => fs.existsSync(`/sys/class/net/${n}/device/driver`));
    return links.some(n => fs.realpathSync(`/sys/class/net/${n}/device/driver`).endsWith('/igb')) && links.some(n => fs.readFileSync(`/sys/class/net/${n}/carrier`, 'utf8').trim() === '1');
  });
  for (const unit of ['xrdp', 'xrdp-sesman', 'nginx', 'docker', 'fail2ban', 'orgiast-r640-backup.timer']) check(`service ${unit}`, () => run('systemctl', ['is-active', unit]).trim() === 'active');
  check('SSH key only', () => { const text = run('sshd', ['-T']); return /passwordauthentication no/.test(text) && /authenticationmethods publickey/.test(text) && /permitrootlogin no/.test(text); });
  check('ufw active', () => /Status: active/.test(run('ufw', ['status'])));
  check('Guacamole login HTTP', () => /^200$/.test(run('curl', ['--silent', '--output', '/dev/null', '--write-out', '%{http_code}', 'http://127.0.0.1:8080/guacamole/']).trim()));
  check('HTTPS hostname/certificate', () => run('curl', ['--silent', '--fail', '--cacert', '/etc/orgiast-r640/tls/server.crt', '--resolve', `${site.hostname}:443:127.0.0.1`, '-o', '/dev/null', `https://${site.hostname}/guacamole/`]) === '');
  check('Guacamole containers running', () => compose(['ps', '--status', 'running', '--services']).trim().split('\n').length === 3);
  check('JDBC default admin disabled', () => compose(['exec', '-T', '--user', 'postgres', 'db', 'psql', '-X', '-At', '-U', 'guacamole', '-d', 'guacamole', '-c', "SELECT disabled FROM guacamole_user JOIN guacamole_entity USING(entity_id) WHERE name='guacadmin';"]).trim() === 't');
  check('Node pinned', () => run('/usr/local/bin/node', ['--version']).trim() === `v${pins.NODE_VERSION}`);
  check('npm CLI pins', () => { const d = JSON.parse(run('/usr/local/bin/npm', ['ls', '--global', '--json', '--depth=0'])).dependencies; return d['@anthropic-ai/claude-code']?.version === pins.CLAUDE_VERSION && d['@openai/codex']?.version === pins.CODEX_VERSION && d['@google/gemini-cli']?.version === pins.GEMINI_VERSION; });
  check('Japanese locale and timezone', () => run('locale', ['-a']).includes('ja_JP.utf8') && run('timedatectl', ['show', '-p', 'Timezone', '--value']).trim() === 'Asia/Tokyo');
  check('xrdp reconnect policy and cap', () => { const text = fs.readFileSync('/etc/xrdp/sesman.ini', 'utf8'); return ['Policy=Default', 'KillDisconnected=false', 'DisconnectedTimeLimit=0', 'IdleTimeLimit=0', `MaxSessions=${site.maxSessions}`].every(line => text.split(/\r?\n/).includes(line)); });
  check('managed accounts have no sudo/docker group', () => Object.entries(readJson('/root/provision/accounts.json')).filter(([, v]) => !v.deleted).every(([u]) => !run('id', ['-nG', u]).trim().split(/\s+/).some(g => ['sudo', 'admin', 'docker'].includes(g))));
  if (site.storageMode === 'mdadm') {
    check('md RAID1 two active disks', () => { const text = run('mdadm', ['--detail', '--export', '/dev/md0']); return /MD_LEVEL=raid1/.test(text) && /MD_DEVICES=2/.test(text) && /\[UU\]/.test(fs.readFileSync('/proc/mdstat', 'utf8')); });
    check('both EFI filesystems mounted', () => { run('mountpoint', ['-q', '/boot/efi']); run('mountpoint', ['-q', '/boot/efi-secondary']); return true; });
  } else rows.push(['PENDING', 'hardware RAID1 health/readback via iDRAC']);
  check('restic repository reachable', () => { run('restic', ['--repo', site.backupRepository, '--password-file', '/run/orgiast-r640/restic-password', 'cat', 'config']); return true; });
  for (const item of [
    'iDRAC model/firmware/license, two SSD serials and SMART (実機待ち)',
    'RAID degraded boot from each SSD and replacement rebuild (実機待ち)',
    'Guacamole login -> connection -> desktop screenshot (未検証)',
    'disconnect/reconnect preserves window and same Xorg PID; duplicate browser and LAN RDP at 24bpp (未検証)',
    'resize, clipboard and Mozc Japanese typing (実機待ち)',
    `${site.maxSessions} concurrent desktops load/latency/OOM (実機待ち)`,
    'LAN/admin/other-subnet firewall reachability and HTTPS client trust (実機待ち)',
    'restore /home and Guacamole DB from off-host backup (実機待ち)',
  ]) rows.push(['PENDING', item]);
} catch { rows.push(['FAIL', 'host configuration/inventory inaccessible']); }
const counts = Object.fromEntries(['PASS', 'FAIL', 'PENDING'].map(s => [s, rows.filter(r => r[0] === s).length]));
const summary = `R640 verify: PASS=${counts.PASS} FAIL=${counts.FAIL} PENDING=${counts.PENDING}`;
atomic('/var/log/orgiast-provision/verify.txt', `${new Date().toISOString()}\n${summary}\nSTATUS | CHECK\n${rows.map(r => r.join(' | ')).join('\n')}\n`);
try {
  const data = await secrets();
  if (!data.notificationWebhook || new URL(data.notificationWebhook).protocol !== 'https:') throw new Error('notification route missing');
  const res = await fetch(data.notificationWebhook, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: summary }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('notification failed');
  console.log(`${summary}; notification=sent`);
} catch { fs.appendFileSync('/var/log/orgiast-provision/verify.txt', 'FAIL | verification notification; configure keyserve route\n'); console.log(`${summary}; notification=failed`); counts.FAIL++; }
process.exitCode = counts.FAIL ? 1 : counts.PENDING ? 2 : 0;
