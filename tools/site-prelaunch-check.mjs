#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const execFileAsync = promisify(execFile);
const USER_AGENT = 'orgiast-prelaunch-check/1.0';
const TIMEOUT_MS = 15_000;
const REQUEST_LIMIT = 120;
const ITEMS = [
  'プライバシーポリシー', '利用規約', '露出した秘密', 'HTTPS', 'Cookie同意',
  'タイトル・説明', 'OGP', 'favicon', 'sitemap/robots', 'alt', '画像圧縮',
  '表示速度', '色コントラスト', 'モバイル', '404', 'リンク切れ', 'フォーム検証',
  'スパム対策', 'アクセス解析', 'CTA', '全ボタン操作テスト', 'エラー監視',
  'DBバックアップ', 'セキュリティヘッダ・レート制限', '認証フロー',
];

const result = (id, verdict, evidence) => ({ id, item: ITEMS[id - 1], verdict, evidence: oneLine(evidence) });
const oneLine = (value) => String(value ?? '').replace(/[\r\n|]+/g, ' ').trim();
const uniq = (values) => [...new Set(values)];
const textLength = (value) => [...String(value ?? '').trim()].length;

export function parseAttributes(source = '') {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(re)) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return attrs;
}

export function parseHtml(html = '', baseUrl = 'https://example.invalid/') {
  const tags = (name) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) => parseAttributes(m[1]));
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({
    ...parseAttributes(m[1]), text: stripTags(m[2]),
  }));
  const meta = tags('meta');
  const links = tags('link');
  const getMeta = (key) => meta.find((m) => (m.name || m.property || '').toLowerCase() === key.toLowerCase())?.content || '';
  const resolve = (value) => { try { return new URL(value, baseUrl).href; } catch { return ''; } };
  return {
    html, anchors, meta, links, images: tags('img'), scripts: tags('script'), forms: tags('form'),
    inputs: [...tags('input'), ...tags('textarea'), ...tags('select')], buttons: tags('button'),
    title: stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim(),
    description: getMeta('description'), getMeta, resolve,
  };
}

function stripTags(value) { return String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim(); }
function sameOrigin(url, origin) { try { return new URL(url).origin === origin; } catch { return false; } }
function asUrl(value, base) { try { return new URL(value, base).href; } catch { return ''; } }

export function maskSecret(secret) {
  const value = String(secret);
  return `${value.slice(0, 4)}…（${value.length}文字）`;
}

export function scanSecrets(text = '') {
  const patterns = [
    ['OpenAI形式キー', /sk-[A-Za-z0-9_-]{20,}/g], ['Stripe本番キー', /sk_live_[A-Za-z0-9]{10,}/g],
    ['AWSアクセスキー', /AKIA[0-9A-Z]{16}/g], ['GitHubトークン', /ghp_[A-Za-z0-9]{30,}/g],
    ['GitHub PAT', /github_pat_[A-Za-z0-9_]{30,}/g], ['Slackトークン', /xox[bap]-[A-Za-z0-9-]{10,}/g],
    ['秘密鍵', /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g],
  ];
  const findings = [];
  for (const [type, re] of patterns) for (const m of text.matchAll(re)) findings.push({ type, masked: maskSecret(m[0]), severity: 'NG' });
  for (const m of text.matchAll(/AIza[0-9A-Za-z_-]{35}/g)) findings.push({ type: 'Google ブラウザキー（制限要確認）', masked: maskSecret(m[0]), severity: '要手動' });
  for (const token of text.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (payload.role === 'service_role') findings.push({ type: 'Supabase service_role JWT', masked: maskSecret(token), severity: 'NG' });
    } catch { /* JWT候補ではない */ }
  }
  return findings;
}

export function evaluatePure(input) {
  const { url = 'https://example.invalid/', html = '', status = 200, headers = {}, resources = {}, repo = null, psi = null, ttfbMs = null, htmlBytes = Buffer.byteLength(html) } = input;
  const page = parseHtml(html, url);
  const origin = new URL(url).origin;
  const header = (name) => headers[name.toLowerCase()] ?? headers[name] ?? '';
  const resource = (target) => resources[target] || resources[asUrl(target, url)] || null;
  const linkedPolicy = (pattern, fallbacks) => {
    const candidates = page.anchors.filter((a) => pattern.test(`${a.href || ''} ${a.text}`)).map((a) => page.resolve(a.href));
    for (const fallback of fallbacks) candidates.push(page.resolve(fallback));
    const found = uniq(candidates).find((candidate) => resource(candidate)?.status === 200);
    return found ? { ok: true, url: found } : { ok: false, tried: uniq(candidates).length };
  };
  const privacy = linkedPolicy(/privacy|プライバシー|個人情報/i, ['/privacy', '/privacy-policy']);
  const terms = linkedPolicy(/terms|利用規約|規約/i, ['/terms']);
  const secretFindings = [...scanSecrets(html), ...(input.secretFindings || []), ...(repo?.secretFindings || [])];
  const hardSecrets = secretFindings.filter((f) => f.severity === 'NG');
  const googleKeys = secretFindings.filter((f) => f.severity === '要手動');
  const hasTrackers = /gtag|googletagmanager|\bfbq\b|clarity|hotjar/i.test(html);
  const hasConsent = /cookie|consent|クッキー/i.test(html);
  const titleLen = textLength(page.title), descLen = textLength(page.description);
  const ogImage = page.getMeta('og:image');
  const ogImageUrl = ogImage ? page.resolve(ogImage) : '';
  const ogComplete = page.getMeta('og:title') && page.getMeta('og:description') && ogImageUrl && resource(ogImageUrl)?.status === 200 && page.getMeta('twitter:card');
  const iconUrls = page.links.filter((l) => /(?:^|\s)(?:shortcut icon|icon|apple-touch-icon)(?:\s|$)/i.test(l.rel || '')).map((l) => page.resolve(l.href));
  const goodIcon = [...iconUrls, page.resolve('/favicon.ico')].find((candidate) => resource(candidate)?.status === 200);
  const robots = resource(page.resolve('/robots.txt'));
  const sitemapFromRobots = robots?.body?.match(/^\s*Sitemap:\s*(\S+)/im)?.[1];
  const sitemap = resource(sitemapFromRobots || page.resolve('/sitemap.xml'));
  const missingAlt = page.images.filter((img) => !Object.hasOwn(img, 'alt')).length;
  const imageChecks = input.imageChecks || [];
  const oversized = imageChecks.filter((i) => Number(i.bytes) > 300 * 1024);
  const modern = imageChecks.filter((i) => /\.(?:webp|avif)(?:[?#]|$)/i.test(i.url || '') || /image\/(?:webp|avif)/i.test(i.type || '')).length;
  const unknownImageSizes = imageChecks.filter((i) => i.error || i.bytes == null).length;
  const contrast = psi?.colorContrast;
  const missingViewport = !page.meta.some((m) => (m.name || '').toLowerCase() === 'viewport' && /width\s*=\s*device-width/i.test(m.content || ''));
  const notFound = input.notFound;
  const broken = (input.linkChecks || []).filter((l) => !l.excluded && l.status >= 400);
  const formControls = page.inputs.filter((i) => (i.type || '').toLowerCase() !== 'hidden');
  const validatedControls = formControls.filter((i) => Object.hasOwn(i, 'required') || /^(email|tel|url)$/i.test(i.type || '') || i.pattern);
  const spam = /turnstile|recaptcha|hcaptcha/i.test(html) || page.inputs.some((i) => (i.type || '').toLowerCase() === 'hidden' || Object.hasOwn(i, 'aria-hidden'));
  const analytics = /gtag|G-[A-Z0-9]+|googletagmanager|_vercel\/insights|@vercel\/analytics|cloudflareinsights|plausible|umami/i.test(html);
  const ctaCount = page.buttons.length + page.anchors.filter((a) => /(?:btn|button|cta)/i.test(a.class || '')).length;
  const errorMonitoring = /sentry|@vercel\/speed-insights|bugsnag|logrocket/i.test(html) || repo?.errorMonitoring;
  const dbTypes = repo?.dbTypes || [];
  const requiredHeaders = {
    'content-security-policy': !!header('content-security-policy'),
    'frame protection': !!header('x-frame-options') || /frame-ancestors/i.test(header('content-security-policy')),
    'x-content-type-options': !!header('x-content-type-options'), 'referrer-policy': !!header('referrer-policy'),
    'strict-transport-security': !!header('strict-transport-security'),
  };
  const missingHeaders = Object.entries(requiredHeaders).filter(([, present]) => !present).map(([name]) => name);
  const authInHtml = page.anchors.some((a) => /login|signin|signup|ログイン|会員登録|password/i.test(`${a.href || ''} ${a.text}`));
  const authPresent = authInHtml || repo?.authPresent;

  return [
    result(1, privacy.ok ? 'OK' : 'NG', privacy.ok ? `200を確認: ${privacy.url}` : `リンク・既定パス${privacy.tried}件に200なし`),
    result(2, terms.ok ? 'OK' : 'NG', terms.ok ? `200を確認: ${terms.url}` : `リンク・/termsに200なし`),
    result(3, hardSecrets.length ? 'NG' : googleKeys.length ? '要手動' : 'OK', hardSecrets.length ? hardSecrets.slice(0, 5).map((f) => `${f.type} ${f.masked}`).join(', ') : googleKeys.length ? googleKeys.map((f) => `${f.type} ${f.masked}`).join(', ') : '対象HTML・スクリプト・追跡ファイルに既知パターンなし'),
    result(4, input.httpCheck?.ok ? 'OK' : 'NG', input.httpCheck ? `${input.httpCheck.finalUrl || '不明'}へ到達、HSTS ${header('strict-transport-security') ? 'あり' : 'なし'}` : 'HTTP→HTTPSリダイレクトを確認できず'),
    result(5, !hasTrackers ? '対象外' : hasConsent ? 'OK' : 'NG', !hasTrackers ? '追跡Cookieなし' : hasConsent ? '解析・広告タグと同意UI候補あり' : '解析・広告タグあり、同意UI候補なし'),
    result(6, titleLen >= 10 && titleLen <= 70 && descLen >= 50 && descLen <= 160 ? 'OK' : 'NG', `title ${titleLen}字、description ${descLen}字`),
    result(7, ogComplete ? 'OK' : 'NG', ogComplete ? 'og:title/description/image(200)/twitter:cardあり' : '必須OGPまたは取得可能な絶対URL画像が不足'),
    result(8, goodIcon ? 'OK' : 'NG', goodIcon ? `200を確認: ${goodIcon}` : 'iconリンクと/favicon.icoに200なし'),
    result(9, robots?.status === 200 && sitemap?.status === 200 ? 'OK' : 'NG', `robots ${robots?.status ?? '未取得'}、sitemap ${sitemap?.status ?? '未取得'}${/Disallow:\s*\/\s*$/im.test(robots?.body || '') ? '、全面ブロックあり' : ''}`),
    result(10, missingAlt === 0 ? 'OK' : 'NG', `img ${page.images.length}件、alt欠落 ${missingAlt}件`),
    result(11, oversized.length === 0 && unknownImageSizes === 0 ? 'OK' : oversized.length ? 'NG' : '要手動', `確認${imageChecks.length}件、300KB超 ${oversized.length}件、サイズ不明 ${unknownImageSizes}件、WebP/AVIF ${imageChecks.length ? Math.round(modern / imageChecks.length * 100) : 0}%`),
    result(12, psi ? (psi.performance >= 0.8 ? 'OK' : 'NG') : '要手動', psi ? `PSI mobile performance ${Math.round((psi.performance || 0) * 100)}、TTFB ${ttfbMs ?? '不明'}ms、HTML ${htmlBytes}bytes` : `TTFB ${ttfbMs ?? '不明'}ms、HTML ${htmlBytes}bytes（PSI未実行）`),
    result(13, contrast == null ? '要手動' : contrast ? 'OK' : 'NG', contrast == null ? 'Lighthouse/Playwrightで確認' : `PSI color-contrast監査 ${contrast ? '合格' : '不合格'}`),
    result(14, missingViewport ? 'NG' : 'OK', missingViewport ? 'width=device-width のviewportなし' : 'width=device-width のviewportあり'),
    result(15, notFound?.status === 404 && !/404:\s*NOT_FOUND|The page could not be found/i.test(notFound.body || '') ? 'OK' : 'NG', !notFound ? 'ランダムURLを確認できず' : `status ${notFound.status}、${notFound.status === 404 ? '独自404 ' + (!/404:\s*NOT_FOUND|The page could not be found/i.test(notFound.body || '') ? 'あり' : 'なし') : '404を返さない'}`),
    result(16, broken.length ? 'NG' : 'OK', broken.length ? `切れ ${broken.length}件: ${broken.slice(0, 5).map((l) => l.url).join(', ')}` : `確認${(input.linkChecks || []).length}件、4xx/5xx 0件`),
    result(17, !page.forms.length ? '対象外' : validatedControls.length * 2 >= formControls.length ? 'OK' : 'NG', !page.forms.length ? 'フォームなし' : `検証あり ${validatedControls.length}/${formControls.length}入力`),
    result(18, !page.forms.length ? '対象外' : spam ? 'OK' : 'NG', !page.forms.length ? 'フォームなし' : spam ? 'CAPTCHAまたはhoneypot候補あり' : 'CAPTCHA/honeypot候補なし'),
    result(19, analytics ? 'OK' : 'NG', analytics ? 'アクセス解析タグを検出' : '対応するアクセス解析タグなし'),
    result(20, '要手動', `CTA候補 ${ctaCount}件（button ${page.buttons.length}件）`),
    result(21, '要手動', 'Playwrightで全ボタン操作を確認'),
    result(22, errorMonitoring ? 'OK' : 'NG', errorMonitoring ? 'エラー監視ライブラリを検出' : '対応するエラー監視なし'),
    result(23, !repo ? '要手動' : dbTypes.length ? '要手動' : '対象外', !repo ? 'repo未指定' : dbTypes.length ? `DB候補: ${dbTypes.join(', ')}（バックアップ設定を確認）` : 'DBなし'),
    result(24, missingHeaders.length ? 'NG' : 'OK', `${missingHeaders.length ? `不足: ${missingHeaders.join(', ')}` : '5要件すべてあり'}。レート制限 ${repo?.rateLimit ? '実装候補あり' : repo ? '候補なし' : 'repo未指定'}`),
    result(25, authPresent ? '要手動' : '対象外', authPresent ? '認証候補あり、フローを手動確認' : '認証なし'),
  ];
}

class SiteFetcher {
  constructor() { this.count = 0; }
  async fetch(url, options = {}) {
    if (++this.count > REQUEST_LIMIT) throw new Error(`同一サイトのリクエスト上限${REQUEST_LIMIT}件を超過`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const started = performance.now();
      const response = await fetch(url, { ...options, headers: { 'user-agent': USER_AGENT, ...(options.headers || {}) }, signal: controller.signal });
      return { response, elapsedMs: Math.round(performance.now() - started) };
    } finally { clearTimeout(timer); }
  }
  async get(url, options = {}) {
    const { response, elapsedMs } = await this.fetch(url, options);
    return { status: response.status, headers: Object.fromEntries(response.headers), body: options.method === 'HEAD' ? '' : await response.text(), url: response.url, elapsedMs };
  }
}

async function safeGet(fetcher, url, options) {
  try { return await fetcher.get(url, options); } catch (error) { return { status: null, body: '', headers: {}, url, error: error.message }; }
}

async function inspectRepo(repoPath) {
  const repo = { secretFindings: [], dbTypes: [], errorMonitoring: false, authPresent: false, rateLimit: false };
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'ls-files', '-z'], { maxBuffer: 10 * 1024 * 1024 });
    const files = stdout.split('\0').filter(Boolean);
    const envFiles = files.filter((f) => /(^|\/)\.env(?:\.|$)/i.test(f));
    repo.secretFindings.push(...envFiles.map((f) => ({ type: `追跡中の.env: ${f}`, masked: 'ファイル名', severity: 'NG' })));
    const texts = [];
    for (const relative of files) {
      if (/(^|\/)node_modules\/|(?:^|\/)(?:package-lock|yarn\.lock|pnpm-lock\.yaml)$|\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|woff2?|ttf)$/i.test(relative)) continue;
      const absolute = path.join(repoPath, relative);
      try {
        if ((await stat(absolute)).size > 1024 * 1024) continue;
        const body = await readFile(absolute, 'utf8');
        texts.push(relative === 'package.json' ? body : body.slice(0, 2_000_000));
        repo.secretFindings.push(...scanSecrets(body).map((f) => ({ ...f, type: `${f.type} (${relative})` })));
      } catch { /* 読めない追跡ファイルはスキップ */ }
    }
    const joined = texts.join('\n');
    const dbPatterns = { supabase: /supabase/i, prisma: /\bprisma\b/i, pg: /(?:["']pg["']|\bpostgres(?:ql)?\b)/i, mysql: /mysql/i, mongodb: /mongodb/i, firebase: /firebase/i, '@vercel/postgres': /@vercel\/postgres/i, '@neondatabase': /@neondatabase/i };
    repo.dbTypes = Object.entries(dbPatterns).filter(([, re]) => re.test(joined)).map(([name]) => name);
    repo.errorMonitoring = /@sentry\//i.test(joined);
    repo.authPresent = /next-auth|@supabase\/auth|\bclerk\b|firebase\/auth/i.test(joined);
    repo.rateLimit = /ratelimit|rate-limit|@upstash\/ratelimit/i.test(joined);
  } catch (error) { repo.error = error.message; }
  return repo;
}

async function getPsi(url) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url); endpoint.searchParams.set('strategy', 'mobile'); endpoint.searchParams.append('category', 'performance'); endpoint.searchParams.append('category', 'accessibility');
  try {
    const response = await fetch(endpoint, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { performance: data.lighthouseResult?.categories?.performance?.score ?? 0, colorContrast: data.lighthouseResult?.audits?.['color-contrast']?.score === 1 };
  } catch (error) { return { error: error.message }; }
}

export async function inspectSite(target, options = {}) {
  const url = new URL(target).href;
  const origin = new URL(url).origin;
  const fetcher = new SiteFetcher();
  const top = await safeGet(fetcher, url);
  if (top.error) return ITEMS.map((_, index) => result(index + 1, '要手動', `ネットワーク失敗: ${top.error}`));
  const page = parseHtml(top.body, top.url || url);
  const resources = {};
  const load = async (candidate, method) => {
    const absolute = asUrl(candidate, top.url || url);
    if (!absolute || resources[absolute]) return resources[absolute];
    const got = await safeGet(fetcher, absolute, method ? { method } : undefined); resources[absolute] = got; return got;
  };
  const policyCandidates = [...page.anchors.filter((a) => /privacy|プライバシー|個人情報|terms|利用規約|規約/i.test(`${a.href || ''} ${a.text}`)).map((a) => a.href), '/privacy', '/privacy-policy', '/terms'];
  for (const candidate of uniq(policyCandidates)) if (sameOrigin(asUrl(candidate, url), origin)) await load(candidate);
  const scriptBodies = [];
  for (const script of page.scripts.filter((s) => s.src).slice(0, 15)) {
    const scriptUrl = asUrl(script.src, url); if (!sameOrigin(scriptUrl, origin)) continue;
    const got = await load(scriptUrl); if (got?.body) scriptBodies.push(got.body);
  }
  const secretFindings = scanSecrets(scriptBodies.join('\n'));
  const ogImage = page.getMeta('og:image'); if (ogImage) await load(ogImage);
  for (const link of page.links.filter((l) => /icon/i.test(l.rel || ''))) if (link.href) await load(link.href);
  await load('/favicon.ico');
  const robots = await load('/robots.txt');
  const sitemapUrl = robots?.body?.match(/^\s*Sitemap:\s*(\S+)/im)?.[1] || '/sitemap.xml'; await load(sitemapUrl);
  const imageChecks = [];
  for (const image of page.images.filter((i) => i.src).slice(0, 30)) {
    const imageUrl = asUrl(image.src, url); let check = await safeGet(fetcher, imageUrl, { method: 'HEAD' });
    if ([405, 501].includes(check.status) || !check.headers?.['content-length']) check = await safeGet(fetcher, imageUrl);
    imageChecks.push({ url: imageUrl, bytes: Number(check.headers?.['content-length']) || (check.body ? Buffer.byteLength(check.body) : null), type: check.headers?.['content-type'], error: check.error });
  }
  const notFound = await safeGet(fetcher, `${origin}/__prelaunch-check-${Math.random().toString(36).slice(2)}`);
  const internal = page.anchors.map((a) => asUrl(a.href, url)).filter((u) => u && sameOrigin(u, origin)).slice(0, 40);
  const external = page.anchors.map((a) => asUrl(a.href, url)).filter((u) => u && /^https?:/i.test(u) && !sameOrigin(u, origin)).slice(0, 20);
  const linkChecks = [];
  for (const link of uniq(internal)) { const got = await safeGet(fetcher, link); linkChecks.push({ url: link, status: got.status, excluded: !!got.error }); }
  for (const link of uniq(external)) {
    let got = await safeGet(fetcher, link, { method: 'HEAD' }); if ([403, 405].includes(got.status)) got = await safeGet(fetcher, link);
    linkChecks.push({ url: link, status: got.status, excluded: !!got.error || [403, 429].includes(got.status) });
  }
  let httpCheck = null;
  try { const httpUrl = new URL(url); httpUrl.protocol = 'http:'; const got = await safeGet(fetcher, httpUrl.href); httpCheck = { ok: !got.error && got.url?.startsWith('https://'), finalUrl: got.url }; } catch { /* invalid protocol */ }
  const repo = options.repo ? await inspectRepo(path.resolve(options.repo)) : null;
  let psi = options.psi ? await getPsi(url) : null; if (psi?.error) psi = null;
  return evaluatePure({ url: top.url || url, html: top.body, status: top.status, headers: top.headers, resources, repo, secretFindings, imageChecks, notFound, linkChecks, httpCheck, psi, ttfbMs: top.elapsedMs });
}

export function markdownReport(reports) {
  return reports.map(({ url, checks }) => `# ${url}\n\n| # | 項目 | 判定 | 根拠 |\n|---:|---|---|---|\n${checks.map((c) => `| ${c.id} | ${c.item} | ${c.verdict} | ${oneLine(c.evidence)} |`).join('\n')}`).join('\n\n');
}

export function matrixReport(reports) {
  const symbols = { OK: '○', NG: '×', '対象外': '－', '要手動': '△' };
  const header = `| サイト | ${ITEMS.map((_, index) => index + 1).join(' | ')} | NG |`;
  const divider = `|---|${ITEMS.map(() => '---:').join('|')}|---|`;
  const rows = reports.map(({ url, checks }) => {
    const byId = new Map(checks.map((check) => [Number(check.id), check]));
    const verdicts = ITEMS.map((_, index) => symbols[byId.get(index + 1)?.verdict] ?? '△');
    const failed = checks.filter((check) => check.verdict === 'NG').map((check) => check.id);
    return `| ${oneLine(url)} | ${verdicts.join(' | ')} | ${failed.length}（${failed.join(',')}） |`;
  });
  return [header, divider, ...rows].join('\n');
}

function parseArgs(argv) {
  const options = { json: false, psi: false, matrix: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true; else if (arg === '--psi') options.psi = true; else if (arg === '--matrix') options.matrix = true;
    else if (['--url', '--repo', '--out', '--list', '--from-json'].includes(arg)) options[arg.slice(2).replace('-', '')] = argv[++i];
    else throw new Error(`不明な引数: ${arg}`);
  }
  const inputs = [options.url, options.list, options.fromjson].filter(Boolean);
  if (inputs.length !== 1) throw new Error('--url、--list、--from-json のいずれか1つが必要です');
  if (options.matrix && options.url) throw new Error('--matrix は --list または --from-json と併用してください');
  if (options.fromjson && options.json) throw new Error('--from-json と --json は同時指定できません');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv); const targets = []; let reports;
  if (options.fromjson) {
    reports = JSON.parse(await readFile(options.fromjson, 'utf8'));
    if (!Array.isArray(reports) || reports.some((report) => !report || typeof report.url !== 'string' || !Array.isArray(report.checks))) throw new Error('--from-json は {url, checks:[...]} の配列である必要があります');
  } else if (options.url) targets.push({ url: options.url, repo: options.repo });
  else {
    const list = await readFile(options.list, 'utf8');
    for (const line of list.split(/\r?\n/)) { if (!line.trim() || line.trimStart().startsWith('#')) continue; const [url, repo] = line.split('\t'); targets.push({ url: url.trim(), repo: repo?.trim() || undefined }); }
  }
  if (!reports) {
    reports = [];
    for (const target of targets) reports.push({ url: target.url, checks: await inspectSite(target.url, { repo: target.repo, psi: options.psi }) });
  }
  const output = options.json ? JSON.stringify(reports.length === 1 ? reports[0].checks : reports, null, 2) : options.matrix ? matrixReport(reports) : markdownReport(reports);
  if (options.out) await writeFile(options.out, `${output}\n`, 'utf8'); else process.stdout.write(`${output}\n`);
  return reports.some((report) => report.checks.some((check) => check.verdict === 'NG')) ? 1 : 0;
}

if (isEntry(import.meta.url)) main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`エラー: ${error.message}`); process.exitCode = 2; });

