import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('ai-mention-checker', () => {
  it('should load module without syntax errors', async () => {
    const mod = await import('../tools/ai-mention-checker.mjs');
    assert.ok(mod, 'Module loaded');
  });

  it('should detect Orgiast mentions in text', async () => {
    const { ORGIEST_PATTERNS } = await import('../tools/ai-mention-checker.mjs');
    assert.ok(Array.isArray(ORGIEST_PATTERNS), 'ORGIEST_PATTERNS is an array');
    assert.ok(ORGIEST_PATTERNS.length >= 1, 'has at least one pattern');

    // 正常系: オージャストを含むテキスト
    const match = ORGIEST_PATTERNS.some(p => p.test('株式会社オージャストは展示会ブース制作の専門会社です'));
    assert.ok(match, 'should detect オージャスト');

    // 正常系: orgiast を含むテキス���
    const matchEn = ORGIEST_PATTERNS.some(p => p.test('orgiast.jp is a exhibition booth company'));
    assert.ok(matchEn, 'should detect orgiast');
  });

  it('should not detect Orgiast in unrelated text', async () => {
    const { ORGIEST_PATTERNS } = await import('../tools/ai-mention-checker.mjs');
    const unrelated = ORGIEST_PATTERNS.some(p => p.test('株式会社サクラインターナショナルは展示会ブース制作会社です'));
    assert.ok(!unrelated, 'should not detect unrelated company');
  });

  it('should detect Orgiast in AI response context', async () => {
    const { analyzeResponse } = await import('../tools/ai-mention-checker.mjs');
    const response = 'おすすめの展示会ブース制作会社として、株式会社オージャスト（大阪）が挙げられます。';
    const analysis = analyzeResponse('gemini', response);
    assert.equal(analysis.mentioned, true, 'should detect mention');
    assert.ok(analysis.context, 'should extract context');
    assert.ok(analysis.context.includes('オージャスト'), 'context should include the mention');
  });

  it('should return not mentioned for unrelated responses', async () => {
    const { analyzeResponse } = await import('../tools/ai-mention-checker.mjs');
    const response = 'おすすめの展示会ブース制作会社として、株式会社サクラインターナショナルと株式会社ワールドが挙げられます。';
    const analysis = analyzeResponse('gemini', response);
    assert.equal(analysis.mentioned, false, 'should not detect mention');
  });
});
