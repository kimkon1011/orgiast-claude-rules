// kim 宛の通知本文から「システムを知らない人には読めない内部用語」を検出し、
// 安い LLM で平易な日本語に書き換える。通知の送信を止めないことが最優先で、
// 例外は投げず、LLM が全滅しても検出語を除去した文にフォールバックする。
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 検出対象のパターン。順序は表示順ではなく、除去時の優先度に影響しない。
// 長い(具体的な)パターンを先に置き、短い断片が識別子を分割しないようにする。
const PATTERNS = [
  // コマンド行(gh / git / node / npm / npx / pnpm / yarn / python / pwsh / powershell / bash / sh / curl / robocopy / clasp)
  { name: 'command', re: /\b(?:gh|git|node|npm|npx|pnpm|yarn|python3?|pwsh|powershell|bash|sh|curl|robocopy|clasp)\s+[^\s、。，,]+(?:\s+[^\s、。，,]+)*/g },
  // PR 番号 / issue 番号
  { name: 'pr', re: /(?:PR|pr|#)\s?\d+/g },
  // exit コード
  { name: 'exit', re: /\bexit\s+\d+/gi },
  // ISO 日時
  { name: 'iso', re: /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g },
  // key=value 形式
  { name: 'kv', re: /\b[A-Za-z_][A-Za-z0-9_]*=[^\s、。，,]+/g },
  // 7桁以上の16進ハッシュ
  { name: 'hash', re: /\b[0-9a-f]{7,40}\b/gi },
  // 英数字と _ - を含む識別子(内部名・スラッグ)。英大文字語もここで丸ごと拾う。
  { name: 'identifier', re: /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/g },
  // 英大文字語(CI / SUCCESS / MERGED / FAILED / OK / NG など)
  { name: 'upper', re: /\b[A-Z][A-Z0-9_]{1,}\b/g },
];

// 高校生でも普通に分かる略語は「内部用語」として扱わない。
// これを含めると、LLM が文脈上どうしても残す語を「まだ内部用語が残っている」と
// 誤判定し、除去フォールバックで意味が壊れる(例:「新AI候補」→「新候補」)。
const COMMON_WORDS = new Set(['AI', 'URL', 'ID', 'OK', 'NG', 'PC', 'OS', 'DB', 'PDF', 'CSV', 'GPU', 'CPU', 'QR']);

// ホスト名は末尾の全角括弧内にだけ現れる運用なので、その範囲は検出から除外する。
const HOST_TAIL_RE = /（[^（）]*）\s*$/;
// 定型の返信語(「止めて」「続けて」など)を含む行は LLM に触らせない。
const REPLY_HINT_RE = /「[^」]*」/;
// LLM から見える退避用の目印。日本語の鉤括弧なので findJargon には掛からない。
const HOST_TOKEN = '〔この端末〕';
const FIXED_TOKEN = (i) => `〔そのまま${i}〕`;

function stripHostTail(text) {
  const source = String(text ?? '');
  const match = source.match(HOST_TAIL_RE);
  if (!match) return { body: source, host: '' };
  return { body: source.slice(0, match.index), host: match[0] };
}

// 内部用語を検出して、出現順・重複なしの配列で返す純関数。
// 長い一致に含まれる断片(例: feedback-zero-sweep の中の feedback)は別項目にしない。
export function findJargon(text) {
  const { body } = stripHostTail(text);
  const found = [];
  const seen = new Set();
  const covered = [];
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(body)) !== null) {
      const token = match[0].trim();
      if (match.index === re.lastIndex) re.lastIndex++;
      if (!token || seen.has(token) || COMMON_WORDS.has(token)) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (covered.some(([s, e]) => start >= s && end <= e)) continue;
      seen.add(token);
      covered.push([start, end]);
      found.push(token);
    }
  }
  return found;
}

// 検出語を本文から取り除く最終フォールバック。空になったら「内部の作業」を返す。
export function stripJargon(text) {
  const { body, host } = stripHostTail(text);
  let cleaned = body;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    cleaned = cleaned.replace(re, (token) => (COMMON_WORDS.has(token.trim()) ? token : ' '));
  }
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([、。，,])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) cleaned = '内部の作業';
  return `${cleaned}${host}`;
}

const PROMPT = '次の文を、システムを知らない高校生でも分かる短い日本語に書き換えて。英語の内部名・コマンド・ID・日時・番号は出さず、何のための作業か・何が分かったかだけ書く。1〜2文。〔　〕で囲まれた語は書き換えず、その場所にそのまま残す。書き換えた文だけ返す。';

// 既定の ask: llm-ask.mjs を子プロセスで呼ぶ。kimi → gemini → openrouter の順に試す。
async function defaultAsk(prompt, { timeoutMs = 30_000 } = {}) {
  const cli = fileURLToPath(new URL('../llm-ask.mjs', import.meta.url));
  const providers = ['kimi', 'gemini', 'openrouter'];
  const deadline = Date.now() + timeoutMs;
  for (const provider of providers) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile(process.execPath, [cli, '--provider', provider, '--no-fallback', '--max', '400', prompt],
          { timeout: remaining, maxBuffer: 64 * 1024, windowsHide: true },
          (error, out) => (error ? reject(error) : resolve(out)));
      });
      const text = String(stdout ?? '').trim();
      if (text) return text;
    } catch { /* 次のプロバイダへ */ }
  }
  return '';
}

// LLM に渡す前に、変えてはいけない部分を目印へ退避する。
// - 末尾ホスト名(全角括弧) → 〔この端末〕
// - 「止めて」「続けて」など定型返信語を含む行 → 〔そのままN〕
function maskFixed(text) {
  const { body, host } = stripHostTail(text);
  const hostText = host.trim();
  const maskedHost = hostText ? `${body}${HOST_TOKEN}` : body;
  const fixed = [];
  const masked = maskedHost.split('\n').map((line) => {
    if (!REPLY_HINT_RE.test(line)) return line;
    fixed.push(line);
    return FIXED_TOKEN(fixed.length - 1);
  }).join('\n');
  return { masked, host: hostText, fixed };
}

// LLM の出力に目印を戻す。目印ごと消されていたら元の行・ホスト名を末尾に補う。
function unmaskFixed(rewritten, { host, fixed }) {
  let out = String(rewritten ?? '').replace(/〔そのまま(\d+)〕/g, (whole, i) => fixed[Number(i)] ?? whole);
  for (const line of fixed) if (!out.includes(line)) out += `\n${line}`;
  out = out.replaceAll(HOST_TOKEN, host);
  if (host && !out.includes(host)) out += host;
  return out.trim();
}

// 本文を平易な日本語にする。例外は投げず、必ず文字列を返す。
export async function toPlainJa(text, { ask = defaultAsk, timeoutMs = 30_000 } = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return source;
  if (findJargon(source).length === 0) return source;
  const protectedParts = maskFixed(source);
  try {
    const rewritten = String(await ask(`${PROMPT}\n\n${protectedParts.masked}`, { timeoutMs }) ?? '').trim();
    if (rewritten) {
      const out = unmaskFixed(rewritten, protectedParts);
      if (out && findJargon(out).length === 0) return out;
    }
  } catch { /* フォールバックへ */ }
  return stripJargon(source);
}
