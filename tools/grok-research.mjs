// grok-research.mjs — xAI Grok を使ってX(旧Twitter)とYouTubeの投稿本文を取得するCLI。
// 使用方法: node tools/grok-research.mjs --question "<調べたいこと>" [--question-file <path>] [--out <path>] [--model grok-4.6]
// 認証: XAI_API_KEY (env または ~/.claude/xai.env)。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const BASE = 'https://api.x.ai/v1/responses';

export function getClaudeDir() {
  const home = process.env.ORGIAST_HOME || os.homedir();
  return path.join(home, '.claude');
}

export function loadKey() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const envFile = path.join(getClaudeDir(), 'xai.env');
  return readEnvValue(envFile, 'XAI_API_KEY') || '';
}

export function parseArgs(argv) {
  const options = {
    question: '',
    questionFile: '',
    out: '',
    model: 'grok-letca', // デフォルトモデル、--model で変更可
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--question' || arg === '-q') {
      options.question = argv[++i] || '';
    } else if (arg === '--question-file' || arg === '--question-path') {
      options.questionFile = argv[++i] || '';
    } else if (arg === '--out' || arg === '-o') {
      options.out = argv[++i] || '';
    } else if (arg === '--model' || arg === '-m') {
      options.model = argv[++i] || '';
    } else if (!arg.startsWith('-')) {
      // 位置引数として質問を扱う
      if (!options.question) {
        options.question = arg;
      } else {
        options.questionFile = arg;
      }
    }
  }

  return options;
}

export async function fetchResearch(options, dependencies = {}) {
  const {
    fetchFn = globalThis.fetch,
    fsFn = fs,
    getClaudeDirFn = getClaudeDir,
    loadKeyFn = loadKey,
  } = dependencies;

  const KEY = loadKeyFn();
  if (!KEY) {
    throw new Error('XAI_API_KEY 未設定 (env または ~/.claude/xai.env)');
  }

  // 質問の読み込み
  let question = options.question;
  if (options.questionFile) {
    try {
      question = fsFn.readFileSync(options.questionFile, 'utf8');
    } catch (err) {
      throw new Error(`質問ファイル '${options.questionFile}' を読み込めません: ${err.message}`);
    }
  }

  if (!question) {
    throw new Error('質問が空です。--question または --question-file で質問を指定してください。');
  }

  // --- xAI Agent Tools API 技術メモ ---
  // 2026-09-20 に実際に検証済み。正解の形式:
  //   - URL：https://api.x.ai/v1/responses
  //   - model: grok-4.6 (または --model で変更)
  //   - tools: [{type:"x_search"}, {type:"web_search"}]
  //   - ただし web_search が4xxで拒否された場合は、x_search だけで再試行。
  const requestBody = {
    model: options.model,
    input: [
      {
        role: 'system',
        content: `あなたはネズミ駆除製品の実際の使用者の声を検索する専門家です。
以下の制約を守ってください:
1. 根拠はX（Twitter）の投稿、YouTubeの動画とそのコメント、Yahoo!知恵袋、通販レビュー（低評価も）、5ch、個人ブログなど実際の使用者の声のみ。
2. メーカー・販売店・駆除業者・まとめサイトの宣伝は根拠にしない。
3. 各主張には出典URL（投稿・動画・レビューのURL）を付ける。
4. 効いた声と効かなかった声を両方見つけて、件数の目安付きで書く。
5. 見つからないものは「見つからなかった」と書き、推測で埋めない。
6. 投稿者名やプロフィールなど個人を特定する情報は書かない（URLと要旨だけ）。

質問: ${question}`
      },
      {
        role: 'user',
        content: `以下の制約に従って、質問に答えてください。
1. 根拠のみ実際の使用者の声とする。
2. 出典URLを必ず付ける。
3. 効いた声と効かなかった声の両方を挙げる。
4. 見つからないものは「見つからなかった」と書く。
5. 個人を特定する情報は書かない。

質問: ${question}`
      }
    ],
    tools: [
      { type: 'x_search' },
      { type: 'web_search' }
    ]
  };

  let response = await fetchFn(BASE, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  // web_search が4xxで拒否された場合は、x_search だけで再試行
  if (!response.ok && response.status >= 400 && response.status < 500) {
    const errText = await response.text().catch(() => '');
    // web_search ツールを外して再試行
    const retryRequestBody = JSON.parse(JSON.stringify(requestBody)); // ディープコピー
    retryRequestBody.tools = [{ type: 'x_search' }];
    
    response = await fetchFn(BASE, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(retryRequestBody)
    });
    
    // エラー再スロー前、ユーザーにweb_search失敗の旨を通知
    const status = response.status;
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // --web-search-fail-action チェックを実装したCLIで通知、ここでは err を投げる
      // 下記のコメントはCLIでの処理用
      // console.error(`––– Web検索が失敗しました(${status}) –––\n${text.slice(0, 200)}\n––– 再試行で x_search のみを使用–––`);
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Grok API呼び出し失敗 (Status: ${response.status}): ${errText.slice(0, 300)}`);
  }

  const json = await response.json();
  // Responses API: output は複数アイテムの配列。type:'message' の中の type:'output_text' を拾う。
  const text = json.output_text
    ?? json.output?.flatMap((item) => item.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('\n')
    ?? '';
  const citations = json.output?.flatMap((item) => item.content ?? [])
    .filter((c) => c.type === 'source' || c.type === 'citation')
    .map((c) => c.url) ?? [];
  const usage = json.usage ?? {};

  // Log usage into executor-usage.jsonl
  try {
    const usageFilePath = path.join(getClaudeDirFn(), 'executor-usage.jsonl');
    const logLine = JSON.stringify({
      t: new Date().toISOString(),
      provider: 'grok',
      model: options.model,
      in: usage.input_tokens ?? usage.prompt_tokens ?? 0,
      out: usage.output_tokens ?? usage.completion_tokens ?? 0,
      x_research: true,
    }) + '\n';
    fsFn.appendFileSync(usageFilePath, logLine);
  } catch (e) {
    // Fail silently on usage logging errors
  }

  return {
    text: text.trim() || '(出力なし)',
    citations,
    usage,
  };
}

export async function runCli(argv, dependencies = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
  } = dependencies;

  try {
    const options = parseArgs(argv);
    if (!options.question && !options.questionFile) {
      stderr.write('使い方: node tools/grok-research.mjs --question "<質問>" [--question-file <path>] [--out <path>] [--model <model>]\n');
      stderr.write('または: node tools/grok-research.mjs "<質問>" [--question-file <path>] [--out <path>] [--model <model>]\n');
      return 2;
    }

    stdout.write(`Grok Research: 質問: ${options.question ? options.question.substring(0, 50) + '...' : ''}\n`);
    stdout.write(`モデル: ${options.model}\n`);
    if (options.out) {
      stdout.write(`出力先: ${options.out}\n`);
    }

    const result = await fetchResearch(options, dependencies);
    stdout.write('\n--- 調査結果 ---\n');
    stdout.write(`${result.text}\n`);
    stdout.write('----------------\n');
    if (result.citations?.length) {
      stdout.write(`出典: ${result.citations.join(', ')}\n`);
    }
    const inTok = result.usage.input_tokens ?? result.usage.prompt_tokens ?? 0;
    const outTok = result.usage.output_tokens ?? result.usage.completion_tokens ?? 0;
    stderr.write(`[grok ${options.model}] in=${inTok} out=${outTok}\n`);

    // ファイル出力
    if (options.out) {
      try {
        fs.writeFileSync(options.out, result.text, 'utf8');
        stdout.write(`結果を ${options.out} に保存しました\n`);
      } catch (err) {
        stderr.write(`出力ファイル '${options.out}' への書き込みに失敗しました: ${err.message}\n`);
        return 1;
      }
    }

    return 0;
  } catch (error) {
    stderr.write(`エラー: ${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}