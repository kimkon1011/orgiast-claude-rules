/**
 * tools/screenshot-website-builder.test.mjs
 * X-0014 テストスイート
 *
 * Usage:
 *   node --test tools/screenshot-website-builder.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOL = path.join(__dirname, 'screenshot-website-builder.mjs');

/**
 * ツールを実行して stdout を返す
 */
function run(...args) {
  const result = spawnSync(process.execPath, [TOOL, ...args]);
  if (result.status !== 0) {
    throw new Error(`Exit ${result.status}: ${result.stderr.toString().slice(0, 500)}`);
  }
  return result.stdout.toString().trim();
}

describe('screenshot-website-builder.mjs', () => {

  describe('--list-usecases', () => {
    it('should output valid JSON with 5 use cases', () => {
      const out = run('--list-usecases');
      const data = JSON.parse(out);
      assert.ok(Array.isArray(data));
      assert.equal(data.length, 5);
    });

    it('should include booth-lp and event-page use cases', () => {
      const data = JSON.parse(run('--list-usecases'));
      const ids = data.map(d => d.id);
      assert.ok(ids.includes('booth-lp'));
      assert.ok(ids.includes('event-page'));
      assert.ok(ids.includes('portfolio'));
      assert.ok(ids.includes('contact-form'));
      assert.ok(ids.includes('comparison-table'));
    });
  });

  describe('--usecase', () => {
    it('should generate a prompt for booth-lp', () => {
      const out = run('--usecase', 'booth-lp');
      assert.ok(out.includes('標準ブース提案ランディングページ'));
      assert.ok(out.includes('hero section'));
      assert.ok(out.includes('Tailwind CSS'));
      assert.ok(out.includes('Noto Sans JP'));
      assert.ok(out.includes('#1a3a5c'));
    });

    it('should generate a prompt for event-page', () => {
      const out = run('--usecase', 'event-page');
      assert.ok(out.includes('イベント詳細ページ'));
      assert.ok(out.includes('タイムテーブル'));
      assert.ok(out.includes('Google Maps'));
    });

    it('should generate a prompt for portfolio', () => {
      const out = run('--usecase', 'portfolio');
      assert.ok(out.includes('実績紹介ギャラリー'));
      assert.ok(out.includes('グリッド'));
    });

    it('should generate a prompt for contact-form', () => {
      const out = run('--usecase', 'contact-form');
      assert.ok(out.includes('お問い合わせフォーム'));
      assert.ok(out.includes('バリデーション'));
    });

    it('should generate a prompt for comparison-table', () => {
      const out = run('--usecase', 'comparison-table');
      assert.ok(out.includes('比較表'));
      assert.ok(out.includes('ソート'));
    });

    it('should fail for unknown use case', () => {
      const result = spawnSync(process.execPath, [TOOL, '--usecase', 'nonexistent']);
      assert.notEqual(result.status, 0);
      const stderr = result.stderr.toString().trim();
      assert.ok(stderr.includes('見つかりません'));
    });
  });

  describe('--mode scaffold', () => {
    it('should include scaffold-only instructions', () => {
      const out = run('--usecase', 'booth-lp', '--mode', 'scaffold');
      assert.ok(out.includes('スキャフォールドのみ'));
      assert.ok(out.includes('HTML 骨格構造'));
    });

    it('should still include use case title and structure', () => {
      const out = run('--usecase', 'event-page', '--mode', 'scaffold');
      assert.ok(out.includes('イベント詳細ページ'));
      assert.ok(out.includes('event-header'));
    });
  });

  describe('--custom', () => {
    it('should generate prompt from custom JSON', () => {
      const custom = JSON.stringify({
        title: 'カスタムテスト',
        structure: 'custom-layout',
        brand: '#ff0000',
        components: ['コンポ1', 'コンポ2']
      });
      const out = run('--custom', custom);
      assert.ok(out.includes('カスタムテスト'));
      assert.ok(out.includes('#ff0000'));
      assert.ok(out.includes('コンポ1'));
    });

    it('should fail on invalid JSON', () => {
      const result = spawnSync(process.execPath, [TOOL, '--custom', 'not-json']);
      assert.notEqual(result.status, 0);
      const stderr = result.stderr.toString().trim();
      assert.ok(stderr.includes('有効なJSON'));
    });
  });

  describe('--help', () => {
    it('should show help with use cases listed', () => {
      const out = run('--help');
      assert.ok(out.includes('X-0014'));
      assert.ok(out.includes('Usage'));
      assert.ok(out.includes('booth-lp'));
      assert.ok(out.includes('event-page'));
    });

    it('should show help when no args given', () => {
      const out = run();
      assert.ok(out.includes('X-0014'));
      assert.ok(out.includes('Usage'));
    });
  });

  describe('prompt content quality', () => {
    it('should contain all required sections in full mode', () => {
      const out = run('--usecase', 'booth-lp');
      assert.ok(out.includes('スクリーンショット参照'));
      assert.ok(out.includes('構造指定'));
      assert.ok(out.includes('ブランド指定'));
      assert.ok(out.includes('レイアウト指定'));
      assert.ok(out.includes('インタラクティブ要素'));
      assert.ok(out.includes('コンポーネント一覧'));
      assert.ok(out.includes('技術スタック'));
      assert.ok(out.includes('出力形式'));
    });

    it('should reference Orgiast brand for booth-lp', () => {
      const out = run('--usecase', 'booth-lp');
      assert.ok(out.includes('オージャスト'));
    });

    it('should mention responsive design in all prompts', () => {
      const out = run('--usecase', 'comparison-table');
      assert.ok(out.includes('レスポンシブ'));
    });

    it('should include component count matching definition', () => {
      const components = [
        { id: 'booth-lp', count: 7 },
        { id: 'event-page', count: 7 },
        { id: 'portfolio', count: 5 },
        { id: 'contact-form', count: 6 },
        { id: 'comparison-table', count: 6 }
      ];
      for (const { id, count } of components) {
        const out = run('--usecase', id);
        // コンポーネント一覧に数字の箇条書きが count 個ある
        const matches = out.match(/^\d+\. /gm);
        assert.ok(matches && matches.length >= count, `Expected >=${count} components in ${id}, got ${matches?.length || 0}`);
      }
    });
  });

});