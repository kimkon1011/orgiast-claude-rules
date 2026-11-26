import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoDir } from './gate-contracts.mjs';

const required = [
  '有料を先に推奨しない',
  '無料候補の検証表',
  '往復せず1回で報告',
  '推測を原因と断言',
  '古い下書き・空ファイル・重複',
  '承認は社外影響と不可逆',
  '金さんへの文面は日本語',
  '頼む前に直す',
  '承認ダイアログが何度も出る',
  '000の op CLI のデスクトップ連携',
  '得になる機能（自動更新など）は止めない',
];

const onboardingOnly = [
  '有料の選択肢（有料相談・有料プラン・課金・購入）',
  '最初から有料を推奨にするのは誤り',
  '途中の確認や報告で往復させず',
  '推測を原因として言い切らない',
  '金さんへの文面は必ず日本語にする',
  '原因が分かっているものは、金さんに作業を頼む前にAI側で先に直す',
  '困りごとを直すために、金さんの得になる機能（自動更新など）を止めない',
];

function read(rel) {
  return fs.readFileSync(path.join(repoDir, rel), 'utf8');
}

test('ONBOARDING.md has the 2026-11-19 recurrence rules', () => {
  const text = read('ONBOARDING.md');
  for (const phrase of required) assert.ok(text.includes(phrase), phrase);
  for (const phrase of onboardingOnly) assert.ok(text.includes(phrase), phrase);
});

test('CLAUDE.md.template distributes the 2026-11-19 recurrence summary', () => {
  const text = read('CLAUDE.md.template');
  for (const phrase of required) assert.ok(text.includes(phrase), phrase);
});