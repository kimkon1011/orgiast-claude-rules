#!/usr/bin/env node
/**
 * X-0001: 正規表現でAIクエリ抽出
 * 疑問文系と依頼文系を正規表現で抽出し、LLMO分析に使う。
 * 展示会ブース制作・イベント関連サイトの検索クエリやLINE投稿などから
 * ユーザーの意図（質問／依頼）を分類する。
 */
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';

// ─── 疑問文系 正規表現 ──────────────────────────────────────────
// 個別の小さな正規表現に分割（長い alternation は Node 24 で構文エラーを避ける）
// splitSentences が句点を含むため、文末は [。？?]? を許容する
const Q_END = '(?:[。？?])?\\s*$';

const QUESTION_RULES = [
  // 文末の疑問符（日本語・英語両対応）
  { name: '疑問符', test: (s) => /[？?]\s*$/mu.test(s) },
  // 疑問詞を含む文（末尾がか/です/ます/だろ���/の）
  { name: '疑問詞', test: (s) => new RegExp(
    '(?:何|なぜ|なに|どう|どの|どこ|だれ|誰|いつ|いくら|いくつ|何故|どうして|なんで|どうやって|どんな|何の|どのよう|いかが).{0,20}(?:か|です|ます|だろう|でしょう|の|のか)' + Q_END, 'mu'
  ).test(s) },
  // 文末が「か」「でしょうか」「ですか」「ますか」で終わる
  { name: '文末疑問', test: (s) => new RegExp(
    '(?:か|でしょうか|ですか|ますか|ませんか|たいですか|んですか|んでしょうか|のでしょうか|だろうか|のだろう|のかな|かしら|かな)' + Q_END, 'mu'
  ).test(s) },
  // 丁寧な疑問（可能ですか？いただけますか？）
  { name: '丁寧疑問', test: (s) => new RegExp(
    '(?:可能でしょうか|可能ですか|いただけますか|いただけないでしょうか|よろしいでしょうか|頂けますか)' + Q_END, 'mu'
  ).test(s) },
  // 条件式疑問（〜場合/とき/際＋疑問）
  { name: '条件疑問', test: (s) => new RegExp(
    '(?:場合|とき|際).{0,30}(?:か|でしょうか|ますか)' + Q_END, 'mu'
  ).test(s) },
];

// ─── 依頼文系 正規表現 ──────────────────────────────────────────
const R_END = '(?:[。？?])?\\s*$';

const REQUEST_RULES = [
  { name: '〜てください', test: (s) => new RegExp('(?:て|で)ください' + R_END, 'mu').test(s) },
  { name: '〜してほしい', test: (s) => new RegExp('(?:て|で)(?:ほしい|もらいたい)' + R_END, 'mu').test(s) },
  { name: '〜お願い', test: (s) => new RegExp('(?:お願い|おねがい)(?:します|いたします)?' + R_END, 'mu').test(s) },
  { name: '〜教えて', test: (s) => new RegExp('教えて(?:ください)?' + R_END, 'mu').test(s) },
  { name: '〜知りたい', test: (s) => new RegExp('(?:について|ことを|方法を|を)知りたい' + R_END, 'mu').test(s) },
  { name: '〜調べて', test: (s) => new RegExp('調べて(?:ください|ほしい|もらえ)?' + R_END, 'mu').test(s) },
  { name: '〜依頼希望', test: (s) => new RegExp('(?:可能|できますか|可能でしょうか)' + R_END, 'mu').test(s) },
  { name: '〜たい希望', test: (s) => new RegExp(
    '(?:見積もり|見積|依頼|相談|提案|紹介|比較|調査|確認|連絡|送付|回答|返信)(?:し)?たい' + R_END, 'mu'
  ).test(s) },
  { name: '〜依頼', test: (s) => new RegExp('(?:の)?依頼' + R_END, 'mu').test(s) },
  { name: '〜見積もり', test: (s) => new RegExp('(?:見積もり|見積)[を]?' + R_END, 'mu').test(s) },
];

// いただけますか／頂けますか は依頼と疑問の両方
const BOTH_RULES = [
  { name: 'いただけますか', test: (s) => /(?:いただけ|頂け)(?:ますか|ないでしょうか)[？?]?\s*$/mu.test(s) },
];

// ─── 文分割 ──────────────────────────────────────────────────────
// 日本語文を分割する。句点（。！？!?）＋改行または文末で区切る
export function splitSentences(text) {
  if (!text) return [];
  // 改行・句点・疑問符・感嘆符で分割
  const raw = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？!?\n])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);

  // さらに長文を「。」で再分割（splitで食い切れなかった場合）
  const result = [];
  for (const part of raw) {
    if (part.includes('。') && !part.match(/^[^。]{1,20}$/)) {
      const sub = part.split(/(?<=。)/u).map((s) => s.trim()).filter(Boolean);
      result.push(...sub);
    } else {
      result.push(part);
    }
  }
  return result.filter((s) => s.length >= 2);
}

// ─── 抽出ロジック ──────────────────────���─────────────────────────
export function extractQueries(text) {
  const sentences = splitSentences(text);
  const results = [];

  for (const sentence of sentences) {
    const questions = [];
    const requests = [];

    for (const rule of QUESTION_RULES) {
      if (rule.test(sentence)) {
        questions.push(rule.name);
      }
    }

    for (const rule of REQUEST_RULES) {
      if (rule.test(sentence)) {
        requests.push(rule.name);
      }
    }

    for (const rule of BOTH_RULES) {
      if (rule.test(sentence)) {
        questions.push(rule.name);
        requests.push(rule.name);
      }
    }

    // 疑問符を含む文は最低限「疑問符」としてマーク（漏れ防止）
    if (questions.length === 0 && /[？?]/u.test(sentence)) {
      questions.push('疑問符');
    }

    if (questions.length > 0 || requests.length > 0) {
      results.push({
        text: sentence,
        type: questions.length > 0 && requests.length > 0
          ? 'both'
          : questions.length > 0
            ? 'question'
            : 'request',
        matchedPatterns: {
          question: questions,
          request: requests,
        },
      });
    }
  }

  return results;
}

// ─── 統計 ────────────────────────────────────────────────────────
export function summarizeResults(results) {
  const total = results.length;
  const questions = results.filter((r) => r.type === 'question').length;
  const requests = results.filter((r) => r.type === 'request').length;
  const both = results.filter((r) => r.type === 'both').length;

  // 出現パターンの集計
  const patternCounts = {};
  for (const r of results) {
    for (const [cat, patterns] of Object.entries(r.matchedPatterns)) {
      for (const p of patterns) {
        const key = `${cat}:${p}`;
        patternCounts[key] = (patternCounts[key] || 0) + 1;
      }
    }
  }

  const topPatterns = Object.entries(patternCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => ({ pattern: key, count }));

  return { total, questions, requests, both, topPatterns };
}

// ─── CLI ─────────────────────────────────────────────────────────
export function parseArgs(args) {
  const file = args.find((a) => !a.startsWith('--'));
  const format = args.includes('--json') ? 'json' : 'text';
  const summarize = args.includes('--summary');
  return { file, format, summarize };
}

export async function runCli(args, options = {}) {
  const log = options.log || console.log;
  const cli = parseArgs(args);

  try {
    let text;
    if (cli.file) {
      text = fs.readFileSync(cli.file, 'utf-8');
    } else {
      // stdin から読み取り
      text = await new Promise((resolve) => {
        const chunks = [];
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(chunks.join('')));
        // パイプされていない場合はタイムアウト
        if (process.stdin.isTTY) {
          setTimeout(() => resolve(''), 100);
        }
      });
      if (!text) {
        log('使用方法: node tools/ai-query-extract.mjs [ファイルパス] [--json] [--summary]');
        log('  ファイルを指定するか、パイプでテキストを渡してください。');
        return 0;
      }
    }

    const results = extractQueries(text);
    const summary = summarizeResults(results);

    if (cli.format === 'json') {
      const output = { count: results.length, results, summary };
      log(JSON.stringify(output, null, 2));
    } else if (cli.summarize) {
      log('--- 抽出結果 ---');
      log(`総文: ${summary.total}`);
      log(`疑問文系: ${summary.questions}`);
      log(`依頼文系: ${summary.requests}`);
      log(`両方: ${summary.both}`);
      log('');
      log('--- 上位パターン ---');
      for (const p of summary.topPatterns) {
        log(`  ${p.pattern}: ${p.count}件`);
      }
      log('');
      log('--- 抽出クエリ ---');
      for (const r of results) {
        const tag = r.type === 'question' ? '?' : r.type === 'request' ? 'R' : 'B';
        log(`${tag} [${r.type}] ${r.text.slice(0, 120)}`);
      }
    } else {
      for (const r of results) {
        const tag = r.type === 'question' ? '?' : r.type === 'request' ? 'R' : 'B';
        const patterns = [...r.matchedPatterns.question, ...r.matchedPatterns.request].join(', ');
        log(`${tag} [${r.type}] (${patterns}): ${r.text}`);
      }
      log(`--- 合計: ${results.length}件（疑問:${summary.questions} / 依頼:${summary.requests} / 両方:${summary.both}）`);
    }
  } catch (error) {
    log(`error:${error.message}`);
    return 1;
  }
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
