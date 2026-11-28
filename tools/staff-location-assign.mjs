#!/usr/bin/env node
// 紙・現地・郵送を誰かに割り振る前の判定。住まいと持ち場が分からない人には割り振らない。
// 一回にまとめる：出す前に同じ案件・同じ相手・同じ締切の作業（直送・控え・別送・追加署名など）を全部洗い出して1回にまとめる。分けるときは理由を書く（詳細はCLAUDE.md『一回にまとめる』）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CATALOG = path.join(HERE, '..', 'config', 'staff-locations.json');

const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s　]+/g, '');

export function loadCatalog(file = DEFAULT_CATALOG) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function findPerson(catalog, name) {
  const query = normalize(name);
  if (!query) return null;
  const people = catalog?.people || [];
  const exact = people.filter((person) => (person.names || []).some((label) => normalize(label) === query));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const includes = people.filter((person) => (person.names || []).some((label) => normalize(label).includes(query) || query.includes(normalize(label))));
  return includes.length === 1 ? includes[0] : null;
}

const LEAVE_SHOP = /郵送|発送|投函|郵便局|役所|法務局|外で.?印刷|持ち出し|受け取って|受け取り|窓口|持参|取りに行/;
const PRINT_MAIL = /印刷して郵送|印刷して発送|印刷して.*投函|印刷.*郵送/;
const LEGAL_OFFICE = /法務局|資格証明|登記事項|履歴事項/;
const WAREHOUSE = /倉庫|渋井|荷物を受け取|荷物の受取/;
const OSAKA = /大阪|東成|カフェの近く|カフェ前/;
const TOHO = /東邦鋼業/;

export function taskKind(task, location = '') {
  const text = `${task || ''} ${location || ''}`;
  if (WAREHOUSE.test(text)) return 'warehouse';
  if (LEGAL_OFFICE.test(text)) return 'legal-office';
  if (PRINT_MAIL.test(text) || (/印刷/.test(text) && /郵送|発送|投函/.test(text))) return 'print-mail';
  if (LEAVE_SHOP.test(text)) return 'leave-shop';
  return 'other-local';
}

export function areaOf(task, location = '') {
  const text = `${task || ''} ${location || ''}`;
  if (WAREHOUSE.test(text) || /川越|さいたま倉庫/.test(text)) return 'warehouse';
  if (OSAKA.test(text)) return 'osaka';
  if (/札幌|手稲/.test(text)) return 'sapporo';
  if (/豊中/.test(text)) return 'toyonaka';
  if (/さいたま市/.test(text)) return 'saitama-city';
  return 'unspecified';
}

function residenceKnown(person) {
  return person && person.residence && person.residence !== 'unknown';
}

function nearWorkplace(person, area) {
  const workplace = person?.workplace || '';
  if (area === 'osaka') return /大阪市東成区|大阪事務所/.test(workplace);
  if (area === 'warehouse') return /川越|渋井|さいたま倉庫/.test(workplace);
  return false;
}

function nearResidence(person, area) {
  const residence = person?.residence || '';
  if (area === 'toyonaka') return residence.includes('豊中市');
  if (area === 'sapporo') return residence.includes('札幌市');
  if (area === 'saitama-city') return residence.includes('さいたま市');
  if (area === 'osaka') return residence.includes('大阪市');
  if (area === 'warehouse') return residence.includes('川越市');
  return false;
}

export function evaluateAssignment({ task, location, assignee } = {}, catalog = loadCatalog()) {
  const kind = taskKind(task, location);
  const area = areaOf(task, location);
  const name = String(assignee ?? '').trim();
  if (!name) {
    return { ok: false, code: 'no-assignee', reason: '割り振る相手が指定されていない', suggested: suggest(catalog, kind, area) };
  }
  if (TOHO.test(name) || normalize(name).includes('東邦鋼業')) {
    const toho = findPerson(catalog, '東邦鋼業の社員') || catalog.people.find((p) => p.id === 'toho-kogyo-staff');
    return { ok: false, code: 'toho-kogyo', person: toho || null, reason: '東邦鋼業の社員にオージャストの業務はあまり頼めない', suggested: suggest(catalog, kind, area) };
  }
  const person = findPerson(catalog, name);
  if (!person) {
    return {
      ok: false,
      code: 'unknown-person',
      reason: `「${name}」の住まいと持ち場が一覧に無い。わからない人には紙・現地・郵送の作業を割り振らない`,
      suggested: suggest(catalog, kind, area),
    };
  }
  if (person.id === 'toho-kogyo-staff') {
    return { ok: false, code: 'toho-kogyo', person, reason: '東邦鋼業の社員にオージャストの業務はあまり頼めない', suggested: suggest(catalog, kind, area) };
  }
  if (kind === 'warehouse') {
    if (person.id === 'sawada-takeshi') return { ok: true, code: 'warehouse-staff', person, reason: 'さいたま倉庫（川越市の渋井倉庫）には澤田さんが出勤している' };
    return { ok: false, code: 'not-warehouse-staff', person, reason: `${person.names[0]}さんには倉庫での受取を割り振らない（出勤先がさいたま倉庫ではない）`, suggested: suggest(catalog, kind, area) };
  }
  const needsLeave = kind === 'print-mail' || kind === 'legal-office' || kind === 'leave-shop' || kind === 'other-local';
  if (needsLeave && person.id === 'cafe-staff') {
    return { ok: false, code: 'cafe-cannot-leave', person, reason: 'カフェのスタッフは一人で勤務しているので、店を離れる作業（郵便局、役所、外での印刷、持ち出し）は頼めない', suggested: suggest(catalog, kind, area) };
  }
  if (needsLeave && person.residence === 'unknown' && !nearWorkplace(person, area === 'unspecified' && person.id === 'nomura-natsuko' ? 'osaka' : area)) {
    // なっちゃんは持ち場がカフェ近くと確認済み。用件が大阪（または場所未指定の大阪側の印刷・郵送）なら可。
    if (person.id === 'nomura-natsuko' && (area === 'osaka' || area === 'unspecified')) {
      return { ok: true, code: 'natchan-nearby', person, reason: '近くにいて外の用事を頼めるのはなっちゃん。市区町村の書面は未確認だが、カフェ・大阪事務所近くの外の用事は頼める' };
    }
    return { ok: false, code: 'residence-unknown', person, reason: `${person.names[0]}さんの住まいが不明なため、紙・現地・郵送の作業は割り振らない。先に住まいを確かめる`, suggested: suggest(catalog, kind, area) };
  }
  if (needsLeave) {
    const osakaTask = area === 'osaka' || (area === 'unspecified' && (kind === 'print-mail' || kind === 'leave-shop'));
    if (osakaTask && person.id === 'nomura-natsuko') {
      return { ok: true, code: 'natchan-nearby', person, reason: '近くにいて外の用事を頼めるのはなっちゃん' };
    }
    if (osakaTask && !nearWorkplace(person, 'osaka') && !nearResidence(person, 'osaka')) {
      return { ok: false, code: 'too-far', person, reason: `${person.names[0]}さんの住まい・持ち場（${person.residence === 'unknown' ? person.workplace : person.residence}）は、大阪の現地作業の場所と合わない`, suggested: suggest(catalog, kind, area) };
    }
    if (area !== 'unspecified' && !nearWorkplace(person, area) && !nearResidence(person, area)) {
      return { ok: false, code: 'too-far', person, reason: `${person.names[0]}さんの住まい・持ち場は、その現地作業の場所と合わない`, suggested: suggest(catalog, kind, area) };
    }
  }
  if (needsLeave && residenceKnown(person) && (nearResidence(person, area) || area === 'unspecified')) {
    if (area === 'unspecified' && !nearWorkplace(person, 'osaka')) {
      return { ok: false, code: 'area-unspecified', person, reason: '現地作業の場所が分からないまま割り振らない。先に場所を確かめ、住まい・持ち場と照らす', suggested: suggest(catalog, kind, area) };
    }
    return { ok: true, code: 'residence-near', person, reason: `住まい（${person.residence}）が用件の場所と合っている` };
  }
  if (needsLeave && nearWorkplace(person, area)) {
    return { ok: true, code: 'workplace-near', person, reason: `持ち場（${person.workplace}）が用件の場所と合っている` };
  }
  return { ok: false, code: 'not-allowed', person, reason: 'この人には、その紙・現地・郵送の作業を割り振れない', suggested: suggest(catalog, kind, area) };
}

export function suggest(catalog, kind, area) {
  const names = [];
  if (kind === 'warehouse' || area === 'warehouse') names.push('澤田武');
  if (area === 'osaka' || kind === 'print-mail' || kind === 'leave-shop' || (kind === 'legal-office' && (area === 'osaka' || area === 'unspecified'))) names.push('なっちゃん');
  return [...new Set(names)];
}

export const CASES = [
  { id: 'A', title: '書類を印刷して郵送して', task: '書類を印刷して郵送して', location: '大阪', assignee: 'カフェスタッフ', expect: { ok: false, code: 'cafe-cannot-leave' } },
  { id: 'A2', title: '書類を印刷して郵送して（なっちゃん）', task: '書類を印刷して郵送して', location: '大阪', assignee: 'なっちゃん', expect: { ok: true, code: 'natchan-nearby' } },
  { id: 'B', title: '法務局で証明書を取って', task: '法務局で証明書を取って', location: '大阪', assignee: '田中歩', expect: { ok: false, code: 'residence-unknown' } },
  { id: 'C', title: '倉庫で荷物を受け取って', task: '倉庫で荷物を受け取って', location: '', assignee: '澤田さん', expect: { ok: true, code: 'warehouse-staff' } },
  { id: 'C2', title: '倉庫で荷物を受け取って（カフェスタッフ）', task: '倉庫で荷物を受け取って', location: '', assignee: 'カフェスタッフ', expect: { ok: false, code: 'not-warehouse-staff' } },
  { id: 'D', title: '大阪の郵便局で発送（佐藤優奈）', task: '大阪の郵便局で発送して', location: '大阪', assignee: '佐藤優奈', expect: { ok: false, code: 'too-far' } },
  { id: 'E', title: '住まい不明の人に現地作業', task: '近くの郵便局で投函して', location: '', assignee: '田中歩', expect: { ok: false, code: 'residence-unknown' } },
  { id: 'F', title: '東邦鋼業の社員にオージャストの郵送', task: '書類を印刷して郵送して', location: '大阪', assignee: '東邦鋼業の社員', expect: { ok: false, code: 'toho-kogyo' } },
];

export function runCases(catalog = loadCatalog()) {
  return CASES.map((item) => {
    const result = evaluateAssignment({ task: item.task, location: item.location, assignee: item.assignee }, catalog);
    const pass = result.ok === item.expect.ok && result.code === item.expect.code;
    return { id: item.id, title: item.title, pass, expected: item.expect, result: { ok: result.ok, code: result.code, reason: result.reason, suggested: result.suggested } };
  });
}

if (isEntry(import.meta.url)) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'evaluate') {
    const jsonFlag = rest.indexOf('--json');
    const raw = jsonFlag >= 0 ? rest[jsonFlag + 1] : rest.join(' ');
    const input = raw.startsWith('{') ? JSON.parse(raw) : { task: raw, assignee: rest[0] };
    console.log(JSON.stringify(evaluateAssignment(input), null, 2));
    process.exit(0);
  }
  if (cmd === 'test' || cmd === 'selftest' || !cmd) {
    const rows = runCases();
    const failed = rows.filter((row) => !row.pass);
    for (const row of rows) {
      console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.id} ${row.title} → ok=${row.result.ok} code=${row.result.code}`);
      if (!row.pass) console.log('  expected', row.expected, 'got', { ok: row.result.ok, code: row.result.code, reason: row.result.reason });
    }
    console.log(failed.length ? `FAILED ${failed.length}/${rows.length}` : `ALL ${rows.length} PASSED`);
    process.exit(failed.length ? 1 : 0);
  }
  console.error('usage: staff-location-assign.mjs evaluate --json \'<依頼.json>\' | test');
  process.exit(2);
}
