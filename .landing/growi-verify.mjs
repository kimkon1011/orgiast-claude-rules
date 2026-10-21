import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loginGrowi, growiApiCsrf, resolveGrowiPage } from '../tools/growi-manual.mjs';

const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.claude', 'growi.env'), 'utf8')
  .split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const http = await loginGrowi({ baseUrl: env.GROWI_BASE_URL, user: env.GROWI_USER, password: env.GROWI_PASS });
const targets = [
  ['/33:クライアント情報/【医学会併設企業展示コーディネート事業部】学会開催（親ページ）/学会制作チーム（親ページ）/学会に必要な印刷物について/【学会】運営マニュアルの作り方/【学会】スタッフシート/スタッフシートの仮記入', 'ディレクター：開始1時間前に集合', 'growi-p1-insert.txt'],
  ['/31:イベントマニュアル/【06第4フェーズ実施期間：７日前】当日進行スタッフへの連絡事項', '【搬入出許可証に記載されている搬入口があれば記載・なければブースから一番近い搬入口を記載】', 'growi-p2-insert.txt'],
];
// Part キャッシュ（追記前の本文）と、現行本文から追記行を除いたものを行単位で比較
for (const [p, anchor, file] of targets) {
  const page = await resolveGrowiPage(env.GROWI_BASE_URL, http, p);
  const lines = page.revision.body.split('\n');
  const ins = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8').replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const a = lines.findIndex(l => l.includes(anchor));
  const norm = l => l.trim();
  const stripped = lines.filter((l, i) => !(i > a && i <= a + ins.length)).map(norm).filter(Boolean);
  let cached = '';
  try { cached = execFileSync('node', [path.join(import.meta.dirname, '../tools/growi-manual.mjs'), 'get', p], { encoding: 'utf8' }); } catch (e) { console.log('cache get failed', e.message.slice(0, 200)); continue; }
  const cset = cached.replace(/\r/g, '').split('\n').map(norm).filter(Boolean);
  const cs = new Set(cset);
  const ss = new Set(stripped);
  const onlyCurrent = stripped.filter(l => !cs.has(l));
  const onlyCache = cset.filter(l => !ss.has(l));
  console.log(JSON.stringify({ path: p.slice(0, 30), cacheLines: cset.length, cacheHasInsert: ins.some(l => cs.has(norm(l))), onlyInCurrentMinusInsert: onlyCurrent.length, onlyInCache: onlyCache.length, sampleCurrent: onlyCurrent.slice(0, 3), sampleCache: onlyCache.slice(0, 5) }));
}
