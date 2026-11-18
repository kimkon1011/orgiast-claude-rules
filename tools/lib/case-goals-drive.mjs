import { gwsFetch, GWS_MARKER } from './gws-proxy.mjs';
import { ensureKimEditor } from './kim-editor.mjs';
import { goalHome, goalsPath, loadGoals, validateGoals, writeJson } from './case-goals.mjs';

const HUB = '1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw';
const ROOT = 'https://www.googleapis.com';
const snapshotName = /^GOALS\.[a-f0-9-]{36}\.json$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Drive v3/proxy does not preserve conditional-write headers. Keep immutable
// revisions as the source of truth; GOALS.json is a readable projection. A
// concurrent branch is never silently overwritten, even if the projection races.
export function newestGoals(versions, caseId) {
  const unique = new Map();
  for (const raw of versions.filter(Boolean)) {
    const data = validateGoals(raw, caseId), old = unique.get(data.revision);
    if (old && !same(old, data)) throw Error('GOAL-SYNC: 同じrevisionの内容が一致しません');
    unique.set(data.revision, data);
  }
  const rows = [...unique.values()];
  if (!rows.length) return null;
  const heads = rows.filter(row => !rows.some(other => other.ancestors.includes(row.revision)));
  if (heads.length !== 1) throw Error('GOAL-SYNC: 複数席の同時更新が競合しました。GOALS.jsonとDriveのGOALS.<revision>.jsonを保持し、目標・承認履歴を照合してください');
  const head = heads[0];
  for (const old of rows.filter(x => x !== head)) {
    for (const before of old.goals) {
      const after = head.goals.find(g => g.metric === before.metric);
      if (!after || !same(after.history.slice(0, before.history.length), before.history)) throw Error('GOAL-SYNC: 過去の目標・承認履歴を消す更新は同期できません');
    }
  }
  return head;
}

export async function syncGoals(caseId, { home = goalHome(), fetchImpl = gwsFetch, ensureEditor = ensureKimEditor } = {}) {
  const local = loadGoals(caseId, home);
  async function request(endpoint, options = {}) {
    const response = await fetchImpl(`${ROOT}${endpoint}`, { ...options, signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${GWS_MARKER}`, ...options.headers } }, { home });
    if (!response.ok) throw Error(`GOAL-SYNC: Drive HTTP ${response.status}`);
    return response;
  }
  async function list(parent) {
    let page = '', files = [];
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
      const result = await (await request(`/drive/v3/files?q=${q}&fields=files(id,name,mimeType),nextPageToken&pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`)).json();
      files.push(...(result.files || [])); page = result.nextPageToken || '';
    } while (page);
    return files;
  }
  function single(files, name) {
    const matches = files.filter(f => f.name === name);
    if (matches.length > 1) throw Error(`GOAL-SYNC: Driveで${name}が重複しています`);
    return matches[0];
  }
  const root = single(await list(HUB), 'case-sessions');
  if (!root) throw Error('GOAL-SYNC: Driveハブのcase-sessionsがありません');
  const folder = single(await list(root.id), caseId);
  if (!folder) {
    if (local) throw Error(`GOAL-SYNC: case-handoff bind ${caseId} でDrive案件フォルダを先に用意してください`);
    return null;
  }
  async function readVersions(files) {
    return Promise.all(files.filter(f => f.name === 'GOALS.json' || snapshotName.test(f.name)).map(async f => {
      const data = await (await request(`/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`)).json();
      validateGoals(data, caseId);
      if (snapshotName.test(f.name) && f.name !== `GOALS.${data.revision}.json`) throw Error('GOAL-SYNC: revision filename mismatch');
      return data;
    }));
  }
  async function upload(name, data, file) {
    if (file) {
      await request(`/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(data) });
    } else {
      const boundary = `goal-${data.revision}`;
      const metadata = { name, parents: [folder.id], mimeType: 'application/json' };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(data)}\r\n--${boundary}--`;
      file = await (await request('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
    }
    await ensureEditor(file.id, { token: GWS_MARKER, api: async (_token, url, options) => request(url.slice(ROOT.length), options), created: true });
    const readBack = await (await request(`/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`)).json();
    if (!same(data, readBack)) throw Error('GOAL-SYNC: Drive読み戻し不一致');
    return file;
  }
  let files = await list(folder.id);
  let head = newestGoals([local, ...await readVersions(files)], caseId);
  if (!head) return null;
  const name = `GOALS.${head.revision}.json`;
  if (!files.some(f => f.name === name)) await upload(name, head);
  // Re-list after creation: simultaneous updates remain in immutable files and
  // must be reconciled, never converted to last-writer-wins.
  files = await list(folder.id);
  head = newestGoals([head, ...await readVersions(files)], caseId);
  const canonical = single(files, 'GOALS.json');
  const current = canonical ? await (await request(`/drive/v3/files/${canonical.id}?alt=media`)).json() : null;
  if (!same(current, head)) await upload('GOALS.json', head, canonical);
  // Do not overwrite a local edit made while network calls were in flight.
  const latestLocal = loadGoals(caseId, home);
  if (!same(local, latestLocal)) throw Error('GOAL-SYNC: 同期中にローカルが更新されました。再試行してください');
  writeJson(goalsPath(caseId, home), head);
  return head;
}
