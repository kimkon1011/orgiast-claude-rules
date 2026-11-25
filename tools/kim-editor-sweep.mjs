#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { getDriveToken, driveApi, defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { ensureKimEditor, KIM_EMAIL } from './lib/kim-editor.mjs';
import { addItem } from './kim-inbox.mjs';
import { isEntry } from './is-entry.mjs';

const transientDriveError = error => /(?:\b(?:408|429|5\d\d)\b|fetch failed|timed? ?out|timeout|ECONN(?:RESET|REFUSED)|EAI_AGAIN|ENETUNREACH|socket hang up)/i.test(String(error?.message ?? error));
export async function retryTransientDrive(operation, { attempts = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt === attempts || !transientDriveError(error)) throw error;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

// Only fleet execution accounts, never people discovered in a directory or permission list.
export function sweepAccounts(map) {
  return [...new Set(['seisaku-team@orgiast.jp', KIM_EMAIL, ...Object.entries(map)
    .filter(([key, value]) => !key.startsWith('_') && value && typeof value === 'object')
    .map(([, value]) => String(value.account || '').trim().toLowerCase())])]
    .filter(email => /^[\w.+-]+@orgiast\.jp$/.test(email));
}
export function sweepQuery(account, now) {
  const since = new Date(new Date(now).getTime() - 7 * 86400000).toISOString();
  // A personal execution account may contain private files. Only files marked by our
  // creation paths are eligible there. The shared production account has no personal scope.
  // Shortcuts can't have permissions changed, so exclude them.
  return `trashed=false and mimeType != 'application/vnd.google-apps.shortcut' and 'me' in owners and createdTime >= '${since}'`
    + (account === KIM_EMAIL ? " and properties has { key='orgiastKimInbox' and value='pending' }" : '')
    + (account === 'seisaku-team@orgiast.jp' ? '' : " and properties has { key='orgiastAutomation' and value='true' }");
}
export async function sweep({
  map = JSON.parse(fs.readFileSync(new URL('../fleet-pc-map.json', import.meta.url), 'utf8')),
  now = new Date(), home = process.env.ORGIAST_HOME || os.homedir(),
  getToken = getDriveToken, api = driveApi, ensure = ensureKimEditor, inbox = addItem,
  credentialAvailable = getToken !== getDriveToken || fs.existsSync(process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath()),
} = {}) {
  const result = { checked: 0, granted: 0, errors: [] };
  // The sweep must impersonate every execution account. The keyless GWS relay is
  // intentionally limited to seisaku-team@ (and kim calendar reads), so running
  // through it can never complete this job. A key-bearing fleet seat performs the
  // shared sweep; keyless seats should be a successful no-op instead of a daily
  // task failure that suggests permissions were checked.
  if (!credentialAvailable) {
    const skipped = 'DWD サービスアカウント鍵がないためスキップ（鍵のある席で実行）';
    await inbox(home, { kind: 'info', source: 'kim-editor-sweep', text: `kim 編集権限の日次確認: ${skipped}` });
    return { ...result, skipped };
  }
  for (const account of sweepAccounts(map)) {
    try {
      const token = await retryTransientDrive(() => getToken({ impersonate: account }));
      let pageToken;
      do {
        const params = new URLSearchParams({ q: sweepQuery(account, now), fields: 'nextPageToken,files(id,owners(emailAddress),properties)', pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await retryTransientDrive(async () => (await api(token, `https://www.googleapis.com/drive/v3/files?${params}`, { signal: AbortSignal.timeout(30_000) })).json());
        for (const file of page.files ?? []) {
          if (!file.owners?.some(owner => owner.emailAddress?.toLowerCase() === account)) continue;
          result.checked++;
          try {
            if ((await retryTransientDrive(() => ensure(file.id, { actingUser: account, token, api }))).changed) result.granted++;
            if (file.properties?.orgiastKimInbox === 'pending') {
              const endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`;
              const item = await (await api(token, `${endpoint}?alt=media`, { signal: AbortSignal.timeout(30_000) })).json();
              if (typeof item.text !== 'string' || !item.text.trim()) throw new Error('empty GAS inbox entry');
              await inbox(home, { kind: item.kind === 'action' || item.kind === 'ask' ? 'ask' : 'info', text: item.text, source: 'feedback-gas', dedupeKey: `gas-inbox:${file.id}` });
              await api(token, `${endpoint}?supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: { orgiastKimInbox: 'delivered' } }), signal: AbortSignal.timeout(30_000) });
            }
          }
          catch (error) { result.errors.push(`${account}: ${file.id} の編集権限確認に失敗 (${String(error?.message ?? error).slice(0, 500)})`); }
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) { result.errors.push(`${account}: Drive の巡回に失敗 (${String(error?.message ?? error).slice(0, 500)})`); }
  }
  await inbox(home, { kind: 'info', source: 'kim-editor-sweep', text: `kim 編集権限の日次確認: 確認 ${result.checked}件 / 付与 ${result.granted}件 / 失敗 ${result.errors.length}件${result.errors.length ? '\n' + result.errors.join('\n') : ''}` });
  if (result.errors.length) throw new Error(result.errors.join('; '));
  return result;
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await sweep())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
