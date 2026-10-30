#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, run, atomic, readJson, validateSite, versions, compose, sql, isMain } from '../lib/core.mjs';
import { secrets } from '../lib/keyserve.mjs';

const installed = '/opt/orgiast-r640';
const configFile = '/etc/orgiast-r640/site.json';
async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('public package download failed');
  atomic(destination, Buffer.from(await response.arrayBuffer()));
}
function ini(file, section, values) {
  let text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`(\\[${section}\\][^\\n]*\\n)([\\s\\S]*?)(?=\\n\\[|$)`);
  if (!re.test(text)) throw new Error('missing INI section');
  text = text.replace(re, (_, header, body) => {
    for (const [k, v] of Object.entries(values)) {
      const line = new RegExp(`^${k}=.*$`, 'm');
      body = line.test(body) ? body.replace(line, `${k}=${v}`) : `${body.trimEnd()}\n${k}=${v}\n`;
    }
    return header + body;
  });
  atomic(file, text, 0o644);
}
export async function configure(step, site) {
  const pins = versions();
  if (step === 'preflight') {
    validateSite(site);
    if (run('uname', ['-m']).trim() !== 'x86_64') throw new Error('amd64 required');
    if (run('findmnt', ['-n', '-o', 'FSTYPE', '/run']).trim() !== 'tmpfs') throw new Error('/run must be tmpfs');
    // Passwords exist only in process memory; prohibit disk-backed swap during provisioning.
    if (run('swapon', ['--show', '--noheadings', '--raw', '--output', 'NAME']).split('\n').some(x => x && !x.startsWith('/dev/zram'))) throw new Error('disable disk swap before handling passwords');
    for (const name of ['bin', 'lib', 'compose.yaml', 'versions.env']) {
      const src = path.join(ROOT, name), dst = path.join(installed, name);
      if (path.resolve(src) !== path.resolve(dst)) { fs.mkdirSync(installed, { recursive: true }); fs.cpSync(src, dst, { recursive: true }); }
    }
    atomic(configFile, JSON.stringify(site));
    run('chmod', ['-R', 'go-w', installed]);
  } else if (step === 'packages') {
    process.env.DEBIAN_FRONTEND = 'noninteractive';
    run('apt-get', ['update', '-qq']);
    run('apt-get', ['install', '-y', '--no-install-recommends', 'ca-certificates', 'curl', 'gnupg', 'openssl', 'age', 'git', 'xz-utils', 'python3-yaml', 'locales', 'xfce4', 'xfce4-terminal', 'dbus-x11', 'xrdp', 'xorgxrdp', 'fcitx5', 'fcitx5-mozc', 'fcitx5-frontend-gtk3', 'fcitx5-frontend-qt5', 'im-config', 'fonts-noto-cjk', 'language-pack-ja', 'ufw', 'unattended-upgrades', 'fail2ban', 'nginx', 'docker.io', 'restic', 'rsync', 'mdadm', 'smartmontools', 'pciutils', 'zram-tools']);
    run('systemctl', ['enable', '--now', 'docker']);
    fs.mkdirSync('/usr/local/lib/docker/cli-plugins', { recursive: true });
    const composeUrl = `https://github.com/docker/compose/releases/download/v${pins.COMPOSE_VERSION}/docker-compose-linux-x86_64`;
    const binary = '/run/orgiast-provision/docker-compose';
    await download(composeUrl, binary);
    const checksum = await fetch(`${composeUrl}.sha256`, { signal: AbortSignal.timeout(30000) });
    if (!checksum.ok || (await checksum.text()).trim().split(/\s+/)[0] !== createHash('sha256').update(fs.readFileSync(binary)).digest('hex')) throw new Error('compose checksum mismatch');
    atomic('/usr/local/lib/docker/cli-plugins/docker-compose', fs.readFileSync(binary), 0o755);
    fs.rmSync(binary);
  } else if (step === 'desktop') {
    run('locale-gen', ['ja_JP.UTF-8']);
    run('update-locale', ['LANG=ja_JP.UTF-8']);
    run('timedatectl', ['set-timezone', 'Asia/Tokyo']);
    if (!run('getent', ['group']).split('\n').some(l => l.startsWith('orgiast-r640:'))) run('groupadd', ['orgiast-r640']);
    atomic('/etc/profile.d/orgiast-ime.sh', 'export GTK_IM_MODULE=fcitx\nexport QT_IM_MODULE=fcitx\nexport XMODIFIERS=@im=fcitx\n', 0o644);
    atomic('/etc/xdg/fcitx5/profile', '[Groups/0]\nName=Default\nDefault Layout=jp\nDefaultIM=mozc\n\n[Groups/0/Items/0]\nName=keyboard-jp\nLayout=\n\n[Groups/0/Items/1]\nName=mozc\nLayout=\n\n[GroupOrder]\n0=Default\n', 0o644);
    atomic('/etc/xdg/fcitx5/config', '[Behavior]\nActiveByDefault=True\n', 0o644);
    atomic('/etc/xdg/autostart/orgiast-fcitx5.desktop', '[Desktop Entry]\nType=Application\nName=Japanese input\nExec=fcitx5 -d\nOnlyShowIn=XFCE;\n', 0o644);
    atomic('/etc/xrdp/startwm.sh', '#!/bin/sh\nexport LANG=ja_JP.UTF-8\nexport GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx XMODIFIERS=@im=fcitx\nunset DBUS_SESSION_BUS_ADDRESS SESSION_MANAGER\nexec dbus-run-session -- startxfce4\n', 0o755);
    ini('/etc/xrdp/sesman.ini', 'Sessions', { Policy: 'Default', KillDisconnected: 'false', DisconnectedTimeLimit: 0, IdleTimeLimit: 0, MaxSessions: site.maxSessions });
    ini('/etc/xrdp/sesman.ini', 'Security', { AllowRootLogin: 'false', TerminalServerUsers: 'orgiast-r640', AlwaysGroupCheck: 'true' });
    ini('/etc/xrdp/sesman.ini', 'Globals', { EnableUserWindowManager: 'false' });
    ini('/etc/xrdp/xrdp.ini', 'Globals', { max_bpp: 24, security_layer: 'tls', crypt_level: 'high', autorun: 'Xorg' });
    run('usermod', ['-aG', 'ssl-cert', 'xrdp']);
    atomic('/etc/default/zramswap', 'ALGO=zstd\nPERCENT=25\nPRIORITY=100\n', 0o644);
    atomic('/etc/systemd/logind.conf.d/orgiast-r640.conf', '[Login]\nKillUserProcesses=no\n', 0o644);
    atomic('/etc/systemd/system/user-.slice.d/orgiast-r640.conf', '[Slice]\nMemoryHigh=5G\nMemoryMax=6G\nTasksMax=4096\n', 0o644);
    atomic('/etc/opt/chrome/policies/managed/orgiast.json', JSON.stringify({ HighEfficiencyModeEnabled: true, BackgroundModeEnabled: false, RestoreOnStartup: 1 }), 0o644);
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', '--now', 'xrdp', 'zramswap']);
    // Do not restart sesman on every reconcile; established desktops must survive.
    // Changed settings on an already-running host take effect at a planned reboot.
  } else if (step === 'apps') {
    await download('https://dl.google.com/linux/linux_signing_key.pub', '/run/orgiast-provision/google.asc');
    await download('https://packages.microsoft.com/keys/microsoft.asc', '/run/orgiast-provision/microsoft.asc');
    for (const name of ['google', 'microsoft']) run('gpg', ['--batch', '--yes', '--dearmor', '--output', `/usr/share/keyrings/orgiast-${name}.gpg`, `/run/orgiast-provision/${name}.asc`]);
    for (const name of ['google', 'microsoft']) fs.chmodSync(`/usr/share/keyrings/orgiast-${name}.gpg`, 0o644);
    atomic('/etc/apt/sources.list.d/orgiast-chrome.list', 'deb [arch=amd64 signed-by=/usr/share/keyrings/orgiast-google.gpg] https://dl.google.com/linux/chrome/deb/ stable main\n', 0o644);
    atomic('/etc/apt/sources.list.d/orgiast-code.list', 'deb [arch=amd64 signed-by=/usr/share/keyrings/orgiast-microsoft.gpg] https://packages.microsoft.com/repos/code stable main\n', 0o644);
    run('apt-get', ['update', '-qq']);
    run('apt-get', ['install', '-y', 'google-chrome-stable', 'code']);
    const tar = `node-v${pins.NODE_VERSION}-linux-x64.tar.xz`, base = `https://nodejs.org/dist/v${pins.NODE_VERSION}/`;
    await download(base + tar, `/run/orgiast-provision/${tar}`);
    const res = await fetch(`${base}SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('node checksums unavailable');
    const expected = (await res.text()).split('\n').find(l => l.endsWith(`  ${tar}`))?.split(' ')[0];
    if (!expected || createHash('sha256').update(fs.readFileSync(`/run/orgiast-provision/${tar}`)).digest('hex') !== expected) throw new Error('node checksum mismatch');
    run('tar', ['-xJf', `/run/orgiast-provision/${tar}`, '--directory', '/usr/local', '--strip-components=1']);
    fs.rmSync(`/run/orgiast-provision/${tar}`);
    run('/usr/local/bin/npm', ['install', '--global', '--no-audit', '--no-fund', `@anthropic-ai/claude-code@${pins.CLAUDE_VERSION}`, `@openai/codex@${pins.CODEX_VERSION}`, `@google/gemini-cli@${pins.GEMINI_VERSION}`]);
  } else if (step === 'credentials') {
    const data = await secrets();
    for (const field of ['databasePassword', 'resticPassword']) if (typeof data[field] !== 'string' || data[field].length < 24 || /[\r\n]/.test(data[field])) throw new Error('keyserve secret missing or invalid');
    const fingerprint = createHash('sha256').update(data.databasePassword).digest('hex');
    const previous = readJson('/root/provision/db-fingerprint.json', null);
    if (previous && previous !== fingerprint) throw new Error('DB secret changed: rotate DB password before restarting');
    fs.mkdirSync('/run/orgiast-r640', { recursive: true, mode: 0o700 });
    atomic('/run/orgiast-r640/db-password', data.databasePassword, 0o444);
    atomic('/run/orgiast-r640/restic-password', data.resticPassword);
    atomic('/root/provision/db-fingerprint.json', JSON.stringify(fingerprint));
  } else if (step === 'guacamole') {
    compose(['up', '-d', '--wait', 'db']);
    const present = compose(['exec', '-T', '--user', 'postgres', 'db', 'psql', '-X', '-At', '-U', 'guacamole', '-d', 'guacamole', '-c', "SELECT to_regclass('public.guacamole_user') IS NOT NULL;"]).trim();
    if (present === 'f') {
      const schema = compose(['run', '--rm', '--no-deps', 'web', '/opt/guacamole/bin/initdb.sh', '--postgresql']);
      sql(`BEGIN;\n${schema}\nCOMMIT;`);
    } else if (present !== 't') throw new Error('cannot determine schema status');
    sql("UPDATE guacamole_user SET disabled=true WHERE entity_id IN (SELECT entity_id FROM guacamole_entity WHERE name='guacadmin' AND type='USER');");
    compose(['up', '-d']);
    const cert = '/etc/orgiast-r640/tls'; fs.mkdirSync(cert, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(`${cert}/server.crt`)) run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365', '-keyout', `${cert}/server.key`, '-out', `${cert}/server.crt`, '-subj', `/CN=${site.hostname}`, '-addext', `subjectAltName=DNS:${site.hostname}`]);
    atomic('/etc/nginx/sites-available/orgiast-r640', `server {\n listen 443 ssl;\n server_name ${site.hostname};\n ssl_certificate ${cert}/server.crt;\n ssl_certificate_key ${cert}/server.key;\n ssl_protocols TLSv1.2 TLSv1.3;\n location = / { return 302 /guacamole/; }\n location /guacamole/ {\n  proxy_pass http://127.0.0.1:8080/guacamole/;\n  proxy_http_version 1.1;\n  proxy_set_header Upgrade $http_upgrade;\n  proxy_set_header Connection \\"upgrade\\";\n  proxy_set_header Host $host;\n  proxy_set_header X-Forwarded-Proto https;\n  proxy_set_header X-Forwarded-For $remote_addr;\n  proxy_buffering off;\n  proxy_read_timeout 3600s;\n }\n}\n`.replaceAll('\\"', '"'), 0o644);
    fs.rmSync('/etc/nginx/sites-enabled/default', { force: true });
    if (!fs.existsSync('/etc/nginx/sites-enabled/orgiast-r640')) fs.symlinkSync('/etc/nginx/sites-available/orgiast-r640', '/etc/nginx/sites-enabled/orgiast-r640');
    run('nginx', ['-t']); run('systemctl', ['enable', '--now', 'nginx']); run('systemctl', ['reload', 'nginx']);
  } else if (step === 'security') {
    if (!run('getent', ['passwd']).split('\n').some(l => l.startsWith('r640admin:'))) run('useradd', ['-m', '-s', '/bin/bash', '-G', 'sudo', 'r640admin']);
    atomic('/home/r640admin/.ssh/authorized_keys', site.adminSshKey + '\n'); run('chown', ['-R', 'r640admin:r640admin', '/home/r640admin/.ssh']);
    atomic('/etc/sudoers.d/orgiast-r640-admin', 'r640admin ALL=(ALL) NOPASSWD: ALL\n', 0o440);
    run('visudo', ['-cf', '/etc/sudoers.d/orgiast-r640-admin']);
    atomic('/etc/ssh/sshd_config.d/00-orgiast-r640.conf', 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nPubkeyAuthentication yes\nAuthenticationMethods publickey\nAllowUsers r640admin\n', 0o644);
    run('sshd', ['-t']);
    atomic('/etc/apt/apt.conf.d/20auto-upgrades', 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n', 0o644);
    atomic('/etc/fail2ban/jail.d/orgiast.conf', '[sshd]\nenabled=true\nbackend=systemd\nmaxretry=5\nbantime=1h\n', 0o644);
    // Dedicated appliance: reconcile full ruleset to avoid pre-existing broad allow rules.
    run('ufw', ['--force', 'reset']);
    run('ufw', ['default', 'deny', 'incoming']); run('ufw', ['default', 'allow', 'outgoing']);
    for (const [cidr, port] of [[site.managementCidr, '22'], [site.lanCidr, '443'], [site.lanCidr, '3389'], ['172.30.64.0/24', '3389']]) run('ufw', ['allow', 'from', cidr, 'to', 'any', 'port', port, 'proto', 'tcp']);
    run('ufw', ['--force', 'enable']);
    run('systemctl', ['reload', 'ssh']); run('systemctl', ['enable', '--now', 'fail2ban', 'unattended-upgrades']);
  } else if (step === 'operations') {
    const unit = (name, body) => atomic(`/etc/systemd/system/${name}`, body, 0o644);
    unit('orgiast-r640-stack.service', `[Unit]\nDescription=R640 Guacamole stack\nAfter=network-online.target docker.service\nWants=network-online.target\nRequires=docker.service\n[Service]\nType=oneshot\nRemainAfterExit=yes\nUMask=0077\nLimitCORE=0\nExecStartPre=/usr/local/bin/node ${installed}/bin/configure.mjs credentials ${configFile}\nExecStart=/usr/local/bin/node ${installed}/bin/configure.mjs start-stack ${configFile}\nExecStop=/usr/local/bin/node ${installed}/bin/configure.mjs stop-stack ${configFile}\n[Install]\nWantedBy=multi-user.target\n`);
    unit('orgiast-r640-verify.service', `[Unit]\nDescription=R640 first boot verification\nAfter=orgiast-r640-stack.service xrdp.service nginx.service\nWants=orgiast-r640-stack.service\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/bin/bash ${installed}/bin/verify-on-host.sh\n[Install]\nWantedBy=multi-user.target\n`);
    unit('orgiast-r640-backup.service', `[Unit]\nDescription=Encrypted R640 backup\nAfter=network-online.target orgiast-r640-stack.service\n[Service]\nType=oneshot\nUMask=0077\nLimitCORE=0\nExecStartPre=/usr/local/bin/node ${installed}/bin/configure.mjs credentials ${configFile}\nExecStart=/bin/bash ${installed}/bin/backup.sh\n`);
    unit('orgiast-r640-backup.timer', '[Unit]\nDescription=Nightly R640 backup\n[Timer]\nOnCalendar=*-*-* 02:30:00 Asia/Tokyo\nRandomizedDelaySec=600\nPersistent=true\n[Install]\nWantedBy=timers.target\n');
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', 'orgiast-r640-verify.service', 'orgiast-r640-stack.service']);
    run('systemctl', ['enable', '--now', 'orgiast-r640-backup.timer']);
  } else if (step === 'start-stack') compose(['up', '-d']);
  else if (step === 'stop-stack') compose(['stop']);
  else if (step === 'revoke') compose(['restart', 'guacd']);
  else throw new Error('unknown configuration step');
}
if (isMain(import.meta.url)) {
  try { await configure(process.argv[2], readJson(process.argv[3] || configFile)); console.log(`OK: ${process.argv[2]}`); }
  catch { console.error(`FAIL: ${process.argv[2]} (subprocess output suppressed; inspect service status without credentials)`); process.exitCode = 1; }
}
