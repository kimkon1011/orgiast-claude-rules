/**
 * バッチLLM分類ユーティリティ
 *
 * 「ツールはリストを受け入れループ回避」原則（X-0013）に基づき、
 * 複数アイテムのLLM分類を1回の呼出しで行う。Siriの最大32ツールコール制約にも対応。
 *
 * 使い方:
 *   import { batchClassify } from './batch-classify.mjs';
 *   const [intents, categories] = await batchClassify({
 *     items: [{ text }, { text }],
 *     tasks: [
 *       { key: 'intent', prompt: (items) => `...${items.map(i => i.text).join('\n')}...` },
 *       { key: 'category', prompt: (items) => `...` },
 *     ],
 *     dryRun: false,
 *   });
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LLM_PATH = path.resolve(__dirname, '..', '..', '..', 'tools', 'llm-ask.mjs');
const execute = promisify(execFile);

/**
 * 複数アイテムのLLM分類をバッチで1回の呼出しにまとめる。
 *
 * @param {object} options
 * @param {Array} options.items - 分類対象のアイテム配列
 * @param {Array<{key: string, prompt: (items: Array) => string, parse: (response: string, items: Array) => Array}>} options.tasks
 *   各タスク: key=結果のキー名, prompt=LLMプロンプト生成関数, parse=応答パース関数
 * @param {boolean} [options.dryRun=false] - dry-run時はLLM呼ばずrule-based
 * @param {object} [options.defaultParse] - parse未指定時の既定パーサ（各行をアイテムごとにtrim）
 * @returns {Promise<object>} - { [taskKey]: Array<結果> } 各タスクの結果配列
 */
export async function batchClassify(options) {
  const { items, tasks, dryRun = false } = options;

  if (!items || !items.length || !tasks || !tasks.length) {
    const empty = {};
    for (const task of tasks || []) empty[task.key] = [];
    return empty;
  }

  const results = {};
  for (const task of tasks) {
    const { key, prompt: promptFn, parse: parseFn } = task;
    if (dryRun) {
      // dry-run: ルールベースの既定値を返す
      results[key] = items.map((_, i) => task.defaultValue || '');
      continue;
    }

    const prompt = promptFn(items);
    try {
      const { stdout } = await execute(
        process.execPath,
        [LLM_PATH, '--provider', 'groq', '--prefer-provider', '--category', 'classification', '--max', '4096', prompt],
        { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
      );
      const response = stdout.trim();
      results[key] = parseFn ? parseFn(response, items) : defaultParse(response, items);
    } catch (error) {
      console.error(`  バッチ分類失敗 (${key}): ${error.message}`);
      results[key] = items.map((_, i) => task.defaultValue || '');
    }
  }
  return results;
}

/** 既定パーサ: 各行をtrimして配列に */
function defaultParse(response, items) {
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
  // 行数がアイテム数より多い場合は上位N件だけ使う
  return items.map((_, i) => lines[i] || '');
}

/**
 * 意図分類のためのプロンプト生成
 * @param {Array<{text: string}>} items
 */
export function intentPrompt(items) {
  const lines = items.map((item, i) => `${i + 1}. ${item.text}`).join('\n');
  return `以下のキーワードそれぞれの検索意図を分類してください。
選択肢: Informational（情報収集）/ Commercial（比較検討）/ Transactional（購入・申込）
回答は行ごとにキーワードの意図のみ（1単語）を出力し、番号や説明を付けないでください。

${lines}

回答:
1.`;
}

/**
 * 意図分類のパーサ
 */
export function parseIntentResponse(response, items) {
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
  return items.map((_, i) => {
    const answer = lines[i] || '';
    const matched = ['Informational', 'Commercial', 'Transactional'].find(
      intent => new RegExp(`\\b${intent}\\b`, 'i').test(answer)
    );
    return matched || ruleBasedIntent(items[i].text);
  });
}

/**
 * カテゴリ分類のためのプロンプト生成
 */
export function categoryPrompt(items, categories) {
  const lines = items.map((item, i) => `${i + 1}. ${item.text}`).join('\n');
  return `以下のキーワードを最も近いカテゴリに分類してください。
選択肢: ${categories.join(' / ')}
回答は行ごとにキーワードのカテゴリ名のみを出力し、番号や説明を付けないでください。

${lines}

回答:
1.`;
}

/**
 * カテゴリ分類のパーサ
 */
export function parseCategoryResponse(response, items, categories) {
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
  return items.map((_, i) => {
    const answer = lines[i] || '';
    return categories.find(cat => answer.includes(cat)) || '未分類';
  });
}

/**
 * ページ種別推奨のためのプロンプト生成
 */
export function pageTypePrompt(items) {
  const lines = items.map((item, i) => `${i + 1}. キーワード: ${item.keyword}, 意図: ${item.intent}, ボリューム: ${item.volume}`).join('\n');
  return `以下のキーワードそれぞれに最適なページ種別を選んでください。
選択肢: サービスページ（高意図・高ボリューム）/ 事例ページ（高意図・低ボリューム）/ コラム（低意図・高ボリューム）
回答は行ごとに「サービスページ」「事例ページ」「コラム」のいずれかのみを出力してください。

${lines}

回答:
1.`;
}

/**
 * ページ種別のパーサ
 */
export function parsePageTypeResponse(response, items) {
  const lines = response.split('\n').map(l => l.trim()).filter(Boolean);
  const validTypes = ['サービスページ', '事例ページ', 'コラム'];
  return items.map((_, i) => {
    const answer = lines[i] || '';
    return validTypes.find(t => answer.includes(t)) || ruleBasedPageType(items[i]);
  });
}

// ---- ルールベース関数（dry-run / fallback用） ----

export function ruleBasedIntent(keyword) {
  if (/費用|価格|料金/.test(keyword)) return 'Transactional';
  if (/代行|依頼|申込|見積/.test(keyword)) return 'Transactional';
  if (/とは|意味|方法|違い/.test(keyword)) return 'Informational';
  return 'Commercial';
}

export function ruleBasedPageType(keyword) {
  const volume = Number(keyword.volume) || 0;
  if (keyword.intent === 'Transactional' || (keyword.intent === 'Commercial' && volume >= 50)) return 'サービスページ';
  if (keyword.intent === 'Commercial') return '事例ページ';
  return 'コラム';
}