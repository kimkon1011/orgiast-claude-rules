/**
 * batch-classify.mjs のユニットテスト
 *
 * 「ツールを決定的ユニットテストしてから非決定的エージェントをテスト」原則（X-0013）に基づき、
 * パーサー関数・ルールベース関数はLLM無しで完全検証する。
 * batchClassify 自体は内部でLLMを呼ぶためdry-run時の挙動のみ確認。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, '..', 'process', 'batch-classify.mjs');

let mod;
async function loadMod() {
  if (!mod) mod = await import('file:///' + MODULE_PATH.replace(/\\/g, '/'));
  return mod;
}

describe('batch-classify deterministic tests', () => {
  it('should export all functions', async () => {
    const m = await loadMod();
    assert.ok(typeof m.batchClassify === 'function');
    assert.ok(typeof m.intentPrompt === 'function');
    assert.ok(typeof m.parseIntentResponse === 'function');
    assert.ok(typeof m.categoryPrompt === 'function');
    assert.ok(typeof m.parseCategoryResponse === 'function');
    assert.ok(typeof m.pageTypePrompt === 'function');
    assert.ok(typeof m.parsePageTypeResponse === 'function');
    assert.ok(typeof m.ruleBasedIntent === 'function');
    assert.ok(typeof m.ruleBasedPageType === 'function');
  });

  it('ruleBasedIntent should classify intent without LLM', async () => {
    const m = await loadMod();
    assert.equal(m.ruleBasedIntent('展示会ブース 制作'), 'Commercial');
    assert.equal(m.ruleBasedIntent('展示会 費用'), 'Transactional');
    assert.equal(m.ruleBasedIntent('ブース とは'), 'Informational');
    assert.equal(m.ruleBasedIntent('代行'), 'Transactional');
    assert.equal(m.ruleBasedIntent('方法'), 'Informational');
  });

  it('ruleBasedPageType should classify page type without LLM', async () => {
    const m = await loadMod();
    assert.equal(m.ruleBasedPageType({ intent: 'Transactional', volume: 100 }), 'サービスページ');
    assert.equal(m.ruleBasedPageType({ intent: 'Commercial', volume: 50 }), 'サービスページ');
    assert.equal(m.ruleBasedPageType({ intent: 'Commercial', volume: 30 }), '事例ページ');
    assert.equal(m.ruleBasedPageType({ intent: 'Informational', volume: 100 }), 'コラム');
    assert.equal(m.ruleBasedPageType({ intent: 'Informational', volume: 10 }), 'コラム');
  });

  it('intentPrompt should generate a prompt with all items', async () => {
    const m = await loadMod();
    const items = [{ text: '展示会 ブース' }, { text: 'ブース 費用' }];
    const prompt = m.intentPrompt(items);
    assert.ok(prompt.includes('1. 展示会 ブース'));
    assert.ok(prompt.includes('2. ブース 費用'));
    assert.ok(prompt.includes('Informational'));
    assert.ok(prompt.includes('Commercial'));
    assert.ok(prompt.includes('Transactional'));
  });

  it('parseIntentResponse should parse LLM output per item', async () => {
    const m = await loadMod();
    const items = [{ text: '展示会 ブース' }, { text: 'ブース 費用' }, { text: 'ブース とは' }];
    const response = 'Commercial\nTransactional\nInformational';
    const result = m.parseIntentResponse(response, items);
    assert.equal(result[0], 'Commercial');
    assert.equal(result[1], 'Transactional');
    assert.equal(result[2], 'Informational');
  });

  it('parseIntentResponse should fallback to rule-based on invalid LLM output', async () => {
    const m = await loadMod();
    const items = [{ text: '展示会 ブース' }, { text: 'ブース とは' }];
    const response = 'Unknown\nInvalid';
    const result = m.parseIntentResponse(response, items);
    // マッチしない場合はルールベースにfallback
    assert.equal(result[0], 'Commercial');
    assert.equal(result[1], 'Informational');
  });

  it('categoryPrompt should include categories and items', async () => {
    const m = await loadMod();
    const items = [{ text: 'ブース 制作' }, { text: 'ブース デザイン' }];
    const categories = ['ブース制作', 'デザイン', 'レンタル'];
    const prompt = m.categoryPrompt(items, categories);
    assert.ok(prompt.includes('ブース制作'));
    assert.ok(prompt.includes('デザイン'));
    assert.ok(prompt.includes('1. ブース 制作'));
    assert.ok(prompt.includes('2. ブース デザイン'));
  });

  it('parseCategoryResponse should map responses to categories', async () => {
    const m = await loadMod();
    const items = [{ text: 'ブース 制作' }, { text: 'ブース デザイン' }];
    const categories = ['ブース制作', 'デザイン', 'レンタル'];
    const response = 'ブース制作\nデザイン';
    const result = m.parseCategoryResponse(response, items, categories);
    assert.equal(result[0], 'ブース制作');
    assert.equal(result[1], 'デザイン');
  });

  it('parseCategoryResponse should return 未分類 for unknown responses', async () => {
    const m = await loadMod();
    const items = [{ text: '未知のキーワード' }];
    const categories = ['ブース制作', 'デザイン'];
    const response = '不明なカテゴリ';
    const result = m.parseCategoryResponse(response, items, categories);
    assert.equal(result[0], '未分類');
  });

  it('pageTypePrompt should include keyword, intent and volume', async () => {
    const m = await loadMod();
    const items = [
      { keyword: '展示会 ブース', intent: 'Commercial', volume: 300 },
      { keyword: 'ブース レンタル', intent: 'Transactional', volume: 150 },
    ];
    const prompt = m.pageTypePrompt(items);
    assert.ok(prompt.includes('展示会 ブース'));
    assert.ok(prompt.includes('ブース レンタル'));
    assert.ok(prompt.includes('サービスページ'));
    assert.ok(prompt.includes('事例ページ'));
    assert.ok(prompt.includes('コラム'));
  });

  it('parsePageTypeResponse should map responses to page types', async () => {
    const m = await loadMod();
    const items = [
      { keyword: '展示会 ブース', intent: 'Commercial', volume: 300 },
      { keyword: 'ブース とは', intent: 'Informational', volume: 80 },
    ];
    const response = 'サービスページ\nコラム';
    const result = m.parsePageTypeResponse(response, items);
    assert.equal(result[0], 'サービスページ');
    assert.equal(result[1], 'コラム');
  });

  it('parsePageTypeResponse should fallback to rule-based on invalid output', async () => {
    const m = await loadMod();
    const items = [
      { keyword: '展示会 ブース', intent: 'Commercial', volume: 300 },
    ];
    const response = '';
    const result = m.parsePageTypeResponse(response, items);
    assert.equal(result[0], 'サービスページ');
  });

  it('batchClassify should return empty results for empty items', async () => {
    const m = await loadMod();
    const result = await m.batchClassify({ items: [], tasks: [{ key: 'test', prompt: () => '', defaultValue: '' }], dryRun: true });
    assert.deepEqual(result, { test: [] });
  });

  it('batchClassify should return default values in dry-run mode', async () => {
    const m = await loadMod();
    const result = await m.batchClassify({
      items: [{ text: 'KW1' }, { text: 'KW2' }],
      tasks: [{ key: 'intent', prompt: () => 'prompt', defaultValue: 'Commercial' }],
      dryRun: true,
    });
    assert.equal(result.intent.length, 2);
    assert.equal(result.intent[0], 'Commercial');
    assert.equal(result.intent[1], 'Commercial');
  });
});