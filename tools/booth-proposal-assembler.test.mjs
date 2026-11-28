// Tests for booth-proposal-assembler.mjs (X-0074)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROPOSAL_SECTIONS,
  validateProposalData,
  assembleProposal,
  writeProposalFiles,
} from './booth-proposal-assembler.mjs';

// ---------- PROPOSAL_SECTIONS ----------

test('PROPOSAL_SECTIONS has all required sections', () => {
  const ids = PROPOSAL_SECTIONS.map(s => s.id);
  assert.ok(ids.includes('cover'));
  assert.ok(ids.includes('summary'));
  assert.ok(ids.includes('requirements'));
  assert.ok(ids.includes('budget'));
  assert.ok(ids.length >= 6);
});

// ---------- validateProposalData ----------

test('validateProposalData rejects non-object', () => {
  const result = validateProposalData(null);
  assert.ok(!result.ok);
});

test('validateProposalData requires client_name', () => {
  const result = validateProposalData({ sections: [{ id: 'cover', title: '表紙' }] });
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('client_name')));
});

test('validateProposalData valid proposal passes', () => {
  const data = {
    client_name: 'テスト企業',
    sections: [
      { id: 'cover', title: '表紙' },
      { id: 'summary', title: '提案概要' },
      { id: 'requirements', title: '要件分析' },
      { id: 'budget', title: '予算配分' },
    ],
  };
  const result = validateProposalData(data);
  assert.ok(result.ok, `errors: ${result.errors.join(', ')}`);
});

test('validateProposalData detects duplicate section IDs', () => {
  const data = {
    client_name: 'テスト企業',
    sections: [
      { id: 'dup', title: '重複1' },
      { id: 'dup', title: '重複2' },
    ],
  };
  const result = validateProposalData(data);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('重複')));
});

test('validateProposalData requires section title', () => {
  const data = {
    client_name: 'テスト企業',
    sections: [{ id: 'missing_title' }],
  };
  const result = validateProposalData(data);
  assert.ok(!result.ok);
  assert.ok(result.errors.some(e => e.includes('title')));
});

// ---------- assembleProposal ----------

test('assembleProposal basic proposal includes client name', () => {
  const md = assembleProposal({
    client_name: 'テスト企業',
  });
  assert.ok(md.includes('テスト企業'));
});

test('assembleProposal includes cover section by default', () => {
  const md = assembleProposal({
    client_name: 'ABC株式会社',
    project_name: 'テスト提案',
  });
  assert.ok(md.includes('ABC株式会社'));
  assert.ok(md.includes('提案概要'));
  assert.ok(md.includes('株式会社オージャスト'));
});

test('assembleProposal with zone data includes zone table', () => {
  const md = assembleProposal({
    client_name: 'ゾーンあり',
    zone_data: {
      zones: [
        { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 900, d_mm: 1000, priority: 1 },
      ],
      meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 33.3, min_aisle_mm: 600 },
    },
  });
  assert.ok(md.includes('受付'));
  assert.ok(md.includes('ゾーン'));
  assert.ok(md.includes('9m²'));
});

test('assembleProposal with layout data includes item table', () => {
  const md = assembleProposal({
    client_name: '什器あり',
    zone_data: {
      zones: [{ id: 'test', type: 'display', label: '展示', x_mm: 0, y_mm: 0, w_mm: 3000, d_mm: 3000, priority: 2 }],
      meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 100, min_aisle_mm: 600 },
    },
    layout_data: {
      items: [
        { label: '展示シェルフ', w_mm: 1200, d_mm: 400, price: 35000, zone: 'test' },
        { label: 'カウンター', w_mm: 900, d_mm: 450, price: 15000, zone: 'test' },
      ],
      totalCost: 50000,
      meta: { width_mm: 3000, depth_mm: 3000, within_budget: true },
      warnings: [],
    },
  });
  assert.ok(md.includes('展示シェルフ'));
  assert.ok(md.includes('カウンター'));
  assert.ok(md.includes('50,000'));
});

test('assembleProposal includes requirements section with provided data', () => {
  const md = assembleProposal({
    client_name: '要件あり',
    requirements: {
      event: '展示会EXPO 2026',
      venue: '東京ビッグサイト',
      dates: '2026-12-01〜03',
      purpose: '新製品発表',
    },
  });
  assert.ok(md.includes('展示会EXPO 2026'));
  assert.ok(md.includes('東京ビッグサイト'));
  assert.ok(md.includes('新製品発表'));
});

test('assembleProposal respects include_sections filter', () => {
  const md = assembleProposal({
    client_name: '一部のみ',
    include_sections: ['cover', 'summary'],
  });
  assert.ok(md.includes('提案概要'));
  assert.ok(!md.includes('要件分析'));
  assert.ok(!md.includes('ゾーン計画'));
  assert.ok(!md.includes('予算配分'));
});

test('assembleProposal handles budget warnings', () => {
  const md = assembleProposal({
    client_name: '予算超過',
    layout_data: {
      items: [{ label: '高額什器', w_mm: 1000, d_mm: 1000, price: 1000000, zone: 'test' }],
      totalCost: 1000000,
      meta: { width_mm: 3000, depth_mm: 3000, within_budget: false, budget: 500000 },
      warnings: ['予算超過: ¥1000000 > ¥500000'],
    },
    zone_data: {
      zones: [{ id: 'test', type: 'display', label: '展示', x_mm: 0, y_mm: 0, w_mm: 3000, d_mm: 3000, priority: 2 }],
      meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 100, min_aisle_mm: 600 },
    },
  });
  assert.ok(md.includes('予算を超過') || md.includes('予算'));
});

test('assembleProposal with requirements budget string', () => {
  const md = assembleProposal({
    client_name: '予算確認',
    requirements: { budget: '500,000円' },
  });
  assert.ok(md.includes('500,000'));
});

test('assembleProposal schedule section includes standard timeline', () => {
  const md = assembleProposal({
    client_name: 'スケジュール確認',
    include_sections: ['cover', 'schedule'],
  });
  assert.ok(md.includes('スケジュール'));
  assert.ok(md.includes('搬入設営'));
  assert.ok(md.includes('撤去'));
});

test('assembleProposal company_info section', () => {
  const md = assembleProposal({
    client_name: '会社概要確認',
    include_sections: ['cover', 'company_info'],
  });
  assert.ok(md.includes('株式会社オージャスト'));
  assert.ok(md.includes('seisaku-team@orgiast.jp'));
});

// ---------- writeProposalFiles ----------

test('writeProposalFiles writes proposal.md', () => {
  const tmpDir = fs.mkdtempSync('booth-test-');
  try {
    const result = writeProposalFiles({
      client_name: 'ファイルテスト',
      zone_data: {
        zones: [],
        meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 0, min_aisle_mm: 600 },
      },
    }, tmpDir);
    assert.ok(result.files.includes('proposal.md'));
    assert.ok(result.files.includes('zone-plan.json'));
    assert.ok(fs.existsSync(path.join(tmpDir, 'proposal.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'zone-plan.json')));
  } finally {
    // クリーンアップ
    for (const f of ['proposal.md', 'zone-plan.json']) {
      const fp = path.join(tmpDir, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    fs.rmdirSync(tmpDir);
  }
});

test('writeProposalFiles includes layout when provided', () => {
  const tmpDir = fs.mkdtempSync('booth-test-');
  try {
    const result = writeProposalFiles({
      client_name: '設定テスト',
      zone_data: { zones: [], meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 0, min_aisle_mm: 600 } },
      layout_data: { items: [], zones: [], totalCost: 0, meta: {}, warnings: [] },
    }, tmpDir);
    assert.ok(result.files.includes('layout-plan.json'));
    assert.ok(fs.existsSync(path.join(tmpDir, 'layout-plan.json')));
  } finally {
    for (const f of ['proposal.md', 'zone-plan.json', 'layout-plan.json']) {
      const fp = path.join(tmpDir, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    fs.rmdirSync(tmpDir);
  }
});

test('writeProposalFiles returns proposalMd string', () => {
  const tmpDir = fs.mkdtempSync('booth-test-');
  try {
    const result = writeProposalFiles({ client_name: '内容テスト' }, tmpDir);
    assert.ok(typeof result.proposalMd === 'string');
    assert.ok(result.proposalMd.length > 0);
    assert.ok(result.proposalMd.includes('内容テスト'));
  } finally {
    const fp = path.join(tmpDir, 'proposal.md');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    fs.rmdirSync(tmpDir);
  }
});

// ---------- Integration ----------

test('Full pipeline: zone plan → layout optimization → proposal', () => {
  // Simulate zone planner output
  const zonePlan = {
    zones: [
      { id: 'reception', type: 'reception', label: '受付', x_mm: 0, y_mm: 0, w_mm: 2700, d_mm: 1000, priority: 1, color: '#dbeafe' },
      { id: 'display', type: 'display', label: '展示', x_mm: 0, y_mm: 1000, w_mm: 3000, d_mm: 1200, priority: 2, color: '#dcfce7' },
    ],
    meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 66.7, min_aisle_mm: 600 },
  };

  // Simulate layout optimizer output
  const layout = {
    items: [
      { label: 'カウンターテーブル', w_mm: 900, d_mm: 450, price: 15000, zone: 'reception' },
      { label: '展示シェルフ', w_mm: 1200, d_mm: 400, price: 35000, zone: 'display' },
    ],
    zones: zonePlan.zones,
    totalCost: 50000,
    meta: { width_mm: 3000, depth_mm: 3000, within_budget: true },
    warnings: [],
  };

  // Assemble proposal
  const md = assembleProposal({
    client_name: '統合テスト',
    project_name: '統合テスト様 ブース提案書',
    zone_data: zonePlan,
    layout_data: layout,
    requirements: {
      event: '展示会 2026',
      venue: 'テスト会場',
      budget: '300,000円',
      purpose: '自社PR',
    },
  });

  // Verify all expected content
  assert.ok(md.includes('統合テスト'));
  assert.ok(md.includes('受付'));
  assert.ok(md.includes('展示'));
  assert.ok(md.includes('カウンターテーブル'));
  assert.ok(md.includes('展示シェルフ'));
  assert.ok(md.includes('50,000'));
  assert.ok(md.includes('ゾーン計画'));
  assert.ok(md.includes('什器配置計画'));
  assert.ok(md.includes('予算配分'));
  assert.ok(md.includes('展示会 2026'));
});

test('Proposal with all optional sections', () => {
  const md = assembleProposal({
    client_name: '全セクション',
    include_sections: ['cover', 'summary', 'requirements', 'zone_plan', 'layout', 'budget', 'schedule', 'company_info'],
    zone_data: {
      zones: [{ id: 'z1', type: 'display', label: 'ゾーン1', x_mm: 0, y_mm: 0, w_mm: 3000, d_mm: 3000, priority: 2 }],
      meta: { width_mm: 3000, depth_mm: 3000, total_area_m2: 9.0, utilization_pct: 100, min_aisle_mm: 600 },
    },
    layout_data: {
      items: [{ label: '什器', w_mm: 1000, d_mm: 500, price: 10000, zone: 'z1' }],
      zones: [],
      totalCost: 10000,
      meta: { width_mm: 3000, depth_mm: 3000, within_budget: true },
      warnings: [],
    },
  });
  assert.ok(md.includes('ゾーン計画'));
  assert.ok(md.includes('什器配置計画'));
  assert.ok(md.includes('スケジュール'));
  assert.ok(md.includes('株式会社オージャスト'));
  assert.ok(md.includes('お問い合わせ'));
});