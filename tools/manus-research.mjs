// manus-research.mjs — Web調査/属性エンリッチを Manus(専用枠)へ委譲する CLIヘルパー。
// 目的: ClaudeがWeb検索で従量トークンを燃やす代わりに、多段Web調査+根拠URLをManusに任せてコストを下げる(§1.13)。
// 使い方: node manus-research.mjs "調べたいこと(1行)"
//   例: node manus-research.mjs "株式会社サンプルの設立年月日と上場有無を、公式サイト等の根拠URL付きで"
// 認証: MANUS_API_KEY (env もしくは ~/.claude/manus.env の MANUS_API_KEY=)。
// 動作: POST /v1/tasks で作成 → GET /v1/tasks/{id} を完了までポーリング → assistant出力を表示。
//   --json 出力に task_url も含める。--timeout <秒>(既定360)。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const BASE = 'https://api.manus.ai';

function loadKey() {
  if (process.env.MANUS_API_KEY) return process.env.MANUS_API_KEY;
  try {
    const f = path.join(os.homedir(), '.claude', 'manus.env');
    for (const line of fs.readFileSync(f, 'utf-8').split(/\r?\n/)) {
      if (line.startsWith('MANUS_API_KEY=')) return line.slice('MANUS_API_KEY='.length).trim();
    }
  } catch { /* none */ }
  return '';
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
let timeout = 360;
const ti = args.indexOf('--timeout'); if (ti >= 0 && args[ti + 1]) { timeout = parseInt(args[ti + 1], 10) || 360; }
const prompt = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--timeout')).join(' ').trim();

const KEY = loadKey();
if (!KEY) { console.error('MANUS_API_KEY 未設定 (~/.claude/manus.env に MANUS_API_KEY= を置くか環境変数で)'); process.exit(2); }
if (!prompt) { console.error('使い方: node manus-research.mjs "調べたいこと"'); process.exit(2); }

const H = { API_KEY: KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(task) {
  const texts = [];
  for (const o of task.output ?? []) {
    if (o.role && o.role !== 'assistant') continue;
    for (const c of o.content ?? []) if (c.text) texts.push(c.text);
  }
  return texts.join('\n').trim();
}

(async () => {
  let id, url;
  try {
    const r = await fetch(`${BASE}/v1/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ prompt }) });
    if (!r.ok) { console.error(`Manus create失敗 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`); process.exit(1); }
    const d = await r.json();
    id = d.task_id ?? d.id; url = d.task_url;
    if (!id) { console.error('task_id取得不可'); process.exit(1); }
    console.error(`[manus] タスク作成 id=${id} url=${url ?? ''} (完了までポーリング…)`);
  } catch (e) { console.error('Manus create例外:', e.message); process.exit(1); }

  const start = Date.now();
  let interval = 8000;
  while ((Date.now() - start) / 1000 < timeout) {
    await sleep(interval);
    interval = Math.min(interval + 2000, 20000);
    try {
      const r = await fetch(`${BASE}/v1/tasks/${id}`, { headers: { API_KEY: KEY } });
      if (!r.ok) { continue; }
      const t = await r.json();
      const st = String(t.status || '').toLowerCase();
      if (st === 'completed' || st === 'stopped' || st === 'failed' || st === 'succeeded') {
        const text = extractText(t);
        if (asJson) console.log(JSON.stringify({ id, url, status: st, text }));
        else { console.log(text || '(出力なし)'); console.error(`[manus] status=${st} url=${url ?? ''}`); }
        process.exit(0);
      }
    } catch { /* retry */ }
  }
  console.error(`[manus] タイムアウト(${timeout}s)。まだ実行中。後で確認: ${url ?? ('タスクID ' + id)}`);
  process.exit(3);
})();
