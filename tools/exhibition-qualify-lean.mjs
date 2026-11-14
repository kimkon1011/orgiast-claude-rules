#!/usr/bin/env node
/**
 * 展示会ブース競合 - Lean方式AI資格認定
 * AIニュース提案 [X-0020] Step 4 (Lean)
 *
 * DiscoLikeの結果JSONを読み込み、低コストLLM(Gemini Flash)で
 * 各企業が展示会ブース事業者かを判定。
 *
 * 使い方:
 *   node tools/exhibition-qualify-lean.mjs [--input research/discolike-results-*.json]
 *
 * 前提: GEMINI_API_KEY or GROQ_API_KEY 環境変数
 * 出力: research/qualified-results-{{date}}.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;

// 直近のDiscoLike結果ファイルを探す
function findInput() {
  const inputArg = process.argv.find(a => a.startsWith('--input='));
  if (inputArg) return inputArg.split('=')[1];
  const files = globSync('research/discolike-results-*.json');
  if (files.length === 0) {
    console.error('DiscoLike結果ファイルが見つかりません。--input= で指定してください');
    process.exit(1);
  }
  return files.sort().reverse()[0];
}

async function callLLM(domain, name) {
  const prompt = `以下の企業が展示会ブース制作・イベント施工を事業として行っているかを判定してください。
企業名: ${name}
ドメイン: ${domain}

判定基準:
- 展示会ブースのデザイン・施工・運営をサービスに含む
- イベント空間の企画・制作を行っている
- 単なる会場レンタル・イベント運営代行ではない

JSONで出力:
{"is_match": true/false, "confidence": 0-100, "reason": "20字以内で理由"}`;

  if (GEMINI_KEY) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    try {
      return JSON.parse(text.replace(/```json?\n?/g, '').trim());
    } catch { return { is_match: false, confidence: 0, reason: 'parse error' }; }
  }

  if (GROQ_KEY) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.2-3b-preview',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      })
    });
    const data = await res.json();
    try { return JSON.parse(data.choices?.[0]?.message?.content || '{}'); }
    catch { return { is_match: false, confidence: 0, reason: 'parse error' }; }
  }

  console.error('GEMINI_API_KEY か GROQ_API_KEY を設定してください');
  process.exit(1);
}

async function main() {
  const inputFile = findInput();
  console.log(`入力: ${inputFile}`);
  const raw = JSON.parse(readFileSync(inputFile, 'utf-8'));
  const companies = raw.companies || raw.data || raw;
  console.log(`対象企業数: ${Array.isArray(companies) ? companies.length : 'N/A'}`);

  const results = [];
  const sampleSize = Math.min(10, Array.isArray(companies) ? companies.length : 0);

  // 10サンプルでテスト
  for (let i = 0; i < sampleSize; i++) {
    const c = companies[i];
    console.log(`\n[${i+1}/${sampleSize}] ${c.name} (${c.domain})`);
    const verdict = await callLLM(c.domain, c.name);
    console.log(`  → ${verdict.is_match ? '✅ 該当' : '❌ 非該当'} (信頼度:${verdict.confidence}%) ${verdict.reason}`);
    results.push({ domain: c.domain, name: c.name, ...verdict });
  }

  // 結果保存
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const outPath = `research/qualified-results-${date}.json`;
  writeFileSync(outPath, JSON.stringify({
    tested: sampleSize,
    matches: results.filter(r => r.is_match).length,
    results
  }, null, 2));
  console.log(`\n結果保存: ${outPath}`);
  console.log(`該当: ${results.filter(r => r.is_match).length}/${sampleSize}`);
}

main().catch(e => { console.error(e); process.exit(1); });