import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVICE_PAGES, addGuideEntry, appendInternalLinks, emptyLedger, generateSlug, isKeywordCovered, loadLedger, parseArgs, parseGscCsv, parseGscJson, run, saveLedger, selectKeyword } from './daily-seo-guide.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daily-seo-guide-'));
describe('daily-seo-guide', () => {
  it('英語・日本語ヘッダーのGSC CSVを解析する', () => {
    assert.deepEqual(parseGscCsv('query,impressions,clicks,ctr,position\n"booth, design","1,000",10,1%,20')[0], { query: 'booth, design', impressions: 1000, clicks: 10, ctr: .01, position: 20 });
    assert.deepEqual(parseGscCsv('\uFEFFクエリ,表示回数,クリック数,CTR,掲載順位\n展示会 ブース,500,5,1%,12.5')[0], { query: '展示会 ブース', impressions: 500, clicks: 5, ctr: .01, position: 12.5 });
  });
  it('gsc-keyword-finder形式のJSONを解析する', () => assert.deepEqual(parseGscJson({ candidates: [{ query: '展示会', impressions: 200, clicks: 4, ctr: .02, position: 30 }] })[0], { query: '展示会', impressions: 200, clicks: 4, ctr: .02, position: 30 }));
  it('展示会関連候補を優先する', () => {
    const rows = [{ query: '無関係', impressions: 999999, ctr: 0, position: 1 }, { query: '展示会 ブース', impressions: 1000, ctr: 0, position: 20 }];
    assert.equal(selectKeyword(rows, emptyLedger(), { random: () => 0 }).query, '展示会 ブース');
  });
  it('重複を部分一致で除外し、全カバーならnullにする', () => {
    const ledger = { ...emptyLedger(), coveredKeywords: ['展示会 ブース デザイン'] };
    assert.equal(isKeywordCovered(ledger, 'ブース デザイン'), true);
    assert.equal(selectKeyword([{ query: '展示会 ブース', impressions: 1, ctr: 0, position: 1 }], ledger), null);
    assert.ok(selectKeyword([{ query: '展示会 ブース', impressions: 1, ctr: 0, position: 1 }], ledger, { force: true }));
  });
  it('日本語キーワードをslugにする', () => { assert.equal(generateSlug('1小間ブース デザイン 予算'), '1-koma-booth-design-budget'); assert.ok(generateSlug('展示会'.repeat(30)).length <= 40); });
  it('内部リンクとCTAを挿入する', () => { const v = appendInternalLinks('# 本文', DEFAULT_SERVICE_PAGES, '1小間ブース デザイン'); assert.match(v, /small-booth/); assert.match(v, /booth\/design/); assert.match(v, /お問い合わせはこちら.*contact/s); });
  it('レジャーを保存・読込し、破損時は初期化する', () => { const file = path.join(temp(), 'ledger.json'); const ledger = emptyLedger(); addGuideEntry(ledger, { keyword: '展示会' }); saveLedger(file, ledger); assert.equal(loadLedger(file).guides.length, 1); fs.writeFileSync(file, '{broken'); const warnings = []; assert.equal(loadLedger(file, { warn: (v) => warnings.push(v) }).guides.length, 0); assert.equal(warnings.length, 1); });
  it('CLI引数の不足・競合を拒否する', () => { const v = parseArgs(['--keyword', '展示会', '--dry-run', '--force']); assert.equal(v.dryRun, true); assert.equal(v.force, true); assert.throws(() => parseArgs([]), /いずれか/); assert.throws(() => parseArgs(['--gsc-json', 'a', '--gsc-csv', 'b']), /同時/); });
  it('dry-runではAIもファイル出力も行わない', async () => { const dir = temp(); let called = false; const v = await run(['--keyword', '展示会 ブース', '--output-dir', dir, '--dry-run'], { random: () => 0, generateWithFallback: () => { called = true; } }); assert.equal(v.dryRun, true); assert.equal(called, false); assert.equal(fs.existsSync(path.join(dir, 'guides')), false); });
  it('ガイドとレジャーを生成する', async () => { const dir = temp(); const v = await run(['--keyword', '1小間ブース デザイン', '--output-dir', dir], { random: () => 0, now: new Date('2026-11-10T00:00:00Z'), generateWithFallback: () => ({ content: '# テスト\n\n本文', provider: 'gemini' }) }); assert.equal(path.basename(v.outputPath), '2026-11-10-1-koma-booth-design.md'); assert.match(fs.readFileSync(v.outputPath, 'utf8'), /provider: gemini/); assert.equal(loadLedger(path.join(dir, 'ledger.json')).coveredKeywords[0], '1小間ブース デザイン'); });
  it('全カバー時のCLIメッセージを表示する', () => { const dir = temp(); const ledger = path.join(dir, 'ledger.json'); saveLedger(ledger, { ...emptyLedger(), coveredKeywords: ['展示会 ブース'] }); const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daily-seo-guide.mjs'); const v = spawnSync(process.execPath, [script, '--keyword', '展示会 ブース', '--ledger', ledger, '--output-dir', dir], { encoding: 'utf8' }); assert.equal(v.status, 0, v.stderr); assert.match(v.stdout, /すべての候補をカバー済み/); });
});
