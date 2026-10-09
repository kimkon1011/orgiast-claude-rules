import { createHash } from 'node:crypto';
import { DAY, USERS, maskNumbers, reason, auditError } from './common.mjs';
import { shareDomain, summarizeShares, baselineFinding, sharingFinding } from './sharing-baseline.mjs';
export const ADMIN_SCOPE = 'https://www.googleapis.com/auth/admin.reports.audit.readonly';
export function adminScopeMessage(clientId = '（鍵ファイルの client_id を確認）') {
  return `Workspace 監査ログ: 未確認（DWD スコープ未付与）。付与手順: Google 管理コンソール（kim@orgiast.jp で開く）→ セキュリティ → アクセスとデータ管理 → API の制御 → ドメイン全体の委任 → クライアント ID \`${clientId}\` を編集 → スコープに \`${ADMIN_SCOPE}\` を追加 → 承認。付与後は次回実行から自動で有効。`;
}
export function isExternalPermission(p) {
  if (p.deleted || p.role === 'owner') return false;
  return p.type === 'anyone' || (p.type === 'domain' ? p.domain?.toLowerCase() !== 'orgiast.jp' : p.emailAddress && p.emailAddress.split('@').at(-1)?.toLowerCase() !== 'orgiast.jp');
}
export function permissionKey(file, p) {
  return createHash('sha256').update(JSON.stringify([file.id, p.id, p.type, p.emailAddress?.toLowerCase(), p.domain?.toLowerCase(), p.role, !!p.allowFileDiscovery])).digest('hex');
}
export function diffExternalShares(files, known = []) {
  const previous = new Set(known), keys = new Set(), findings = []; let knownCount = 0;
  for (const file of files) for (const p of file.permissions || []) if (isExternalPermission(p)) {
    const key = permissionKey(file, p); if (keys.has(key)) continue; keys.add(key);
    if (previous.has(key)) { knownCount++; continue; }
    findings.push(sharingFinding(file, p));
  }
  if (knownCount) findings.push({ rule: 'exfil', severity: 'info', subject: '既知の外部共有', detail: `${knownCount}権限（前回と同一）` });
  return { findings, keys: [...keys], knownCount };
}
const VISIBILITY = "(visibility = 'anyoneWithLink' or visibility = 'anyoneCanFind' or visibility = 'domainCanFind' or visibility = 'domainWithLink')";
const DRIVE_FIELDS = 'nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,permissions(id,type,role,emailAddress,domain,allowFileDiscovery,deleted),webViewLink)';
export async function scanDrive({ google, state = {}, known = state.knownExternalShares, userBudgetMs = 200000, nowMillis = Date.now, save = async () => {} }) {
  const sources = {}, findings = [], acknowledgedKeys = [], keys = new Set(known || []), priorKeys = new Set(known || []);
  state.driveScan ||= {};
  state.drivePriorityScan ||= {};
  state.externalShareFiles ||= {};
  let building = known === undefined;
  for (const user of USERS) {
    const scan = state.driveScan[user] ||= { pageToken: null, startedAt: null, completedAt: null, modifiedCursor: null };
    const priority = state.drivePriorityScan[user] ||= { pageToken: null, startedAt: null, completedAt: null, modifiedCursor: null };
    const baseline = known === undefined || !scan.completedAt || !!scan.pageToken || !!priority.pageToken || !priority.completedAt;
    const canDetect = known !== undefined && !!scan.completedAt && !!priority.completedAt;
    state.pendingExternalFindings ||= {};
    building ||= baseline;
    let count = 0;
    const until = nowMillis() + userBudgetMs;
    try {
      // Public/link-visible files are paginated before the complete ownership scan.
      for (const [cursor, visibility] of [[priority, true], [scan, false]]) {
        if (!cursor.pageToken) cursor.startedAt = new Date(nowMillis()).toISOString();
        const pageTokens = new Set(cursor.pageToken ? [cursor.pageToken] : []);
        do {
          if (nowMillis() >= until) throw auditError('Drive 所有ファイル走査の時間上限（再開位置あり・次回継続）');
          const url = new URL('https://www.googleapis.com/drive/v3/files');
          const q = ["trashed = false and 'me' in owners", visibility ? VISIBILITY : '',
            cursor.modifiedCursor ? `modifiedTime > '${cursor.modifiedCursor}'` : ''].filter(Boolean).join(' and ');
          url.search = new URLSearchParams({ q, orderBy: 'modifiedTime desc', pageSize: '1000', fields: DRIVE_FIELDS,
            ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}) });
          let j;
          try { j = await google.request(url, user); }
          catch (e) {
            // Expired continuation tokens restart the same interval, never advance its cursor.
            if (e.status === 400 && cursor.pageToken) cursor.pageToken = null;
            throw e;
          }
          if (!Array.isArray(j.files) || j.incompleteSearch) throw auditError('Drive 一覧が不完全（次回継続）');
          if (j.files.some(f => !Array.isArray(f.permissions))) throw auditError('Drive permissions 未取得');
          for (const raw of j.files) {
            const file = { ...raw, owner: user }, external = file.permissions.filter(isExternalPermission);
            state.externalShareFiles[`${user}:${file.id}`] = external.map(p => ({ owner: user, type: p.type, domain: shareDomain(p) }));
            count++;
            for (const p of external) {
              const key = permissionKey(file, p);
              if (canDetect && !priorKeys.has(key) && !keys.has(key)) {
                const finding = sharingFinding(file, p);
                state.pendingExternalFindings[key] = finding;
              }
              keys.add(key);
            }
          }
          const next = j.nextPageToken || null;
          if (next && pageTokens.has(next)) throw auditError('ページトークンが反復したため取得中断（再開位置あり・次回継続）');
          cursor.pageToken = next;
          if (next) pageTokens.add(next);
          else {
            cursor.completedAt = new Date(nowMillis()).toISOString();
            cursor.modifiedCursor = cursor.startedAt;
          }
          state.knownExternalShares = [...keys];
          await save(state);
        } while (cursor.pageToken);
      }

      sources[`drive-sharing:${user}`] = { status: 'ok', count, reason: `${baseline ? 'ベースライン構築（今回完了）' : '差分走査完了'}。所有ファイルのみ・共有ドライブ対象外` };
    } catch (e) {
      building = true;
      sources[`drive-sharing:${user}`] = { status: 'unverified', count, reason: `${reason(e)}。${scan.pageToken || priority.pageToken ? '再開位置あり・次回継続' : '未完了区間を次回再試行'}。ベースライン構築中` };
      // Incomplete user scans suppress individual findings. Retain these keys as unreported
      // so a completed later incremental scan can still report them.

      await save(state);
    }
    if (sources[`drive-sharing:${user}`].status === 'ok' && !baseline) {
      for (const [key, f] of Object.entries(state.pendingExternalFindings || {})) if (f.owner === user) {
        findings.push(f); acknowledgedKeys.push(key);
      }
    }
  }
  state.knownExternalShares = [...keys];
  const summary = summarizeShares(Object.values(state.externalShareFiles).flat());
  findings.push(baselineFinding(summary, building));
  return { findings, acknowledgedKeys, keys: [...keys], sources, baseline: { building, summary,
    limitation: '所有ファイルの取得済み権限を集計。権限数でありファイル数ではありません。差分走査では削除・所有者変更を追跡しないため最終確認時点の集計です。' } };
}

function params(event) {
  return Object.fromEntries((event.parameters || []).map(p => [p.name, p.value ?? p.intValue ?? p.boolValue ?? p.multiValue ?? p.multiIntValue ?? '']));
}
const external = value => String(value ?? '').split(/[\s,;]+/).some(v => v.includes('@') && v.split('@').at(-1)?.toLowerCase() !== 'orgiast.jp');
export function analyzeAdmin(items, { knownOAuth = [], thresholds, now = new Date() } = {}) {
  const findings = [], oauth = new Set(knownOAuth), downloads = new Map(), seen = new Set();
  for (const item of items) for (const event of item.events || []) {
    const p = params(event), actor = item.actor?.email || '不明', at = item.id?.time, app = item.id?.applicationName;
    const file = String(p.doc_id || p.document_id || ''), key = JSON.stringify([item.id, event.name, p]);
    if (seen.has(key)) continue; seen.add(key);
    const add = (severity, detail) => findings.push({ rule: 'exfil-admin', severity, subject: actor, detail: maskNumbers(detail) });
    if (app === 'drive') {
      if (['download', 'export'].includes(event.name) && at) { if (!downloads.has(actor)) downloads.set(actor, []); downloads.get(actor).push({ time: Date.parse(at), file }); }
      if (['change_user_access', 'change_document_visibility', 'add_to_folder'].includes(event.name)) {
        if (!(event.name === 'change_user_access' && p.new_value === 'none') && (external(p.target_user || p.target_user_email) || p.target_domain && p.target_domain !== 'orgiast.jp' || p.visibility_change === 'external' || ['public', 'public_on_the_web', 'people_with_link', 'anyone_with_link', 'shared_externally'].includes(p.visibility || p.new_visibility || p.new_value)))
          add('high', `外部への共有変更: ${event.name} / file ${file}`);
      }
    }
    if (app === 'login' && (['login_failure', 'suspicious_login'].includes(event.name) || event.name.startsWith('account_disabled_'))) add(event.name === 'login_failure' ? 'info' : 'medium', `ログインイベント: ${event.name} / ${at}`);
    if (app === 'token' && event.name === 'authorize') {
      const id = String(p.client_id || p.app_name || '');
      if (id && !oauth.has(id)) { add('medium', `新規 OAuth アプリ付与: ${p.app_name || id} / ${at}`); oauth.add(id); }
    }
  }
  for (const [actor, rows] of downloads) {
    rows.sort((a, b) => a.time - b.time);
    let maxDay = 0, maxWeek = 0, dayLeft = 0, weekLeft = 0;
    for (let i = 0; i < rows.length; i++) {
      while (rows[i].time - rows[dayLeft].time >= DAY) dayLeft++;
      while (rows[i].time - rows[weekLeft].time >= 7 * DAY) weekLeft++;
      maxDay = Math.max(maxDay, i - dayLeft + 1); maxWeek = Math.max(maxWeek, i - weekLeft + 1);
    }
    if (maxDay >= thresholds.download_day || maxWeek >= thresholds.download_week) findings.push({ rule: 'exfil-admin', severity: 'medium', subject: actor,
      detail: `download/export: 最大24時間 ${maxDay}件 / 最大7日 ${maxWeek}件 / ${new Set(rows.map(r => r.file)).size}ファイル` });
  }
  return { findings, knownOAuth: [...oauth] };
}
export async function scanAdmin({ google, state, clientId, thresholds, now = new Date() }) {
  const sources = {}, findings = [], cursors = { ...state.adminCursors }; let knownOAuth = state.knownOAuth || [];
  try { await google.getToken({ scope: ADMIN_SCOPE, impersonate: USERS[0] }); }
  catch (e) { return { findings, knownOAuth, cursors, sources: { admin: { status: 'unverified', count: 0, reason: /unauthorized_client/.test(e.message) ? adminScopeMessage(clientId) : reason(e) } } }; }
  for (const app of ['drive', 'login', 'token']) {
    try {
      const previous = state.adminCursors?.[app] || state.lastRun;
      const start = previous ? Math.min(Date.parse(previous), +now - 7 * DAY) : +now - 30 * DAY;
      const items = []; let pageToken; const pageTokens = new Set();
      do {
        const url = new URL(`https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/${app}`);
        url.search = new URLSearchParams({ startTime: new Date(start).toISOString(), endTime: now.toISOString(), maxResults: '1000', ...(pageToken ? { pageToken } : {}) });
        const j = await google.request(url, USERS[0], 'admin.reports.audit.readonly');
        if (j.items !== undefined && !Array.isArray(j.items)) throw auditError('Admin Reports: 応答形式不明');
        items.push(...j.items || []); pageToken = j.nextPageToken;
        if (pageToken && pageTokens.has(pageToken)) throw auditError('ページトークンが反復したため取得中断（不完全）');
        if (pageToken) pageTokens.add(pageToken);
      } while (pageToken);
      const result = analyzeAdmin(items, { knownOAuth, thresholds, now }); for (const finding of result.findings) findings.push(finding); knownOAuth = result.knownOAuth;
      cursors[app] = now.toISOString(); sources[`admin:${app}`] = { status: 'ok', count: items.length, reason: '7日の重複取得を含む集計。閲覧(view)をdownloadとして数えない' };
    } catch (e) { sources[`admin:${app}`] = { status: 'failed', count: 0, reason: reason(e) }; }
  }
  sources['admin:mobile'] = { status: 'unverified', count: 0, reason: 'V1はdrive/login/tokenのみ。モバイル端末監査は未対応' };
  return { findings, knownOAuth, cursors, sources };
}
