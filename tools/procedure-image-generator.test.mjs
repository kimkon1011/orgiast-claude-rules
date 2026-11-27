/**
 * tools/procedure-image-generator.test.mjs
 * X-0028 テストスイート
 *
 * Usage:
 *   node --test tools/procedure-image-generator.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOL = path.join(__dirname, 'procedure-image-generator.mjs');

import {
  validateDefinition,
  generateHTML,
  generateCodexPrompt,
  generateTemplate,
  writeProcedureFiles
} from './procedure-image-generator.mjs';

/**
 * ツールを実行して stdout / status を返す
 */
function run(...args) {
  const result = spawnSync(process.execPath, [TOOL, ...args]);
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    status: result.status
  };
}

/** テスト用の有効な手順定義 */
const VALID_DEFINITION = {
  title: 'テスト手順書',
  description: 'テスト用の手順書です',
  target: { app: 'テストアプリ', viewport: { width: 1440, height: 900 } },
  steps: [
    { id: 1, title: 'ステップ1', description: '最初のステップ', selectors: ['.btn-start'], estimatedMinutes: 5 },
    { id: 2, title: 'ステップ2', description: '次のステップ', estimatedMinutes: 10 }
  ],
  estimatedTotalMinutes: 15
};

describe('procedure-image-generator.mjs', () => {

  describe('validateDefinition', () => {
    it('should accept a valid definition', () => {
      const result = validateDefinition(VALID_DEFINITION);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('should reject null/undefined', () => {
      assert.equal(validateDefinition(null).valid, false);
      assert.equal(validateDefinition(undefined).valid, false);
    });

    it('should reject non-object', () => {
      assert.equal(validateDefinition('string').valid, false);
      assert.equal(validateDefinition(123).valid, false);
    });

    it('should reject missing title', () => {
      const result = validateDefinition({ description: 'test', steps: [{ id: 1, title: 'a', description: 'b' }] });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('title')));
    });

    it('should reject missing description', () => {
      const result = validateDefinition({ title: 'test', steps: [{ id: 1, title: 'a', description: 'b' }] });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('description')));
    });

    it('should reject empty steps', () => {
      const result = validateDefinition({ title: 'test', description: 'test', steps: [] });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('steps')));
    });

    it('should reject missing step title/description', () => {
      const result = validateDefinition({
        title: 'test', description: 'test',
        steps: [{ id: 1, title: 'a', description: 'b' }, { id: 2 }]
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('steps[1].title')));
      assert.ok(result.errors.some(e => e.includes('steps[1].description')));
    });

    it('should reject step with missing id', () => {
      const result = validateDefinition({
        title: 'test', description: 'test',
        steps: [{ title: 'a', description: 'b' }]
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('steps[0].id')));
    });

    it('should reject non-array selectors', () => {
      const result = validateDefinition({
        title: 'test', description: 'test',
        steps: [{ id: 1, title: 'a', description: 'b', selectors: '.btn' }]
      });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => e.includes('selectors')));
    });
  });

  describe('generateTemplate', () => {
    it('should return a valid template definition', () => {
      const tmpl = generateTemplate();
      const result = validateDefinition(tmpl);
      assert.equal(result.valid, true);
      assert.ok(tmpl.title.includes('タイトル'));
      assert.ok(Array.isArray(tmpl.steps));
      assert.equal(tmpl.steps.length, 2);
    });
  });

  describe('generateHTML', () => {
    it('should output valid HTML with DOCTYPE', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('</html>'));
    });

    it('should include step titles', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.includes('ステップ1'));
      assert.ok(html.includes('ステップ2'));
    });

    it('should include step descriptions', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.includes('最初のステップ'));
      assert.ok(html.includes('次のステップ'));
    });

    it('should include step images with correct filenames', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.includes('step-01.png'));
      assert.ok(html.includes('step-02.png'));
    });

    it('should include circled numbers ① and ②', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.includes('①'));
      assert.ok(html.includes('②'));
    });

    it('should include CSS in style tag', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.includes('<style>'));
      assert.ok(html.includes('.procedure-cover'));
      assert.ok(html.includes('.step-number-badge'));
    });

    it('should include cover page with title and step count', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.includes('テスト手順書'));
      assert.ok(html.includes('全2ステップ'));
      assert.ok(html.includes('15分'));
    });

    it('should include selectors in HTML when present', () => {
      const html = generateHTML(VALID_DEFINITION);
      assert.ok(html.includes('.btn-start'));
    });

    it('should escape HTML special characters in title', () => {
      const def = {
        title: '手順書 <test> & "quote"',
        description: 'test',
        steps: [{ id: 1, title: 'step', description: 'desc' }]
      };
      const html = generateHTML(def);
      assert.ok(html.includes('&lt;test&gt;'));
      assert.ok(html.includes('&amp;'));
    });
  });

  describe('generateCodexPrompt', () => {
    it('should include the title', () => {
      const prompt = generateCodexPrompt(VALID_DEFINITION);
      assert.ok(prompt.includes('テスト手順書'));
    });

    it('should include step definitions as JSON', () => {
      const prompt = generateCodexPrompt(VALID_DEFINITION);
      assert.ok(prompt.includes('"ステップ1"'));
      assert.ok(prompt.includes('"ステップ2"'));
    });

    it('should include image generation rules', () => {
      const prompt = generateCodexPrompt(VALID_DEFINITION);
      assert.ok(prompt.includes('赤枠'));
      assert.ok(prompt.includes('番号バッジ'));
      assert.ok(prompt.includes('Puppeteer'));
      assert.ok(prompt.includes('step-01.png'));
    });

    it('should include selector instructions when selectors exist', () => {
      const prompt = generateCodexPrompt(VALID_DEFINITION);
      assert.ok(prompt.includes('CSSセレクタ'));
    });

    it('should skip selector instructions when no selectors', () => {
      const def = {
        title: '手動手順書',
        description: 'セレクタなし',
        steps: [
          { id: 1, title: '手動ステップ', description: '説明' }
        ]
      };
      const prompt = generateCodexPrompt(def);
      assert.ok(!prompt.includes('CSSセレクタによる枠線'));
    });
  });

  describe('writeProcedureFiles', () => {
    let tmpDir;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0028-test-'));
    });

    it('should write HTML, CSS, and step SVG files', () => {
      const { htmlPath, cssPath } = writeProcedureFiles(VALID_DEFINITION, tmpDir);
      assert.ok(fs.existsSync(htmlPath));
      assert.ok(fs.existsSync(cssPath));
      assert.ok(fs.existsSync(path.join(tmpDir, 'step-01.svg')));
      assert.ok(fs.existsSync(path.join(tmpDir, 'step-02.svg')));
    });

    it('should contain valid HTML in output', () => {
      const html = fs.readFileSync(path.join(tmpDir, 'procedure.html'), 'utf-8');
      assert.ok(html.includes('テスト手順書'));
    });
  });

  describe('CLI', () => {
    it('--help should exit 0 and show help text', () => {
      const r = run('--help');
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes('X-0028'));
      assert.ok(r.stdout.includes('--init'));
    });

    it('--init should output valid JSON template', () => {
      const r = run('--init');
      assert.equal(r.status, 0);
      const tmpl = JSON.parse(r.stdout);
      assert.ok(tmpl.title);
      assert.ok(Array.isArray(tmpl.steps));
    });

    it('--validate should accept valid JSON file', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-valid-' + Date.now() + '.json');
      fs.writeFileSync(tmpFile, JSON.stringify(VALID_DEFINITION));
      try {
        const r = run('--validate', tmpFile);
        assert.equal(r.status, 0);
        assert.ok(r.stdout.includes('有効'));
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('--validate should reject invalid JSON file', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-invalid-' + Date.now() + '.json');
      fs.writeFileSync(tmpFile, JSON.stringify({ title: 'no steps' }));
      try {
        const r = run('--validate', tmpFile);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes('バリデーションエラー'));
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('--codex-steps should output booth setup prompt', () => {
      const r = run('--codex-steps');
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes('ブース設営'));
      assert.ok(r.stdout.includes('Puppeteer'));
    });

    it('--steps with --prompt should output codex prompt', () => {
      const tmpFile = path.join(os.tmpdir(), 'test-prompt-' + Date.now() + '.json');
      fs.writeFileSync(tmpFile, JSON.stringify(VALID_DEFINITION));
      try {
        const r = run('--steps', tmpFile, '--prompt');
        assert.equal(r.status, 0);
        assert.ok(r.stdout.includes('【X-0028'));
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('--steps with --output should write files', () => {
      const tmpDef = path.join(os.tmpdir(), 'test-output-' + Date.now() + '.json');
      const tmpOut = path.join(os.tmpdir(), 'x0028-out-' + Date.now());
      fs.writeFileSync(tmpDef, JSON.stringify(VALID_DEFINITION));
      try {
        const r = run('--steps', tmpDef, '--output', tmpOut);
        assert.equal(r.status, 0);
        assert.ok(fs.existsSync(path.join(tmpOut, 'procedure.html')));
        assert.ok(r.stdout.includes('生成完了'));
      } finally {
        fs.unlinkSync(tmpDef);
        try { fs.rmSync(tmpOut, { recursive: true }); } catch {}
      }
    });

    it('should fail on missing --steps file', () => {
      const r = run('--steps', '/nonexistent/file.json');
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes('見つかりません'));
    });

    it('should fail on invalid JSON in --steps file', () => {
      const tmpFile = path.join(os.tmpdir(), 'bad-json-' + Date.now() + '.json');
      fs.writeFileSync(tmpFile, '{ invalid json }');
      try {
        const r = run('--steps', tmpFile);
        assert.equal(r.status, 1);
        assert.ok(r.stderr.includes('パース'));
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('no args should show help', () => {
      const r = run();
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes('X-0028'));
    });
  });

  describe('edge cases', () => {
    it('should handle 20 steps with all circled numbers', () => {
      const steps = Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        title: `ステップ${i + 1}`,
        description: `説明${i + 1}`
      }));
      const def = { title: '20ステップ', description: 'テスト', steps };
      const html = generateHTML(def);
      for (let i = 0; i < 20; i++) {
        assert.ok(html.includes(`ステップ${i + 1}`));
      }
      // Check all circled numbers ① through ⑳
      const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
      for (const c of circled) {
        assert.ok(html.includes(c));
      }
    });

    it('should work with a single step', () => {
      const def = {
        title: '単一ステップ',
        description: 'test',
        steps: [{ id: 1, title: '唯一のステップ', description: '説明' }]
      };
      const { valid } = validateDefinition(def);
      assert.equal(valid, true);
      const html = generateHTML(def);
      assert.ok(html.includes('唯一のステップ'));
    });

    it('should handle steps without estimatedMinutes', () => {
      const def = {
        title: '時間なし',
        description: 'test',
        steps: [
          { id: 1, title: 'A', description: 'desc A' },
          { id: 2, title: 'B', description: 'desc B' }
        ]
      };
      const { valid } = validateDefinition(def);
      assert.equal(valid, true);
    });
  });

});