import { upsertEnvValue, parseEnvText } from './env-kv.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { Client } = _require('C:/Users/USER/.qwen/tmp/node_modules/basic-ftp');

// ===== Configuration =====
const REBOOTH_FTP = {
  host: 'ftp-orgiast.heteml.net',
  user: 'orgiast_rebooth-wedia',
  pass: '84ag7kg5xxr6',
  port: '21',
  protocol: 'ftps',
  docroot: '',
};
const ORGIAST_FTP = {
  host: 'ftp-orgiast.heteml.net',
  user: 'orgiast',
  pass: 'C1PyBOAbiroIGaJs',
  port: '21',
  protocol: 'ftps',
  docroot: '',
};

function buildEnvText(obj, keyMap) {
  let text = '';
  for (const [key, value] of Object.entries(keyMap)) {
    const envKey = value.envKey || key.toUpperCase();
    const val = obj[key];
    if (val !== undefined && val !== null && val !== '') {
      text = upsertEnvValue(text, envKey, val);
    }
  }
  return text;
}

async function writeEnvFile(filePath, ftpConfig) {
  const keyMap = {
    host: { envKey: 'FTP_HOST' },
    user: { envKey: 'FTP_USER' },
    pass: { envKey: 'FTP_PASS' },
    port: { envKey: 'FTP_PORT' },
    protocol: { envKey: 'FTP_PROTOCOL' },
    docroot: { envKey: 'FTP_DOCROOT' },
  };

  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
    // Only append missing keys; keep existing values
    const existing = parseEnvText(text);
    for (const [key, meta] of Object.entries(keyMap)) {
      if (existing[meta.envKey] !== undefined && existing[meta.envKey] !== '') {
        continue; // already set
      }
      text = upsertEnvValue(text, meta.envKey, ftpConfig[key]);
    }
  } catch {
    // File doesn't exist, create fresh
    text = buildEnvText(ftpConfig, keyMap);
  }
  fs.writeFileSync(filePath, text, 'utf8');
  // Report only set/empty
  const result = parseEnvText(text);
  const entries = Object.keys(keyMap).map(k => {
    const ek = keyMap[k].envKey;
    return `${ek}: ${result[ek] ? 'set' : 'empty'}`;
  });
  return entries;
}

async function testFtp(ftpConfig) {
  const client = new Client();
  client.ftp.verbose = false;
  const results = { host: ftpConfig.host, user: ftpConfig.user, status: '', dirs: {}, errors: [] };

  try {
    await client.access({
      host: ftpConfig.host,
      user: ftpConfig.user,
      password: ftpConfig.pass,
      port: parseInt(ftpConfig.port || '21'),
      secure: ftpConfig.protocol === 'ftps' ? 'explicit' : false,
      secureOptions: { rejectUnauthorized: false },
    });
    results.status = 'connected';

    // List available directories at root
    const rootList = await client.list();
    const dirs = rootList.filter(e => e.isDirectory).map(e => e.name);
    results.dirs['/'] = dirs;

    // Check specific paths based on site
    if (ftpConfig.user === 'orgiast_rebooth-wedia' || ftpConfig.user === 'orgiast') {
      // Try common paths
      for (const path of ['/', '/web', '/web/rebooth.co.jp', '/web/orgiast.jp', 'en', 'en/expo-apply', 'wp']) {
        try {
          await client.ensureDir(path);
          const list = await client.list();
          const names = list.filter(e => e.isDirectory).map(e => `[dir] ${e.name}`)
            .concat(list.filter(e => e.isFile).map(e => e.name));
          results.dirs[path] = names;
        } catch {
          // path doesn't exist or can't access
        }
      }
      // Try parent to understand structure
      try {
        await client.ensureDir('..');
        const parent = await client.list();
        results.dirs['..'] = parent.filter(e => e.isDirectory).map(e => e.name);
      } catch {}
    }

  } catch (e) {
    results.status = 'failed';
    results.errors.push(e.message.split('\n')[0]);
  } finally {
    client.close();
  }
  return results;
}

// Main
const reboothEnvPath = 'C:/Users/USER/.claude/rebooth-ftp.env';
const orgiastEnvPath = 'C:/Users/USER/.claude/orgiast-ftp.env';

// Write env files
console.log('=== rebooth-ftp.env ===');
const reboothEntries = await writeEnvFile(reboothEnvPath, REBOOTH_FTP);
for (const e of reboothEntries) console.log('  ' + e);

console.log('\n=== orgiast-ftp.env ===');
const orgiastEntries = await writeEnvFile(orgiastEnvPath, ORGIAST_FTP);
for (const e of orgiastEntries) console.log('  ' + e);

// Test connections
console.log('\n=== Connection test: rebooth ===');
const reboothTest = await testFtp(REBOOTH_FTP);
if (reboothTest.status === 'connected') {
  console.log('  Status: connected');
  for (const [path, items] of Object.entries(reboothTest.dirs)) {
    if (path === '/' && items.includes('web')) console.log(`  Detected heteml structure: /web/`);
    if (path === '/web/rebooth.co.jp') {
      REBOOTH_FTP.docroot = '/web/rebooth.co.jp';
      console.log(`  Docroot: /web/rebooth.co.jp`);
      if (items.includes('en')) console.log('  en/: present');
      if (items.includes('wp-admin')) console.log('  wp-admin/: present');
      // Check en/ and en/expo-apply/
      const idx = items.indexOf('en');
      if (idx >= 0) {
        try {
          const enItems = reboothTest.dirs['en'] || [];
          console.log(`  en/ files: ${JSON.stringify(enItems)}`);
          if (enItems.includes('expo-apply')) {
            const expoItems = reboothTest.dirs['en/expo-apply'] || [];
            console.log(`  en/expo-apply/ files: ${JSON.stringify(expoItems)}`);
          }
        } catch {}
      }
    }
  }
  // Show all directories explored
  for (const [path, items] of Object.entries(reboothTest.dirs)) {
    console.log(`  ${path}: ${items.slice(0, 20).join(', ')}${items.length > 20 ? '...' : ''}`);
  }
} else {
  console.log('  Status: failed -', reboothTest.errors.join('; '));
}

console.log('\n=== Connection test: orgiast ===');
const orgiastTest = await testFtp(ORGIAST_FTP);
if (orgiastTest.status === 'connected') {
  console.log('  Status: connected');
  for (const [path, items] of Object.entries(orgiastTest.dirs)) {
    if (path === '/' && items.includes('web')) console.log('  Detected heteml structure: /web/');
    if (path === '/web/orgiast.jp' || path === '/web') {
      if (path === '/web') ORGIAST_FTP.docroot = '/web';
      console.log(`  ${path}: ${items.slice(0, 20).join(', ')}${items.length > 20 ? '...' : ''}`);
    }
    if (path === '/web/orgiast.jp') {
      ORGIAST_FTP.docroot = '/web/orgiast.jp';
      if (items.includes('en')) console.log('  en/: present');
      if (items.includes('wp')) console.log('  wp/: present');
    }
  }
  // Show all directories explored
  for (const [path, items] of Object.entries(orgiastTest.dirs)) {
    if (path.startsWith('/web') || path === '/') {
      console.log(`  ${path}: ${items.slice(0, 20).join(', ')}${items.length > 20 ? '...' : ''}`);
    }
  }
} else {
  console.log('  Status: failed -', orgiastTest.errors.join('; '));
}

// Update docroot in env files if found
if (REBOOTH_FTP.docroot) {
  let text = fs.readFileSync(reboothEnvPath, 'utf8');
  text = upsertEnvValue(text, 'FTP_DOCROOT', REBOOTH_FTP.docroot);
  fs.writeFileSync(reboothEnvPath, text, 'utf8');
  console.log(`\n  Updated rebooth-ftp.env docroot: ${REBOOTH_FTP.docroot}`);
}
if (ORGIAST_FTP.docroot) {
  let text = fs.readFileSync(orgiastEnvPath, 'utf8');
  text = upsertEnvValue(text, 'FTP_DOCROOT', ORGIAST_FTP.docroot);
  fs.writeFileSync(orgiastEnvPath, text, 'utf8');
  console.log(`\n  Updated orgiast-ftp.env docroot: ${ORGIAST_FTP.docroot}`);
}