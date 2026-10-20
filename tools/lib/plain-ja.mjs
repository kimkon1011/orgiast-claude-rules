// kim 宛の通知本文から「システムを知らない人には読めない内部用語」を検出し、
// 安い LLM で平易な日本語に書き換える。通知の送信を止めないことが最優先で、
// 例外は投げず、LLM が全滅しても原文を保持する。
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 検出対象のパターン。順序は表示順ではなく、除去時の優先度に影響しない。
// 長い(具体的な)パターンを先に置き、短い断片が識別子を分割しないようにする。
const PATTERNS = [
  // コマンド行(gh / git / node / npm / npx / pnpm / yarn / python / pwsh / powershell / bash / sh / curl / robocopy / clasp)
  { name: 'command', re: /\b(?:gh|git|node|npm|npx|pnpm|yarn|python3?|pwsh|powershell|bash|sh|curl|robocopy|clasp)(?:[ \t]+[\x21-\x7E]+)+/g },
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

function stripHostTail(text) {
  const source = String(text ?? '');
  const match = source.match(HOST_TAIL_RE);
  if (!match) return { body: source, host: '' };
  return { body: source.slice(0, match.index), host: match[0] };
}

// 検出・書き換え・除去の対象外にする範囲(コードブロック / インラインコード / Markdown リンク / URL / メンション)。
const PROTECT_RE = /（[^（）\n]*）|```[\s\S]*?```|`[^`\n]+`|\[[^\]\n]*\]\([^)\s]*\)|https?:\/\/[^\s<>「」『』（）、。，]+|<[@#][!&]?\d+>/g;
const SPAN_TOKEN = (i) => `〔保護${i}〕`;
const SPAN_TOKEN_RE = /〔保護(\d+)〕/g;

function maskProtected(text) {
  const spans = [];
  const masked = String(text ?? '').replace(PROTECT_RE, (whole) => {
    spans.push(whole);
    return SPAN_TOKEN(spans.length - 1);
  });
  return { masked, spans };
}

function unmaskProtected(text, spans) {
  return String(text ?? '').replace(SPAN_TOKEN_RE, (whole, i) => spans[Number(i)] ?? whole);
}

// 内部用語を検出して、出現順・重複なしの配列で返す純関数。
// 長い一致に含まれる断片(例: feedback-zero-sweep の中の feedback)は別項目にしない。
export function findJargon(text) {
  return findJargonMasked(maskProtected(stripHostTail(text).body).masked);
}

function findJargonMasked(body) {
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

// マスク済みの文字列から検出語を除く(ホスト名・保護範囲は扱わない)。
function stripMasked(body) {
  let cleaned = body;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    cleaned = cleaned.replace(re, (token) => (COMMON_WORDS.has(token.trim()) ? token : ' '));
  }
  return cleaned.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([、。，,])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
}

// 検出語を本文から取り除く最終フォールバック。空になったら「内部の作業」を返す。
export function stripJargon(text) {
  const { body, host } = stripHostTail(text);
  const { masked, spans } = maskProtected(body);
  let cleaned = stripMasked(masked);
  if (!cleaned) cleaned = '内部の作業';
  return `${unmaskProtected(cleaned, spans)}${host}`;
}

const PROMPT = '次の各行を、システムを知らない高校生でも分かる短い日本語に書き換えて。行数と番号は変えず、「[1] …」のように同じ番号を付けて1行ずつ返す。英語の内部名・コマンド・ID・日時・番号は出さない。〔　〕で囲まれた語は書き換えず、その場所にそのまま残す。書き換えた行だけ返す。';

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
        execFile(process.execPath, [cli, '--provider', provider, '--no-fallback', '--max', '1500', prompt],
          { timeout: remaining, maxBuffer: 64 * 1024, windowsHide: true },
          (error, out) => (error ? reject(error) : resolve(out)));
      });
      const text = String(stdout ?? '').trim();
      if (text) return text;
    } catch { /* 次のプロバイダへ */ }
  }
  return '';
}

// 行頭の記号(•, -, ⚠️, ▶ など)とインデントを保持するための分離。
const PREFIX_RE = /^\s*(?:(?:[•·\-*>▶►▷■□●○◆◇→]|\p{Extended_Pictographic}|️)\s*)*/u;

function parseNumbered(reply) {
  const map = new Map();
  for (const line of String(reply ?? '').split('\n')) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.*)$/);
    if (m && !map.has(Number(m[1]))) map.set(Number(m[1]), m[2].trim());
  }
  return map;
}

// 本文を平易な日本語にする。例外は投げず、必ず文字列を返す。
// 行単位: 内部用語を含む行だけを書き換え、それ以外の行は一字一句そのまま残す。
export async function toPlainJa(text, { ask = defaultAsk, timeoutMs = 30_000 } = {}) {
  const source = String(text ?? '');
  if (!source.trim()) return source;
  if (findJargon(source).length === 0) return source;
  const { body, host } = stripHostTail(source);
  const { masked, spans } = maskProtected(body);
  const lines = masked.split('\n');
  // 書き換え対象: 内部用語がある行。定型返信語(「止めて」など)を含む行は触らない。
  const targets = [];
  lines.forEach((line, idx) => {
    if (REPLY_HINT_RE.test(line)) return;
    if (findJargonMasked(line).length === 0) return;
    const prefix = line.match(PREFIX_RE)[0];
    targets.push({ idx, prefix, rest: line.slice(prefix.length) });
  });

  let replies = new Map();
  try {
    const prompt = `${PROMPT}\n\n${targets.map((t, n) => `[${n + 1}] ${t.rest}`).join('\n')}`;
    const raw = String(await ask(prompt, { timeoutMs }) ?? '').trim();
    replies = parseNumbered(raw);
    // 対象が1行で番号が付かなかった返答は、その1行の書き換えとして受け入れる。
    if (replies.size === 0 && targets.length === 1 && raw) {
      const plain = raw.split('\n').map((l) => l.trim()).filter((l) => l && !/^〔そのまま\d+〕$/.test(l)).join(' ');
      if (plain) replies.set(1, plain);
    }
  } catch { /* 行ごとに原文を保持 */ }

  targets.forEach((t, n) => {
    let result = replies.get(n + 1);
    if (result && findJargonMasked(result).length === 0) {
      for (const token of t.rest.match(SPAN_TOKEN_RE) ?? []) if (!result.includes(token)) result += ` ${token}`;
    } else {
      result = t.rest;
    }
    lines[t.idx] = `${t.prefix}${result}`;
  });
  return `${unmaskProtected(lines.join('\n'), spans)}${host}`;
}
