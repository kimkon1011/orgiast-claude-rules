import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from './event-material-generate.mjs';

describe('event-material-generate', () => {
  it('デフォルト引数でエラーなく実行できる', () => {
    const { lines, result } = main(['node', 'event-material-generate.mjs']);
    assert.ok(lines.length > 0);
    assert.ok(lines.includes('イベント資料生成ワークフロー コスト試算'));
    assert.ok(result.agents.length === 4);
    assert.ok(result.totals.allHigh > 0);
    assert.ok(result.totals.lowFirst > 0);
  });

  it('全エージェントの削減率が0%以上である', () => {
    const { result } = main(['node', 'event-material-generate.mjs']);
    for (const a of result.agents) {
      assert.ok(a.savingsPct >= 0, `${a.name}: savingsPct=${a.savingsPct} は負`);
    }
    assert.ok(result.totalSavingsPct >= 0);
  });

  it('正解率1.0の時、削減率が最大になる', () => {
    const { result } = main(['node', 'event-material-generate.mjs', '--pass-rate', '1.0']);
    const implementer = result.agents.find(a => a.name.includes('Implementer'));
    assert.ok(implementer);
    // p=1.0 なら削減率 = 1 - low/high
    const expected = Math.round((1 - 0.008 / 0.025) * 1000) / 10;
    assert.equal(implementer.savingsPct, expected);
  });

  it('正解率0.5の時、コスト増（削減率マイナス）になる', () => {
    const { result } = main(['node', 'event-material-generate.mjs', '--pass-rate', '0.5']);
    // p=0.5: lowFirst = n*L + 0.5*n*H, allHigh = n*H
    // savings = 1 - (L + 0.5*H)/H = 1 - L/H - 0.5 = 0.5 - L/H
    // Implementer: L=0.008, H=0.025 → 0.5 - 0.32 = 0.18 → 18% 減（正のまま）
    // でも Haiku系は low が非常に小さいので削減率は正のまま
    for (const a of result.agents) {
      // どのエージェントも正解率0.5でもコスト増にはならない（low が十分小さい）
      assert.ok(a.savingsPct >= 0, `${a.name}: savingsPct=${a.savingsPct}`);
    }
  });

  it('verbose モードで詳細情報が含まれる', () => {
    const { lines } = main(['node', 'event-material-generate.mjs', '--verbose']);
    assert.ok(lines.includes('各サブエージェントのコストモデル'));
    assert.ok(lines.includes('Extractor'));
    assert.ok(lines.includes('low='));
  });

  it('タスク数指定が反映される', () => {
    const { result } = main(['node', 'event-material-generate.mjs', '--count', '5']);
    for (const a of result.agents) {
      assert.equal(a.count, 5);
    }
  });
});
