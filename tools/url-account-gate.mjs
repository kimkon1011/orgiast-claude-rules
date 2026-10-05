import { latestAssistantText } from './lib/assistant-text.mjs';
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
const workspaceDomains = ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'script.google.com'];
const email = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const matchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function needsAccount(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
  if (matchesDomain(host, 'raw.githubusercontent.com')) return false;
  if (workspaceDomains.some(domain => matchesDomain(host, domain))) {
    return !url.searchParams.has('authuser') && !url.pathname.includes('/a/orgiast.jp/');
  }
  return accountDomains.some(domain => matchesDomain(host, domain))
    || (matchesDomain(host, 'play.google.com') && url.pathname.startsWith('/console'))
    || (matchesDomain(host, 'agoda.com') && /\/ycs(?:\/|$)/i.test(url.pathname))
    || /\/(?:admin|console|dashboard|settings|login|signin|account)/i.test(url.pathname);
}

export function judge(text) {
  // Keep line boundaries so fenced content cannot bring a distant account closer.
  const body = text.replace(/```[\s\S]*?```/g, block => block.replace(/[^\r\n]/g, ''));
  if (body.includes('[URL-ACCOUNT-OK]')) return { triggered: false, missing: [], urls: [] };
  const lines = body.split(/\r?\n/);
  const found = [];
  for (const [line, value] of lines.entries()) {
    for (const match of value.matchAll(/https?:\/\/[^\s<>\x60"'\[\]{}()（）「」『』、。！？]+/gi)) {
      const url = match[0].replace(/[.,;:!?]+$/, '');
      if (needsAccount(url)) found.push({ url, line });
    }
  }
  const urls = [...new Set(found.map(({ url }) => url))];
  const globalAccount = lines.some(line =>
    /(?:すべて|全部|いずれも|どの\s*URL\s*も|以下の\s*URL\s*は)/.test(line)
    && /[\w.+-]+@[\w-]+\.[\w.-]+(?:\*\*)?\s*で開く/.test(line));
  if (globalAccount) return { triggered: true, missing: [], urls };
  const missing = found.filter(({ line }) => !lines.slice(Math.max(0, line - 2), line + 3).some(value =>
    email.test(value)
    || (/(?:で開く|アカウント)/.test(value) && /\*\*[^*\n]+\*\*/.test(value))
    || (value.includes('open-url-as.ps1') && value.includes('-Account'))
  )).map(({ url }) => url);
  return { triggered: urls.length > 0, missing: [...new Set(missing)], urls };
}

export function formatReason(urls) {
  return '[URL-ACCOUNT] 次の URL に「どのアカウントで開くか」が書かれていません（ONBOARDING §1.5.0・kim 2026-10-04 厳命）。形式: <URL>（**<アカウント名>** で開く）。既定アカウントと違うなら「シークレットウィンドウで開く」も併記。本文の URL が全部同じアカウントなら「以下の URL はすべて **x@y** で開く」の1行でよい。例外は [URL-ACCOUNT-OK]。\n' + urls.join('\n');
}

function main() {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      if (data.stop_hook_active) return;
      const text = latestAssistantText(data.transcript_path);
      if (!text) return;
      const result = judge(text);
      if (result.triggered && result.missing.length) {
        console.error(formatReason(result.missing));
        process.exitCode = 2;
      }
    } catch { /* Match existing gates: unexpected input fails open. */ }
  });
}

if (isEntry(import.meta.url)) main();
