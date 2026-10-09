import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getDriveToken } from '../drive-auth.mjs';
import { compactMessage } from '../../gmail-search.mjs';
import { genericPartner } from './rules-payments.mjs';
import { DAY, USERS, normalize, maskNumbers, mapLimit, getJson, readJson, writePrivate, reason, auditError } from './common.mjs';
export function searchTerm(name) {
  const clean = String(name ?? '').normalize('NFKC').replace(/株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)/g, '').trim().replace(/\s+/g, ' ');
  return clean;
}
export const escapeDrive = value => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
export const gmailTerm = value => value.replace(/["\\]/g, ' ');
export function createGoogle({ keyPath, fetchImpl = fetch, signal } = {}) {
  const tokens = new Map();
  const getToken = ({ scope, impersonate }) => {
    const k = `${scope}:${impersonate}`;
    if (!tokens.has(k)) tokens.set(k, getDriveToken({ keyPath, scope, impersonate, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }));
    return tokens.get(k);
  };
  const request = async (url, user, scope = 'drive') => getJson(url, { headers: { Authorization: `Bearer ${await getToken({ scope: `https://www.googleapis.com/auth/${scope}`, impersonate: user })}` }, fetchImpl, signal });
  return { getToken, request };
}
export function createGmailSource({ google, fetchImpl = fetch, signal } = {}) {
  return async (term, days) => {
    let count = 0, latest = '', representative = '', preferred = false, lowerBound = false;
    const failed = [];
    for (const user of USERS) try {
      const token = await google.getToken({ scope: 'https://www.googleapis.com/auth/gmail.readonly', impersonate: user });
      const request = suffix => getJson(`https://gmail.googleapis.com/gmail/v1/users/me${suffix}`, {
        headers: { Authorization: `Bearer ${token}` }, fetchImpl, signal,
      });
      const list = await request(`/messages?${new URLSearchParams({ q: `"${gmailTerm(term)}" newer_than:${days}d`, maxResults: '100' })}`);
      if (list.messages !== undefined && !Array.isArray(list.messages)) throw auditError('Gmail 一覧形式不正');
      const stubs = list.messages || [];
      count += stubs.length;
      lowerBound ||= stubs.length >= 100;
      for (const stub of stubs) {
        let msg;
        try { msg = compactMessage(await request(`/messages/${encodeURIComponent(stub.id)}?format=metadata&metadataHeaders=Date&metadataHeaders=From&metadataHeaders=Subject`)); }
        catch (e) { if ([404, 410].includes(e.status)) continue; throw e; }
        const match = [msg.subject, msg.from].some(text => text.normalize('NFKC').toLowerCase().includes(term.toLowerCase()));
        const date = Number.isFinite(Date.parse(msg.date)) ? new Date(msg.date).toISOString() : '';
        if (!representative || match && !preferred || match === preferred && date > latest) {
          latest = date; representative = maskNumbers(msg.subject || msg.from); preferred = match;
        }
      }
    } catch (e) { failed.push(`${user}: ${reason(e)}`); }
    return { status: failed.length ? 'unverified' : 'ok', count, lowerBound, latest, representative,
      reason: failed.join('; '), countKind: '一覧の実件数（各ユーザー最大100件・ユーザー間の重複あり）' };
  };
}
export function createDriveSource({ google, now = new Date() } = {}) {
  return async (term, days) => {
    const files = new Map(), failed = [];
    for (const user of USERS) try {
      let pageToken; const pageTokens = new Set();
      do {
        const u = new URL('https://www.googleapis.com/drive/v3/files');
        u.search = new URLSearchParams({ q: `trashed = false and fullText contains '${escapeDrive(`"${term}"`)}' and modifiedTime >= '${new Date(+now - days * DAY).toISOString()}'`, fields: 'nextPageToken,incompleteSearch,files(id,name,modifiedTime)', pageSize: '1000', orderBy: 'modifiedTime desc', ...(pageToken ? { pageToken } : {}) });
        const j = await google.request(u, user);
        if (!Array.isArray(j.files) || j.incompleteSearch) throw auditError('Drive 検索が不完全');
        for (const f of j.files) files.set(f.id, f);
        pageToken = j.nextPageToken;
        if (pageToken && pageTokens.has(pageToken)) throw auditError('ページトークンが反復したため取得中断（不完全）');
        if (pageToken) pageTokens.add(pageToken);
      } while (pageToken);
    } catch (e) { failed.push(`${user}: ${reason(e)}`); }
    const first = [...files.values()].sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))[0];
    return { status: failed.length ? 'unverified' : 'ok', count: files.size, latest: first?.modifiedTime || '', representative: maskNumbers(first?.name), reason: failed.join('; ') };
  };
}
export function createDiscord({ token, fetchImpl = fetch, signal, stateDir, partners, now = new Date() } = {}) {
  const request = route => { if (!token) throw auditError('Discord トークン未設定'); return getJson(`https://discord.com/api/v10/${route}`, { headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://orgiast.jp, 1.0)' }, fetchImpl, signal }); };
  let channelPromise, fallbackPromise;
  const channels = () => channelPromise ||= request('guilds/715211007307284530/channels');
  async function fallback() {
    const file = path.join(stateDir, 'discord-cache.json');
    const cached = await readJson(file, {});
    const terms = [...new Set(partners.map(p => searchTerm(p.name)).filter(Boolean))];
    if (cached.fetchedAt && +now - Date.parse(cached.fetchedAt) < DAY && terms.every(t => cached.terms?.[t])) return cached.terms;
    const results = Object.fromEntries(terms.map(t => [t, { status: 'unverified', count: 0, latest: '', representative: '', reason: 'チャンネル走査は直近90日・閲覧可能テキストのみ（スレッド等は未照合）' }]));
    const since = +now - 90 * DAY;
    for (const channel of (await channels()).filter(c => [0, 5].includes(c.type))) {
      let before;
      try {
        for (;;) {
          const rows = await request(`channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
          if (!Array.isArray(rows)) throw auditError('Discord messages: 応答形式不明');
          for (const msg of rows.filter(m => Date.parse(m.timestamp) >= since)) for (const term of terms) {
            if (normalize(msg.content).includes(normalize(term))) {
              const r = results[term]; r.count++;
              if (msg.timestamp > r.latest) { r.latest = msg.timestamp; r.representative = maskNumbers(channel.name); }
            }
          }
          if (rows.length < 100 || Date.parse(rows.at(-1).timestamp) < since) break;
          const next = rows.at(-1).id;
          if (next === before) throw auditError('Discord messages: ページが進みません');
          before = next;
        }
      } catch (e) { if (e.status !== 403 && e.status !== 404) throw e; }
    }
    await writePrivate(file, { fetchedAt: now.toISOString(), from: new Date(since).toISOString(), to: now.toISOString(), terms: results });
    return results;
  }
  return { request, async search(term, days) {
    const minId = ((BigInt(Math.floor(+now - days * DAY)) - 1420070400000n) << 22n).toString();
    try {
      const j = await request(`guilds/715211007307284530/messages/search?${new URLSearchParams({ content: `"${term}"`, limit: '25', min_id: minId, sort_by: 'timestamp', sort_order: 'desc' })}`);
      if (!Array.isArray(j.messages) || !Number.isFinite(j.total_results)) throw auditError('Discord 検索: インデックス未完了または応答形式不明');
      const hit = j.messages.flat().filter(m => m.hit !== false).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
      const channel = hit ? (await channels()).find(c => c.id === hit.channel_id)?.name : '';
      return { status: j.doing_deep_historical_index ? 'unverified' : 'ok', count: j.total_results, latest: hit?.timestamp || '', representative: maskNumbers(channel || (hit ? '検索対象チャンネル' : '')), reason: j.doing_deep_historical_index ? '検索インデックス作成中' : '' };
    } catch (e) { if (![403, 404].includes(e.status)) throw e; fallbackPromise ||= fallback(); return (await fallbackPromise)[term]; }
  }, async members() {
    const members = []; let after = '';
    for (;;) {
      const rows = await request(`guilds/715211007307284530/members?limit=1000${after ? `&after=${after}` : ''}`);
      if (!Array.isArray(rows)) throw auditError('Discord members: 応答形式不明');
      members.push(...rows.filter(m => !m.user?.bot).map(m => ({ names: [m.nick, m.user?.global_name, m.user?.username].filter(Boolean), emails: [] })));
      if (rows.length < 1000) break;
      const next = rows.at(-1).user?.id; if (!next || next === after) throw auditError('Discord members: ページが進みません'); after = next;
    }
    return members;
  } };
}
export async function buildFootprint(partners, { window = 180, sources, patterns = {}, state = {}, stateDir = path.join(os.homedir(), '.claude/internal-audit'), now = new Date() } = {}) {
  const file = path.join(stateDir, 'footprint-cache.json'), cache = await readJson(file, {});
  const month = now.toISOString().slice(0, 7);
  const entries = await mapLimit(partners, 3, async p => {
    const term = searchTerm(p.name), key = `${p.id}+${month}`, cached = cache[key];
    const fp = {};
    for (const name of ['gmail', 'drive', 'discord']) {
      if (genericPartner(p.name, patterns)) { fp[name] = { status: 'unverified', count: null, reason: '汎用取引先名のため照合不能' }; continue; }
      if (!sources[name]) { fp[name] = { status: 'unverified', count: null, reason: 'skip 指定' }; continue; }
      if (cached?.term === term && cached.window === window && +now - Date.parse(cached.results?.[name]?.fetchedAt || cached.at) < 30 * DAY && (cached.results?.[name]?.status === 'ok' || cached.results?.[name]?.countKind?.includes('推定'))) { fp[name] = { ...cached.results[name] };
        if (name === 'gmail' && fp[name].countKind?.includes('推定')) {
          fp[name] = { ...fp[name], count: null, status: 'unverified', controlVerified: false, reason: '旧キャッシュは推定件数のため件数未確認（再取得を省略）' };
        }
        continue; }
      try { fp[name] = term.length >= 2 ? await sources[name](term, window + 90) : { status: 'unverified', count: null, reason: '検索語が短すぎます' }; }
      catch (e) { fp[name] = { status: 'failed', count: null, reason: reason(e) }; }
      fp[name].fetchedAt = now.toISOString();
    }
    cache[key] = { at: cached?.at || now.toISOString(), term, window, results: fp };
    return [String(p.id), fp];
  });
  // Same queries against paid vendors constitute positive controls. Zero-only runs are never evidence of absence.
  for (const name of ['gmail', 'drive', 'discord']) {
    const control = entries.find(([, fp]) => fp[name]?.count > 0 && fp[name].status === 'ok');
    for (const [, fp] of entries) {
      fp[name].controlVerified = !!control;
      if (control) fp[name].controlPartnerId = control[0];
      else if (fp[name].status === 'ok' && fp[name].count === 0) { fp[name].status = 'unverified'; fp[name].reason = '対照群でも形跡を確認できないため0件を確定しません'; }
    }
  }
  await writePrivate(file, cache, state.secrets || []);
  return Object.fromEntries(entries);
}

// discord-member-directory stores query results, not a complete staff roster.
export async function cachedStaff(home, now = new Date()) {
  const cached = await readJson(path.join(home, '.claude', 'orgiast-discord-members.json'), {});
  const members = new Map();
  for (const entry of Object.values(cached.queries || {})) if (+now - Date.parse(entry.fetched_at) < DAY) {
    for (const m of entry.members || []) if (m.id) members.set(m.id, { names: [m.nick, m.global_name, m.username].filter(Boolean), emails: m.emails || [] });
  }
  return [...members.values()];
}

// Old snapshots and caches do not contain an actual Gmail list count.
export function normalizeSavedFootprint(snapshot, patterns, sources) {
  const affected = new Set();
  for (const partner of snapshot.partners) {
    const fp = snapshot.footprint?.[String(partner.id)];
    if (!fp) continue;
    for (const name of ['gmail', 'drive', 'discord']) {
      if (genericPartner(partner.name, patterns)) {
        fp[name] = { status: 'unverified', count: null, controlVerified: false, reason: '汎用取引先名のため照合不能' };
        affected.add(name);
      } else if (name === 'gmail' && fp[name]?.countKind?.includes('推定')) {
        fp[name] = { ...fp[name], status: 'unverified', count: null, controlVerified: false, reason: '旧snapshotは推定件数のため件数未確認（再取得を省略）' };
        affected.add(name);
      }
    }
  }
  for (const name of affected) {
    const results = Object.values(snapshot.footprint).map(fp => fp[name]).filter(Boolean);
    sources[name] = { status: 'unverified', count: results.reduce((sum, r) => sum + (r.count || 0), 0),
      reason: [...new Set(results.filter(r => r.status !== 'ok').map(r => r.reason))].join('; ') };
  }
}
