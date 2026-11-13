#!/usr/bin/env node
/**
 * Dry-run 統合テスト
 *
 * Phase1〜4 を --dry-run モードで実行し、出力が SKILL.md の定義と整合することを確認する。
 * ネットワークを使用せず、test/fixtures/ の固定サンプルから全 Phase を通す。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILL_MD_PATH = path.join(ROOT, 'SKILL.md');
const PHASES = {
  phase1: path.join(ROOT, 'process', 'phase1-crawl.mjs'),
  phase2: path.join(ROOT, 'process', 'phase2-collect.mjs'),
  phase3: path.join(ROOT, 'process', 'phase3-score.mjs'),
  phase4: path.join(ROOT, 'process', 'phase4-propose.mjs'),
};

/** 子プロセスで phase を実行し、stdout/stderr を返す */
function runPhase(phaseScript, outdir) {
  const stdout = execSync(`node "${phaseScript}" --dry-run "${outdir}"`, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
  });
  return stdout;
}

/** SKILL.md の出力テーブル行から CSV 列定義を抽出 */
function parseCsvHeaderFromSkillMd() {
  const md = fs.readFileSync(SKILL_MD_PATH, 'utf-8');
  const line = md.split('\n').find(l => l.includes('keywords-priority.csv') && l.includes('（'));
  if (!line) throw new Error('keywords-priority.csv table row not found in SKILL.md');
  const match = line.match(/[（(]([^）)]+)[）)]/);
  if (!match) throw new Error('Could not extract column list from SKILL.md');
  return match[1].split(',').map(s => s.trim());
}

/** CSV のヘッダ行をパースする */
function parseCsvHeader(csvPath) {
  const firstLine = fs.readFileSync(csvPath, 'utf-8').split('\n')[0];
  return firstLine.split(',').map(s => s.trim());
}

/** CSV の全行（ヘッダ除く）をパースして配列で返す */
function parseCsvData(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const header = lines[0].split(',').map(s => s.trim());
  const rows = lines.slice(1).filter(Boolean).map(line => {
    const vals = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = vals[i]; });
    return row;
  });
  return rows;
}

describe('booth-kw-research dry-run pipeline', () => {
  let outdir;

  it('should create a temp output directory', () => {
    outdir = mkdtempSync(path.join(os.tmpdir(), 'kw-test-'));
    assert.ok(fs.existsSync(outdir));
  });

  it('Phase1: dry-run should produce crawl-results.json', () => {
    const out = runPhase(PHASES.phase1, outdir);
    const outPath = path.join(outdir, 'crawl-results.json');
    assert.ok(fs.existsSync(outPath), 'crawl-results.json missing');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    assert.ok(Array.isArray(data), 'crawl-results.json should be an array');
    assert.ok(data.length > 0, 'should have at least one site');
    assert.ok(data[0].domain, 'each entry should have a domain');
    assert.ok(out.includes('Phase 1 complete'), 'stdout should confirm Phase 1');
  });

  it('Phase2: dry-run should produce raw-keywords.json', () => {
    const out = runPhase(PHASES.phase2, outdir);
    const outPath = path.join(outdir, 'raw-keywords.json');
    assert.ok(fs.existsSync(outPath), 'raw-keywords.json missing');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    assert.ok(Array.isArray(data), 'raw-keywords.json should be an array');
    assert.ok(data.length > 0, 'should have at least one keyword');
    assert.ok(data[0].text, 'each keyword should have a text field');
    assert.ok(data[0].category, 'each keyword should have a category');
    assert.ok(out.includes('Phase 2 complete'), 'stdout should confirm Phase 2');
  });

  it('Phase3: dry-run should produce keywords-priority.csv with correct header', () => {
    const out = runPhase(PHASES.phase3, outdir);
    const csvPath = path.join(outdir, 'keywords-priority.csv');
    assert.ok(fs.existsSync(csvPath), 'keywords-priority.csv missing');

    // Verify header against SKILL.md
    const skillColumns = parseCsvHeaderFromSkillMd();
    const csvHeader = parseCsvHeader(csvPath);
    assert.equal(
      csvHeader.length,
      skillColumns.length,
      `Column count mismatch: CSV=${csvHeader.length} SKILL.md=${skillColumns.length}`
    );
    for (const col of csvHeader) {
      assert.ok(
        skillColumns.includes(col),
        `Column '${col}' not found in SKILL.md columns: [${skillColumns.join(', ')}]`
      );
    }

    // Verify recommended_action column exists
    assert.ok(
      csvHeader.includes('recommended_action'),
      'CSV should have recommended_action column'
    );

    // Verify data rows
    const rows = parseCsvData(csvPath);
    assert.ok(rows.length > 0, 'CSV should have data rows');
    assert.ok(out.includes('Phase 3 complete'), 'stdout should confirm Phase 3');
  });

  it('Phase3: scores should be in descending order', () => {
    const csvPath = path.join(outdir, 'keywords-priority.csv');
    const rows = parseCsvData(csvPath);
    const scores = rows.map(r => Number(r.score));
    for (let i = 1; i < scores.length; i++) {
      assert.ok(
        scores[i - 1] >= scores[i],
        `Scores not in descending order at index ${i}: ${scores[i - 1]} < ${scores[i]}`
      );
    }
  });

  it('Phase3: priority numbers should be sequential', () => {
    const csvPath = path.join(outdir, 'keywords-priority.csv');
    const rows = parseCsvData(csvPath);
    rows.forEach((r, i) => {
      assert.equal(Number(r.priority), i + 1, `Priority should be ${i + 1} at row ${i}`);
    });
  });

  it('Phase3: recommended_action should be one of the valid values', () => {
    const csvPath = path.join(outdir, 'keywords-priority.csv');
    const rows = parseCsvData(csvPath);
    const validActions = ['新規記事作成', '既存ページ改善', '監視'];
    for (const r of rows) {
      assert.ok(
        validActions.includes(r.recommended_action),
        `Invalid recommended_action '${r.recommended_action}' for keyword '${r.keyword}'`
      );
    }
  });

  it('Phase4: dry-run should produce content-gaps.md', () => {
    const out = runPhase(PHASES.phase4, outdir);
    const mdPath = path.join(outdir, 'content-gaps.md');
    assert.ok(fs.existsSync(mdPath), 'content-gaps.md missing');
    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.ok(content.length > 0, 'content-gaps.md should not be empty');
    assert.ok(content.includes('展示会ブース制作'), 'should contain the project title');
    assert.ok(content.includes('優先キーワード'), 'should have TOP20 section');
    assert.ok(content.includes('推奨アクション'), 'should include recommended_action column in table');
    assert.ok(out.includes('Phase 4 complete'), 'stdout should confirm Phase 4');
  });

  it('should clean up temp directory', () => {
    if (outdir && fs.existsSync(outdir)) {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
    assert.ok(!fs.existsSync(outdir));
  });

  it('run.mjs --dry-run should execute all 4 phases', () => {
    const runOutdir = mkdtempSync(path.join(os.tmpdir(), 'kw-run-test-'));
    try {
      const stdout = execSync(`node "${path.join(ROOT, 'run.mjs')}" --dry-run "${runOutdir}"`, {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 60000,
      });
      assert.ok(stdout.includes('Phase 1'), 'should include Phase 1 output');
      assert.ok(stdout.includes('Phase 2'), 'should include Phase 2 output');
      assert.ok(stdout.includes('Phase 3'), 'should include Phase 3 output');
      assert.ok(stdout.includes('Phase 4'), 'should include Phase 4 output');
      assert.ok(stdout.includes('全 Phase 完了'), 'should confirm completion');
    } finally {
      fs.rmSync(runOutdir, { recursive: true, force: true });
    }
  });
});
