// 使用者の声を xAI Responses API で調べる CLI。
import fs from 'node:fs';
import path from 'node:path';
import { getClaudeDir, loadKey } from './grok-x-fetch.mjs';
import { isEntry } from './is-entry.mjs';

export const SYSTEM_PROMPT = `実際の使用者の声を調査し、日本語で回答してください。
根拠は X の投稿、YouTube の動画とそのコメント、Yahoo!知恵袋、通販レビュー（低評価も）、5ch、個人ブログなど、実際の使用者の声だけに限定してください。
メーカー・販売店・駆除業者・まとめサイトの宣伝は根拠にしないでください。
各主張に出典 URL（投稿・動画・レビューの URL）を付けてください。
効いた声と、効かなかった／突破された／かじられた声を両方、件数の目安つきで書いてください。同じ体験の重複を避け、確認できた件数と世間全体の割合を混同しないでください。
見つからないものは「見つからなかった」と書き、推測で埋めないでください。動画のコメントを直接確認できない場合も明記してください。
投稿者名やプロフィールなど個人を特定する情報は書かず、投稿の URL と要旨だけにしてください。`;

export function parseArgs(argv) {
  const options = { question: '', questionFile: '', out: '', model: 'grok-4.6' };
  const flags = { '--question': 'question', '--question-file': 'questionFile', '--out': 'out', '--model': 'model' };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`引数が不正です: ${argv[i]}`);
    options[key] = argv[++i];
  }
  return options;
}

export function extractResponse(json) {
  const parts = (json.output ?? []).flatMap(item => item.content ?? []);
  const text = (json.output_text || parts.filter(p => p.type === 'output_text').map(p => p.text ?? '').join('\n')).trim();
  const urls = new Set();
  function visit(value) {
    if (typeof value === 'string' && /^https?:\/\/\S+$/.test(value)) urls.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(json.citations);
  visit(json.annotations);
  for (const item of json.output ?? []) {
    visit(item.annotations);
    for (const part of item.content ?? []) {
      visit(part.annotations);
      visit(part.citations);
      if (['source', 'citation'].includes(part.type)) visit(part.url);
    }
  }
  return { text, citations: [...urls], usage: json.usage ?? {} };
}

export async function runCli(argv, dependencies = {}) {
  const { fetchFn = globalThis.fetch, fsFn = fs, loadKeyFn = loadKey,
    getClaudeDirFn = getClaudeDir, stdout = process.stdout, stderr = process.stderr } = dependencies;
  let key = '';
  const redact = value => key ? String(value).split(key).join('[REDACTED]') : String(value);
  try {
    key = loadKeyFn();
    if (!key) { stderr.write('XAI_API_KEY 未設定 (env もしくは ~/.claude/xai.env)\n'); return 2; }
    const options = parseArgs(argv);
    const question = [options.question, options.questionFile ? fsFn.readFileSync(options.questionFile, 'utf8') : ''].filter(Boolean).join('\n').trim();
    if (!question) throw new Error('--question または --question-file を指定してください');
    const body = { model: options.model, input: [
      { role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: question }
    ], tools: [{ type: 'x_search' }, { type: 'web_search' }] };
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetchFn('https://api.x.ai/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!response.ok) {
        const error = await response.text();
        if (attempt === 0 && response.status >= 400 && response.status < 500 && response.status !== 402
            && /web_search/i.test(error) && /unsupported|not supported|not allowed|invalid|unavailable|unknown|reject|not enabled|not permitted/i.test(error)) {
          stderr.write(redact(`web_search が拒否されました (${response.status}): ${error}\nx_search のみで再試行します。YouTube 等の調査範囲は制限されます。\n`));
          body.tools = [{ type: 'x_search' }];
          continue;
        }
        throw new Error(`Grok API呼び出し失敗 (Status: ${response.status}): ${error}`);
      }
      const json = await response.json();
      result = extractResponse(json);
      try {
        fsFn.appendFileSync(path.join(getClaudeDirFn(), 'executor-usage.jsonl'), JSON.stringify({
          t: new Date().toISOString(), provider: 'grok', model: options.model,
          in: result.usage.input_tokens ?? result.usage.prompt_tokens ?? 0,
          out: result.usage.output_tokens ?? result.usage.completion_tokens ?? 0
        }) + '\n');
      } catch { /* 使用量ログの失敗は調査を止めない。 */ }
      break;
    }
    if (!result?.text) throw new Error('Grok 応答に本文がありません (output_text / output[].content[].text)');
    const output = redact(`${result.text}\n${result.citations.length ? `\n出典 URL:\n${result.citations.map(url => `- ${url}`).join('\n')}\n` : ''}`);
    if (options.out) fsFn.writeFileSync(options.out, output, 'utf8');
    stdout.write(output);
    return 0;
  } catch (error) {
    stderr.write(`エラー: ${redact(error.message)}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));
