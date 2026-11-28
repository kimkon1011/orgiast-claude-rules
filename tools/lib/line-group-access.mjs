// Credentials and group lookup shared by history readers and senders.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const SALES_PROJECT = 'aujust-sales-automation';
const KEYS = ['LINE_CHANNEL_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^(?:export\s+)?([A-Z_0-9]+)\s*=\s*"?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

async function fetchFromVercel(home) {
  const token = readEnvFile(path.join(home, '.claude', 'vercel.env')).VERCEL_TOKEN;
  if (!token) throw new Error('LINE の鍵がありません: env / ~/.claude/line-send.env / ~/.claude/vercel.env(VERCEL_TOKEN) のどれにも無い');
  const H = { Authorization: `Bearer ${token}` };
  const projects = await (await fetch(`https://api.vercel.com/v9/projects?search=${SALES_PROJECT}&limit=5`, { headers: H })).json();
  const proj = (projects.projects || []).find((p) => p.name === SALES_PROJECT);
  if (!proj) throw new Error(`Vercel に ${SALES_PROJECT} が見つからない: ${JSON.stringify(projects).slice(0, 200)}`);
  const list = await (await fetch(`https://api.vercel.com/v10/projects/${proj.id}/env`, { headers: H })).json();
  const want = { LINE_CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN', SUPABASE_URL: 'NEXT_PUBLIC_SUPABASE_URL', SUPABASE_SERVICE_ROLE_KEY: 'SUPABASE_SERVICE_ROLE_KEY' };
  const out = {};
  for (const [dst, src] of Object.entries(want)) {
    const e = (list.envs || []).find((x) => x.key === src && (x.target || []).includes('development'));
    if (!e) continue;
    const one = await (await fetch(`https://api.vercel.com/v1/projects/${proj.id}/env/${e.id}`, { headers: H })).json();
    if (one.value) out[dst] = one.value;
  }
  return out;
}

export async function loadSecrets({ env = process.env, home = homedir() } = {}) {
  const file = path.join(home, '.claude', 'line-send.env');
  const s = { ...readEnvFile(file) };
  for (const k of KEYS) if (env[k]) s[k] = env[k];
  if (KEYS.every((k) => s[k])) return s;
  Object.assign(s, await fetchFromVercel(home), Object.fromEntries(KEYS.filter((k) => env[k]).map((k) => [k, env[k]])));
  if (!s.LINE_CHANNEL_ACCESS_TOKEN) throw new Error('LINE_CHANNEL_ACCESS_TOKEN を取得できなかった');
  writeFileSync(file, `${KEYS.filter((k) => s[k]).map((k) => `${k}=${s[k]}`).join('\n')}\n`, { mode: 0o600 });
  return s;
}

const sbHeaders = (s) => ({ apikey: s.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${s.SUPABASE_SERVICE_ROLE_KEY}` });

export function normalizeGroupName(name) {
  return name.normalize('NFKC')
    .replace(/[×✕✖xX]/g, '×')
    .replace(/[ \u3000]/g, '');
}

const groupNameFromSubject = (subject) => subject.replace(/^LINE:\s*/, '');

export async function resolveGroup(s, group) {
  if (/^C[0-9a-f]{32}$/.test(group)) return group;
  if (!s.SUPABASE_URL) throw new Error('グループ名から ID を引くには SUPABASE_URL が必要。groupId（C で始まる33文字）で指定してください');
  const url = `${s.SUPABASE_URL}/rest/v1/channel_messages?select=external_thread_id,subject&channel=eq.line&subject=eq.${encodeURIComponent(`LINE: ${group}`)}&order=created_at.desc&limit=1`;
  const rows = await (await fetch(url, { headers: sbHeaders(s) })).json();
  if (Array.isArray(rows) && rows[0]) {
    console.error(`グループ名を『${groupNameFromSubject(rows[0].subject)}』に解決しました`);
    return rows[0].external_thread_id;
  }

  const listUrl = `${s.SUPABASE_URL}/rest/v1/channel_messages?select=external_thread_id,subject&channel=eq.line&order=created_at.desc&limit=500`;
  const recent = await (await fetch(listUrl, { headers: sbHeaders(s) })).json();
  const unique = Array.isArray(recent)
    ? [...new Map(recent.filter((row) => row.subject && row.external_thread_id)
      .map((row) => [row.subject, row])).values()]
    : [];
  const wanted = normalizeGroupName(group);
  const matched = unique.find((row) => normalizeGroupName(groupNameFromSubject(row.subject)) === wanted);
  if (matched) {
    console.error(`グループ名を『${groupNameFromSubject(matched.subject)}』に解決しました`);
    return matched.external_thread_id;
  }

  const suggestions = unique
    .filter((row) => {
      const candidate = normalizeGroupName(groupNameFromSubject(row.subject));
      return candidate.includes(wanted) || wanted.includes(candidate);
    })
    .slice(0, 5)
    .map((row) => groupNameFromSubject(row.subject));
  const hint = suggestions.length ? `\nもしかして: ${suggestions.join('、')}` : '';
  throw new Error(`グループ「${group}」が受信記録（channel_messages）に無い。bot が未参加か名前違い${hint}`);
}
