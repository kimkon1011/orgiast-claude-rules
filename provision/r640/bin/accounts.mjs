#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { atomic, readJson, run, parseCsv, password, hashes, encrypt, csvField, sql, literal, isMain } from '../lib/core.mjs';

export const RDP_PARAMETERS = Object.freeze({ hostname: 'host.docker.internal', port: '3389', username: '${GUAC_USERNAME}', password: '${GUAC_PASSWORD}', security: 'tls', 'ignore-cert': 'true', 'color-depth': '24', 'resize-method': 'display-update', 'enable-wallpaper': 'false', 'disable-copy': 'false', 'disable-paste': 'false', 'server-layout': 'ja-jp-qwerty', 'enable-drive': 'false' });
export function accountSql(users, state, prune = false) {
  let out = "BEGIN;\nSET LOCAL standard_conforming_strings = on;\nUPDATE guacamole_user SET disabled=true WHERE entity_id IN (SELECT entity_id FROM guacamole_entity WHERE name='guacadmin' AND type='USER');\n";
  for (const user of users) {
    const entry = state[user.username];
    if (!entry || !/^[0-9a-f]{64}$/i.test(entry.guac) || !/^[0-9a-f]{64}$/i.test(entry.salt)) throw new Error('managed password hashes missing');
    const name = literal(user.username), conn = literal(`desktop-${user.username}`);
    const entity = `(SELECT entity_id FROM guacamole_entity WHERE name=${name} AND type='USER')`;
    const connection = `(SELECT connection_id FROM guacamole_connection WHERE connection_name=${conn})`;
    out += `INSERT INTO guacamole_entity(name,type) VALUES (${name},'USER') ON CONFLICT(name,type) DO NOTHING;\n`;
    out += `INSERT INTO guacamole_user(entity_id,password_hash,password_salt,password_date,disabled,expired,full_name,email_address) VALUES (${entity},decode('${entry.guac}','hex'),decode('${entry.salt}','hex'),CURRENT_TIMESTAMP,false,false,${literal(user.display_name)},${literal(user.email)}) ON CONFLICT(entity_id) DO UPDATE SET disabled=false,full_name=EXCLUDED.full_name,email_address=EXCLUDED.email_address;\n`;
    // Existing passwords are not reset on rerun; changes must use the dual-store rotation procedure.
    out += `INSERT INTO guacamole_connection(connection_name,protocol,max_connections,max_connections_per_user) SELECT ${conn},'rdp',1,1 WHERE NOT EXISTS (SELECT 1 FROM guacamole_connection WHERE connection_name=${conn});\n`;
    for (const [key, value] of Object.entries(RDP_PARAMETERS)) out += `INSERT INTO guacamole_connection_parameter(connection_id,parameter_name,parameter_value) VALUES (${connection},${literal(key)},${literal(value)}) ON CONFLICT(connection_id,parameter_name) DO UPDATE SET parameter_value=EXCLUDED.parameter_value;\n`;
    out += `INSERT INTO guacamole_connection_permission(entity_id,connection_id,permission) VALUES (${entity},${connection},'READ') ON CONFLICT DO NOTHING;\n`;
    // Do not grant UPDATE or user self-update: this would desynchronise the OS password.
  }
  if (prune) for (const name of Object.keys(state).filter(n => !users.some(u => u.username === n))) {
    out += `UPDATE guacamole_user SET disabled=true WHERE entity_id IN (SELECT entity_id FROM guacamole_entity WHERE name=${literal(name)} AND type='USER');\n`;
    out += `DELETE FROM guacamole_connection_permission WHERE entity_id IN (SELECT entity_id FROM guacamole_entity WHERE name=${literal(name)} AND type='USER');\n`;
  }
  return out + 'COMMIT;\n';
}
export function reconcile(users, site, { directory = '/root/provision', prune = false, remove = false, runner = run, sync = sql } = {}) {
  const file = path.join(directory, 'accounts.json');
  const state = readJson(file, {});
  const passwd = runner('getent', ['passwd']);
  const existing = new Set(passwd.split('\n').map(l => l.split(':')[0]));
  for (const u of users) if (existing.has(u.username) && !state[u.username]) throw new Error('refusing unmanaged account collision');
  if (!users.length && prune) throw new Error('refusing empty CSV prune');
  for (const u of users) {
    let entry = state[u.username];
    if (entry?.deleted) throw new Error('deleted username requires explicit recovery review');
    if (!entry) {
      const secret = password();
      entry = { ...hashes(secret), pending: true, disabled: false, archive: Object.keys(state).length === 0 ? 'initial-passwords.csv.age' : `initial-passwords.${u.username}.csv.age` };
      // Encrypt before *any* OS/DB mutation. Only ciphertext and salted hashes reach disk.
      entry.csv = encrypt(`username,display_name,email,password\n${[u.username, u.display_name, u.email, secret].map(csvField).join(',')}\n`, site.ageRecipient);
      entry.message = encrypt(`宛先: ${u.email}\n用件: 社員デスクトップの初期ログイン\n本文: https://${site.hostname}/guacamole/ を開き、ID ${u.username} と初期パスワード ${secret} でログインしてください。接続名 desktop-${u.username} を選択するとデスクトップが開きます。\n`, site.ageRecipient);
      state[u.username] = entry;
      atomic(file, JSON.stringify(state));
    }
    if (entry.pending) {
      atomic(path.join(directory, entry.archive), entry.csv);
      atomic(path.join(directory, `distribution.${u.username}.txt.age`), entry.message);
    }
    if (!existing.has(u.username)) runner('useradd', ['--create-home', '--user-group', '--shell', '/bin/bash', '--comment', u.display_name, u.username]);
    if (entry.pending) runner('chpasswd', ['--encrypted'], `${u.username}:${entry.linux}\n`);
    runner('usermod', ['--append', '--groups', 'orgiast-r640', '--comment', u.display_name, u.username]);
    const groups = runner('id', ['-nG', u.username]).trim().split(/\s+/);
    for (const group of ['sudo', 'admin', 'docker']) if (groups.includes(group)) runner('gpasswd', ['--delete', u.username, group]);
    if (entry.disabled) { runner('usermod', ['--unlock', '--expiredate', '', '--shell', '/bin/bash', u.username]); entry.disabled = false; }
    runner('chmod', ['700', `/home/${u.username}`]);
    atomic(file, JSON.stringify(state));
  }
  // DB failure leaves pending hashes/ciphertext recoverable; rerun uses identical password.
  sync(accountSql(users, state, prune));
  for (const u of users) { state[u.username].pending = false; delete state[u.username].csv; delete state[u.username].message; }
  if (prune) for (const name of Object.keys(state).filter(n => !users.some(u => u.username === n))) {
    if (!state[name].deleted && existing.has(name)) {
      runner('usermod', ['--lock', '--expiredate', '1970-01-02', '--shell', '/usr/sbin/nologin', name]);
      // loginctl returns nonzero for users with no sessions. Query before terminating.
      const sessions = runner('loginctl', ['list-users', '--no-legend']);
      if (sessions.split('\n').some(l => l.trim().split(/\s+/)[1] === name)) runner('loginctl', ['terminate-user', name]);
      if (remove) { runner('userdel', ['--remove', name]); state[name].deleted = true; }
    }
    state[name].disabled = true;
  }
  atomic(file, JSON.stringify(state));
  return { users: users.length, managed: Object.keys(state).length };
}
if (isMain(import.meta.url)) {
  try {
    const [csv, sitePath, ...flags] = process.argv.slice(2);
    if (flags.some(x => !['--prune', '--delete', '--confirm-delete', '--sync-only', '--count'].includes(x))) throw new Error('invalid accounts arguments');
    if (flags.includes('--delete') && !(flags.includes('--prune') && flags.includes('--confirm-delete'))) throw new Error('delete requires --prune --confirm-delete');
    const users = parseCsv(fs.readFileSync(csv, 'utf8'));
    if (flags.includes('--count')) console.log(users.length);
    else if (flags.includes('--sync-only')) { sql(accountSql(users, readJson('/root/provision/accounts.json'), flags.includes('--prune'))); console.log(`OK: guacamole users=${users.length}`); }
    else { const result = reconcile(users, readJson(sitePath), { prune: flags.includes('--prune'), remove: flags.includes('--delete') }); console.log(`OK: accounts=${result.users}`); }
  } catch { console.error('FAIL: accounts validation or reconciliation (details suppressed to protect credentials)'); process.exitCode = 1; }
}
