import test from 'node:test'; import assert from 'node:assert/strict';
import { gateOptions, arrivalOf } from './lib/deadline-gate.mjs';
import { consolidate } from './lib/visit-consolidate-core.mjs';
import { loadOffices } from './visit-consolidate.mjs';

const src = '公式ページ 2026-11-27 確認';
test('期限の根拠が無ければ選択肢を1つも出さない', () => {
  const r = gateOptions({ deadline: '2026-12-02', today: '2026-11-27', options: [{ name: 'ネット請求', steps: [{ label: '郵送', days: 2, source: src }] }] });
  assert.equal(r.ok, false); assert.equal(r.allowed.length, 0);
});
test('再発事例：資格証明書をネット請求→事務所着→裁判所へ送り直しは12/2必着に間に合わないので出さない', () => {
  const r = gateOptions({ deadline: '2026-12-02', deadlineSource: '書記官確認 2026-11-25', today: '2026-11-27', options: [
    { name: 'ネット請求で郵送受取→裁判所へ再送', steps: [{ label: '法務局の発送', days: 1, source: src }, { label: '事務所に届く', days: 2, source: src }, { label: '裁判所へ再送', days: 1, source: src }] },
    { name: '11/30朝に窓口で取得→当日レターパックプラス', visit: true, start: '2026-11-30', steps: [{ label: '窓口で即日', days: 0, source: src }, { label: 'レターパックプラス', days: 1, source: src }] },
  ] });
  assert.ok(r.rejected.some(o => o.name.startsWith('ネット請求')));
  assert.equal(r.allowed.map(o => o.name).join(), '11/30朝に窓口で取得→当日レターパックプラス');
  assert.match(r.note, /visit-consolidate/);
});
test('所要日数に根拠が無い手順を含む選択肢は出さない（言い切り防止）', () => {
  const r = gateOptions({ deadline: '2026-12-20', deadlineSource: 'x', today: '2026-11-27', options: [{ name: 'A', steps: [{ label: '郵送', days: 2 }] }] });
  assert.equal(r.allowed.length, 0); assert.match(r.rejected[0].why, /未確認/);
});
test('訪問なしで間に合う道があれば、訪問ありは推奨にしない', () => {
  const r = gateOptions({ deadline: '2026-12-20', deadlineSource: 'x', today: '2026-11-27', options: [
    { name: '窓口', visit: true, cost: 600, steps: [{ label: '即日', days: 0, source: src }] },
    { name: 'オンライン', cost: 500, steps: [{ label: '郵送', days: 3, source: src }] }] });
  assert.equal(r.recommend, 'オンライン');
});
test('営業日で数える（土日祝を飛ばす）', () => {
  assert.equal(arrivalOf('2026-11-27', [{ days: 1, source: src }]), '2026-11-30');
});
test('訪問予定を全案件の同じ窓口の用事と突き合わせる（11/21登記の再発事例）', () => {
  const rows = [
    { id: 'V1', title: '役員変更登記を法務局窓口へ申請', notes: '訪問:2026-11-21@法務局', status: '未着手', due: '2026-11-21', kind: '訴訟・法務' },
    { id: 'D1', title: '労働審判 資格証明書（登記事項証明書・登記完了後に取得）', status: '未着手', due: '', kind: '訴訟・法務' },
    { id: 'D2', title: '住民票の取得', status: '未着手', due: '2026-12-10' },
  ];
  const r = consolidate(rows, { ...loadOffices(), today: '2026-11-20' });
  const v = r.visitPlans.find(p => p.id === 'V1');
  assert.deepEqual(v.bundle.map(b => b.id), ['D1']);
  assert.ok(v.avoid.some(a => /オンライン/.test(a)));
  assert.ok(r.unscheduled.some(u => u.id === 'D1'));
});

import fs from 'node:fs';
import { grade, buildPrompt, parseAnswers } from './deadline-visit-selftest.mjs';
const cases = JSON.parse(fs.readFileSync(new URL('../tests/deadline-visit/cases.json', import.meta.url), 'utf8'));
test('自己テスト：模範解答は全件合格し、再発時の答え（12/9に間に合う見込みでネット請求を出す）は不合格になる', () => {
  const good = cases.map(c => {
    const allowed = { C01: ['window'], C02: ['kakitome', 'sokutatsu'], C03: ['egov'], C04: ['lp'], C05: ['window'], C06: ['yuso'], C07: ['etax'], C08: ['web'], C09: ['lp', 'sokutatsu'], C10: ['net'], C11: ['online', 'yuso'], C12: [], C13: ['denshi'], C14: ['window'], C15: ['etax', 'yuso'], C16: [], C17: ['sokutatsu', 'lp'], C18: ['oss'] }[c.id];
    return { id: c.id, deadline: c.deadline, deadline_source: c.deadline ? '記録' : '', presented_options: allowed, recommended: allowed[0] || null, visit_consolidation: { considered: true, bundled: c.mustBundle, avoid_routes: ['オンライン請求'] } };
  });
  assert.equal(grade(cases, good).pass, true, JSON.stringify(grade(cases, good).results.filter(r => !r.pass)));
  const bad = good.map(a => a.id === 'C01' ? { ...a, deadline: '2026-12-09', presented_options: ['net', 'window'], recommended: 'net', visit_consolidation: { considered: false } } : a);
  const g = grade(cases, bad);
  assert.equal(g.pass, false);
  assert.ok(g.counts.期限未確認 >= 1 && g.counts.間に合わない選択肢 >= 1 && g.counts.訪問集約漏れ >= 1);
  assert.match(buildPrompt(cases), /【テスト・送信禁止】/);
  assert.equal(parseAnswers('x\n```json\n[{"id":"C01"}]\n```').length, 1);
});
