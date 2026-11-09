#!/usr/bin/env node

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';

const execFileAsync = promisify(execFile);
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const llmAsk = path.join(toolsDir, 'llm-ask.mjs');

export const SYSTEM_PROMPT = 'あなたはマーケティングとコンテンツ戦略の専門家です。与えられたキーワードについて、Web記事を企画するための分析結果をJSONで返してください。';

export function parseArgs(argv) {
  const options = { keyword: '', format: 'md' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keyword' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.keyword = argv[++i].trim();
    else if (argv[i] === '--json') options.format = 'json';
    else if (argv[i] === '--format' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.format = argv[++i].toLowerCase();
  }
  return options;
}

export function buildPrompt(keyword) {
  return `キーワード「${keyword}」について、以下を生成してください：

1. 関連サジェストキーワード（5-10件）：このキーワードで検索する人が同時に調べそうな関連語
2. 再検索ワード（3-5件）：ファネルを深掘りするための具体的な検索フレーズ
3. 読者ペルソナ（2-3人）：この記事の典型的な読者像（属性・関心・課題）
4. 記事構成案（1-3案）：読者を引き込む構成（タイトル・見出し構成）
5. 記事品質チェックリスト（5-10項目）：記事が満たすべき品質基準

必ず以下のJSON形式で返してください。余計な説明は不要です。
{
  "suggestions": ["..."],
  "searchTerms": ["..."],
  "personas": [{ "name": "ペルソナ名", "attributes": "属性", "interests": "関心", "challenges": "課題" }],
  "outlines": [{ "title": "記事タイトル", "headings": ["見出し1", "見出し2"] }],
  "qualityChecklist": ["項目1"]
}`;
}

export function parseLlmResponse(raw) {
  const text = String(raw ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [text, fenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  throw new Error('LLM応答をJSONとして解析できませんでした');
}

function strings(value) {
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

export function normalizeResult(keyword, value) {
  return {
    keyword,
    suggestions: strings(value.suggestions),
    searchTerms: strings(value.searchTerms),
    personas: Array.isArray(value.personas) ? value.personas.map(item => ({
      name: String(item?.name ?? ''), attributes: String(item?.attributes ?? ''),
      interests: String(item?.interests ?? ''), challenges: String(item?.challenges ?? ''),
    })) : [],
    outlines: Array.isArray(value.outlines) ? value.outlines.map(item => ({
      title: String(item?.title ?? ''), headings: strings(item?.headings),
    })) : [],
    qualityChecklist: strings(value.qualityChecklist),
  };
}

export function formatMarkdown(result) {
  const lines = [`# AIニュース提案: ${result.keyword}`, '', '## 関連サジェストキーワード'];
  result.suggestions.forEach(item => lines.push(`- ${item}`));
  lines.push('', '## 再検索ワード');
  result.searchTerms.forEach(item => lines.push(`1. ${item}`));
  lines.push('', '## 読者ペルソナ');
  result.personas.forEach((item, index) => lines.push(
    `### ペルソナ${index + 1}: ${item.name}`, `- **属性**: ${item.attributes}`,
    `- **関心**: ${item.interests}`, `- **課題**: ${item.challenges}`, '',
  ));
  lines.push('## 記事構成案');
  result.outlines.forEach((item, index) => {
    lines.push(`### 案${String.fromCharCode(65 + index)}: ${item.title}`);
    item.headings.forEach(heading => lines.push(`1. ${heading}`));
    lines.push('');
  });
  lines.push('## 記事品質チェックリスト');
  result.qualityChecklist.forEach(item => lines.push(`- [ ] ${item}`));
  return lines.join('\n').trimEnd();
}

async function defaultRunProvider(provider, prompt) {
  const args = [llmAsk, '--provider', provider, '--prefer-provider', '--no-fallback', '--category', 'newswire', '--system', SYSTEM_PROMPT, '--max', '4000', prompt];
  const { stdout } = await execFileAsync(process.execPath, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

export async function generateProposal(keyword, runProvider = defaultRunProvider) {
  const prompt = buildPrompt(keyword);
  const errors = [];
  for (const provider of ['gemini', 'groq']) {
    try {
      return normalizeResult(keyword, parseLlmResponse(await runProvider(provider, prompt)));
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
    }
  }
  throw new Error(`AIニュース提案を生成できませんでした（${errors.join(' / ')}）`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.keyword) throw new Error('キーワードが指定されていません。--keyword <text> を指定してください。');
  if (!['md', 'json'].includes(options.format)) throw new Error('--format は md または json を指定してください。');
  const result = await generateProposal(options.keyword);
  console.log(options.format === 'json' ? JSON.stringify(result, null, 2) : formatMarkdown(result));
}

if (isEntry(import.meta.url)) {
  main().catch(error => {
    console.error(`エラー: ${error.message}`);
    process.exitCode = 1;
  });
}
