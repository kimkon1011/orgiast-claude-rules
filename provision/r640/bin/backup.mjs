#!/usr/bin/env node
import fs from 'node:fs';
import { readJson, run, compose } from '../lib/core.mjs';
try {
  const site = readJson('/etc/orgiast-r640/site.json');
  if (!site.backupRepository || /REPLACE/.test(site.backupRepository)) throw new Error('backup destination missing');
  if (site.backupMount) run('mountpoint', ['-q', site.backupMount]);
  if (site.backupRepository.startsWith('/') && !site.backupMount) throw new Error('local repository needs explicit backupMount');
  process.env.RESTIC_REPOSITORY = site.backupRepository;
  process.env.RESTIC_PASSWORD_FILE = '/run/orgiast-r640/restic-password';
  // Repository initialization is an administrator prerequisite; never initialize at a
  // wrong path after a NAS mount/network failure. No automatic destructive retention.
  run('restic', ['cat', 'config']);
  run('restic', ['backup', '--quiet', '/home', '/root/provision', '/etc/orgiast-r640', '/etc/xrdp', '/etc/ssh', '/root/.claude']);
  const dump = compose(['exec', '-T', '--user', 'postgres', 'db', 'pg_dump', '-U', 'guacamole', '-d', 'guacamole']);
  run('restic', ['backup', '--quiet', '--stdin', '--stdin-filename', 'guacamole.sql'], dump);
  if (fs.existsSync('/boot/efi-secondary')) run('bash', ['/opt/orgiast-r640/bin/sync-efi.sh']);
  console.log('PASS: home, config, encrypted onboarding and PostgreSQL backup');
} catch { console.error('FAIL: backup (destination, mount, credentials and repository must be prepared)'); process.exitCode = 1; }
