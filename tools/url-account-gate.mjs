export const GATE_CONTRACT = {"name": "url-account-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "url-account-gate"}]};
import fs from 'node:fs';
import { currentTurnAssistantText } from './lib/assistant-text.mjs';
import { withStopRetryInstruction } from './lib/stop-retry-message.mjs';
import { catalog, providerForHost } from './provider-catalog.mjs';
import { isEntry } from './is-entry.mjs';

const accountDomains = [
  'aistudio.google.com', 'ai.studio', 'console.cloud.google.com', 'admin.google.com',
  'mail.google.com', 'github.com', 'vercel.com', 'supabase.com', 'npmjs.com',
  'x.com', 'twitter.com', 'discord.com', 'dash.cloudflare.com', 'platform.openai.com',
  'chatgpt.com', 'console.anthropic.com', 'claude.ai', 'notion.so', 'slack.com',
  'figma.com', 'canva.com', 'beds24.com', 'admin.booking.com', 'airbnb.com',
  'airbnb.jp', 'ycs.agoda.com', 'console.firebase.google.com',
  'developer.apple.com', 'appstoreconnect.apple.com',
];
const workspaceDomains = ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'script.google.com', 'slides.google.com', 'forms.google.com'];
const email = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const unresolvedFact = /未確認|不明|わからない|分からない|要確認|持ち主|未特定/;
const matchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);
// 名簿方式だけだと未登録のログイン画面が素通りする（2026-11-01 auth.openai.com/codex/device・manager.line.biz で実害）。
const loginHost = /^(?:auth|login|signin|sso|id|account|accounts|myaccount|manager|console|dashboard|admin|portal)\./;
const loginPath = /\/(?:device|oauth2?|authorize|auth|sso|signin|sign-in|login|log-in)(?:\/|$)/i;
// 人に開かせる URL は、ドメインが何であれアカウントを書く。出典・参考の行は対象外。
// 「ログインはできません」のような叙述は拾わず、開かせる言い方だけを数える。
const openVerb = /開いて|開く|開き|開いた|が開|ログインして|ログインし、|サインインして|アクセスして|クリック/;
const openVerbAtEnd = /(?:開いて|開く|開き|ログインして|サインインして|アクセスして|クリックして)(?:ください)?[。.:：）)]*$/;
const referenceLine = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:出典|参考|Sources?|ソース)/i;
const stepLine = /^\s*(?:\d+[.)．]|[-*]\s+\d+[.)．]|手順|次に)/;
const noLoginNeeded = /ログイン不要|どのアカウントでも/;

function onReferenceLine(lines, line) {
  // 「参考:」の見出し行の次に URL を置く書き方も出典として扱う。
  return referenceLine.test(lines[line]) || (line > 0 && referenceLine.test(lines[line - 1]) && /[:：]\s*$/.test(lines[line - 1]));
}

function handedToOpen(lines, line, index, url) {
  const value = lines[line];
  if (onReferenceLine(lines, line)) return false;
  // 同じ行は URL の近く（前後25字）か手順の行に限る。表の説明文中の「ログイン」で参考記事を拾わない。
  const near = value.slice(Math.max(0, index - 25), index + url.length + 25);
  if (openVerb.test(near) || (stepLine.test(value) && openVerb.test(value))) return true;
  // 直前の行は「次を開いてください。」のように行末が指示で終わる時だけ数える。
  const prev = (line > 0 ? lines[line - 1] : '').trimEnd();
  return openVerbAtEnd.test(prev) && !/https?:\/\//.test(prev);
}

// 解説・ヘルプのサイトはパスに /oauth2 などがあっても読み物なので、パスでは判定しない。
const docsHost = /^(?:developers?|docs|support|help|learn|developer)\./;

export function isLoginUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return loginHost.test(host) || (!docsHost.test(host) && loginPath.test(url.pathname));
}

function isOpenable(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
  if (matchesDomain(host, 'raw.githubusercontent.com')) return false;
  return !(matchesDomain(host, 'script.google.com') && /^\/home(?:\/|$)/.test(url.pathname));
}

function needsAccount(raw, services = catalog) {
  return listedAccountUrl(raw, services) || (isOpenable(raw) && isLoginUrl(raw));
}

// 名簿・Workspace・管理画面パスで判定する従来の基準（ログインらしさの推定は含まない）。
function listedAccountUrl(raw, services = catalog) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
  if (matchesDomain(host, 'raw.githubusercontent.com')) return false;
  if (workspaceDomains.some(domain => matchesDomain(host, domain))) {
    return !(matchesDomain(host, 'script.google.com') && /^\/home(?:\/|$)/.test(url.pathname));
  }
  return !!providerForHost(host, services) || accountDomains.some(domain => matchesDomain(host, domain))
    || (matchesDomain(host, 'play.google.com') && url.pathname.startsWith('/console'))
    || (matchesDomain(host, 'agoda.com') && /\/ycs(?:\/|$)/i.test(url.pathname))
    || /\/(?:admin|console|dashboard|settings|login|signin|account)/i.test(url.pathname);
}

export function judge(text, { services = catalog } = {}) {
  // Keep line boundaries so fenced content cannot bring a distant account closer.
  // インラインコードの URL はリンクにならず、人が開く対象ではない（調査ログの引用など）。
  const body = text.replace(/```[\s\S]*?```/g, block => block.replace(/[^\r\n]/g, ''))
    .replace(/`[^`\r\n]*`/g, span => ' '.repeat(span.length));
  if (body.includes('[URL-ACCOUNT-OK]')) return { triggered: false, missing: [], urls: [] };
  const lines = body.split(/\r?\n/);
  const found = [];
  for (const [line, value] of lines.entries()) {
    for (const match of value.matchAll(/https?:\/\/[^\s<>\x60"'\[\]{}()（）「」『』、。！？]+/gi)) {
      const url = match[0].replace(/[.,;:!?]+$/, '');
      // 名簿外でログインらしいだけの URL は、出典として挙げた行では対象にしない。
      const listed = needsAccount(url, services) && !(isLoginUrl(url) && !listedAccountUrl(url, services) && onReferenceLine(lines, line));
      if (listed || (isOpenable(url) && handedToOpen(lines, line, match.index, url))) found.push({ url, line });
    }
  }
  const urls = [...new Set(found.map(({ url }) => url))];
  const globalAccount = lines.some(line =>
    /(?:すべて|全部|いずれも|どの\s*URL\s*も|以下の\s*URL\s*は)/.test(line)
    && /[\w.+-]+@[\w-]+\.[\w.-]+(?:\*\*)?\s*で開く/.test(line));
  const missing = found.filter(({ url: raw, line }) => {
    const url = new URL(raw);
    const provider = providerForHost(url.hostname.toLowerCase().replace(/\.$/, ''), services);
    const nearby = lines.slice(Math.max(0, line - 1), line + 1).join('\n').replace(/https?:\/\/[^\s<>\x60"'\[\]{}()（）「」『』、。！？]+/gi, '');
    if (provider) {
      if (/user_[A-Za-z0-9]+|ユーザーID|(?:^|[\s*（(])[A-Za-z0-9]{16,}(?=$|[\s*）)])/i.test(nearby)) return true;
      if (!provider.account) return !/\[ACCOUNT-UNKNOWN\][ \t]+\S/.test(lines[line]);
      // メールは別アカウントの部分文字列として一致させない。
      return email.test(provider.account)
        ? !(nearby.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).includes(provider.account)
        : !nearby.includes(provider.account);
    }
    if (workspaceDomains.some(domain => matchesDomain(url.hostname.replace(/\.$/, ''), domain))) {
      const accounts = url.searchParams.getAll('authuser');
      const account = accounts[0] || '';
      if (accounts.length !== 1 || !/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(account) || /\/a\/[^/]+\//.test(url.pathname)) return true;
      // URL 内のメールは本文のアカウント指定として数えない。
      const prose = lines.slice(Math.max(0, line - 1), line + 2).join('\n')
        .replace(/https?:\/\/[^\s<>\x60"'\[\]{}()（）「」『』、。！？]+/gi, '');
      return !(prose.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).some(value => value.toLowerCase() === account.toLowerCase());
    }
    if (/user_[A-Za-z0-9]+|ユーザーID|(?:^|[\s*（(])[A-Za-z0-9]{16,}(?=$|[\s*）)])/i.test(nearby)) return true;
    if (globalAccount) return false;
    // 後ろの行のアカウントは数えない。開く手順の後に書かれても、開いた時点で迷う（2026-11-01 Codex 再ログイン手順で実害）。
    const context = lines.slice(Math.max(0, line - 1), line + 1);
    const hasUnresolved = context.some(value => unresolvedFact.test(value));
    return !context.some(value =>
      email.test(value)
      || (!isLoginUrl(raw) && noLoginNeeded.test(value))
      || (!hasUnresolved && /(?:で開く|で開いて|アカウント)/.test(value) && /\*\*[^*\n]+\*\*/.test(value))
      || (value.includes('open-url-as.ps1') && value.includes('-Account'))
    );
  }).map(({ url }) => url);
  return { triggered: urls.length > 0, missing: [...new Set(missing)], urls };
}

export function formatReason(urls, { services = catalog } = {}) {
  const accounts = [...new Set(urls.flatMap(raw => {
    const provider = providerForHost(new URL(raw).hostname, services);
    return provider ? [provider.account ? 'カタログ上のアカウント: ' + provider.account : 'カタログ上のアカウント: 未確認。[ACCOUNT-UNKNOWN] <調べた場所> を URL と同じ行に書く'] : [];
  }))];
  return accounts.join('\n') + '\nアカウントは人が分かるメール/ラベルで書く。\n' + '[URL-ACCOUNT] 次の URL に「どのアカウントで開くか」が書かれていません（ONBOARDING §1.5.0・kim 2026-10-04 厳命）。推奨形式: **<アカウント>** で開く: [表示名](URL)。生 URL を書くなら直前の行に「**<アカウント名>** で開いてください。」、次の行に URL だけを置く（URL の直後に括弧・句読点・全角文字を続けない。スマホでリンク範囲がずれて 404 になる・2026-10-18 実害）。既定アカウントと違うなら「シークレットウィンドウで開く」も併記。本文の URL が全部同じアカウントなら「以下の URL はすべて **x@y** で開く」の1行でよい。Workspace は authuser=<開く人のメール> が必須（既存クエリには &authuser= を追加）。URL の同じ行か直前に「<同じメール> で開いてください」を書く。前の行にアカウントを書き、次の行を Markdown リンク単独にする形も可。/a/orgiast.jp/ は不可。自分宛は環境の userEmail、他人宛は共有済みの相手メール。script.google.com/home/ 系は従来どおり除外。Workspace には離れた全体宣言は使えない。例外は [URL-ACCOUNT-OK]。\n' + urls.join('\n');
}

// 無人スクリプトの通知は Stop フックを通らないため、送信直前に同じ判定で補う（2026-10-25 DeepSeek 停止通知で所有アカウント未記載・URL 直後の日本語でリンク破損）。
export function annotateAccounts(text, { services = catalog } = {}) {
  const spaced = String(text ?? '').replace(/(https?:\/\/[\x21-\x7E]+?)(?=[^\x00-\x7F])/g, '$1 ');
  const lines = spaced.split('\n');
  // カタログ未登録でも、送信元が同じ行で実アカウント（認証情報のメール等）を示していれば補わない。
  const missing = judge(spaced, { services }).missing.filter(raw => !email.test(lines.find(line => line.includes(raw))?.replace(raw, '') || ''));
  if (!missing.length) return spaced;
  const notes = missing.map(raw => {
    const account = providerForHost(new URL(raw).hostname.toLowerCase().replace(/\.$/, ''), services)?.account;
    return account ? `開くアカウント: **${account}** → ${raw}` : `開くアカウント: 未登録（tools/ai-subscription-catalog.json に account を足す） → ${raw}`;
  });
  return `${spaced}\n${notes.join('\n')}`;
}

export const REMEDY_EXAMPLES = [
  '**kim@orgiast.jp** で開く: [Google Drive](https://drive.google.com/drive/u/0/?authuser=kim%40orgiast.jp)',
  '**kim の GitHub アカウント** で開く: [GitHub](https://github.com/org/repo)',
];

function main() {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      if (data.stop_hook_active) return;
      const text = currentTurnAssistantText(fs.readFileSync(data.transcript_path, 'utf8'));
      if (!text) return;
      const result = judge(text);
      if (result.triggered && result.missing.length) {
        console.error(withStopRetryInstruction(formatReason(result.missing)));
        process.exitCode = 2;
      }
    } catch { /* Match existing gates: unexpected input fails open. */ }
  });
}

if (isEntry(import.meta.url)) main();
