import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginGrowi, growiApiCsrf, resolveGrowiPage } from '../tools/growi-manual.mjs';

const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.claude', 'growi.env'), 'utf8')
  .split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const http = await loginGrowi({ baseUrl: env.GROWI_BASE_URL, user: env.GROWI_USER, password: env.GROWI_PASS });
await growiApiCsrf(env.GROWI_BASE_URL, http);
const targets = [
  ['/33:クライアント情報/【医学会併設企業展示コーディネート事業部】学会開催（親ページ）/学会制作チーム（親ページ）/学会に必要な印刷物について/【学会】運営マニュアルの作り方/【学会】スタッフシート/スタッフシートの仮記入', 'ディレクター：開始1時間前に集合', 'growi-p1-insert.txt'],
  ['/31:イベントマニュアル/【06第4フェーズ実施期間：７日前】当日進行スタッフへの連絡事項', '【搬入出許可証に記載されている搬入口があれば記載・なければブースから一番近い搬入口を記載】', 'growi-p2-insert.txt'],
];
for (const [p, anchor, file] of targets) {
  const page = await resolveGrowiPage(env.GROWI_BASE_URL, http, p);
  const body = page.revision.body;
  const lines = body.split('\n');
  const ins = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8').replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const a = lines.flatMap((l, i) => l.includes(anchor) ? [i] : []);
  const occ = lines.filter(l => ins.includes(l)).length;
  const exact = a.length === 1 && ins.every((l, k) => lines[a[0] + 1 + k] === l);
  // 追記以外の差分: 追記行を除いた本文と、追記前リビジョンの本文を比較
  const revs = await (await http(`${env.GROWI_BASE_URL}/_api/v3/revisions/list?pageId=${page._id}&limit=5`)).json().catch(() => null);
  console.log(JSON.stringify({ path: p, revision: page.revision._id, updatedAt: page.updatedAt, anchorLines: a.map(i => i + 1), insertedExactlyAfterAnchor: exact, insertedLineOccurrences: occ, totalLines: lines.length }));
  for (let i = Math.max(0, a[0] - 1); i <= Math.min(lines.length - 1, a[0] + ins.length + 1); i++) console.log(`${i + 1}: ${lines[i]}`);
  const list = revs?.revisions ?? revs?.docs ?? [];
  console.log('revisions:', list.slice(0, 3).map(r => `${r._id} ${r.createdAt}`).join(' | '));
  if (list.length >= 2) {
    const prevId = list.find(r => r._id !== page.revision._id)?._id;
    const prev = await (await http(`${env.GROWI_BASE_URL}/_api/v3/revisions/${prevId}?pageId=${page._id}`)).json().catch(() => null);
    const prevBody = prev?.revision?.body;
    if (typeof prevBody === 'string') {
      const stripped = lines.filter((l, i) => !(i > a[0] && i <= a[0] + ins.length)).join('\n');
      console.log('prevRevision', prevId, 'bodyEqualsCurrentMinusInsert:', stripped === prevBody, 'prevHasInsert:', ins.every(l => prevBody.split('\n').includes(l)));
    }
  }
}
