import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isEntry } from '../is-entry.mjs';
import {
  DEFAULT_ENV_PATH,
  readEnvFile,
  getMediaPermalink,
  callGraph,
} from './ig-api.mjs';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const USAGE = `使い方:
  node tools/instagram/verify-post.mjs --permalink <https://www.instagram.com/p/XXXX/> [--expect <text>]
  node tools/instagram/verify-post.mjs --media-id <id> [--expect <text>] [--env <path>]
  node tools/instagram/verify-post.mjs --profile [--username lahaina_ushimado]

オプション:
  --permalink <url>     検証する Instagram 投稿のパーマリンク URL
  --media-id <id>       検証するメディア ID (APIからパーマリンクを取得)
  --profile             プロフィール画面の表示確認
  --username <name>     プロフィール検証対象のユーザー名 (既定: lahaina_ushimado)
  --expect <text>       投稿本文またはメタデータに含まれるべき期待テキスト
  --env <path>          環境変数ファイルのパス (既定: ${DEFAULT_ENV_PATH})
  --via <auto|graph|render|html>
                        検証経路。render=ヘッドレスChromeで公開ページを描画して実表示を読む
                        （ログイン不要・2026-10-20 実測で動作確認済み）
                        graph=Graph API の /me/media を正本にする
                        auto=トークンがあれば graph、無ければ render（既定）
                        html=素の HTTP 取得。ログアウト状態では JS シェルしか返らず
                        実表示を確認できない（後方互換のため残置）
  --json                JSON形式で結果を出力
  --help                このヘルプを表示`;

export function parseArgs(argv) {
  const options = {
    permalink: undefined,
    mediaId: undefined,
    profile: false,
    username: 'lahaina_ushimado',
    expect: undefined,
    env: undefined,
    json: false,
    via: 'auto',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--profile') {
      options.profile = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (
      ['--permalink', '--media-id', '--username', '--expect', '--env', '--via'].includes(arg)
    ) {
      const val = argv[++i];
      if (val === undefined) throw new Error(`${arg} の値が指定されていません`);
      if (arg === '--permalink') options.permalink = val;
      else if (arg === '--media-id') options.mediaId = val;
      else if (arg === '--username') options.username = val;
      else if (arg === '--expect') options.expect = val;
      else if (arg === '--env') options.env = val;
      else if (arg === '--via') {
        if (!['auto', 'graph', 'render', 'html'].includes(val)) {
          throw new Error(`--via は auto|graph|render|html のいずれかです: ${val}`);
        }
        options.via = val;
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`不明なオプション: ${arg}`);
    }
  }
  return options;
}

export function extractMetaContent(html, propertyName) {
  if (!html) return '';
  const regex1 = new RegExp(
    `<meta\\s+[^>]*property=["'](?:og:)?${propertyName}["'][^>]*content=["']([^"']*)["']`,
    'i'
  );
  const match1 = html.match(regex1);
  if (match1) return match1[1];

  const regex2 = new RegExp(
    `<meta\\s+[^>]*content=["']([^"']*)["'][^>]*property=["'](?:og:)?${propertyName}["']`,
    'i'
  );
  const match2 = html.match(regex2);
  if (match2) return match2[1];

  const regex3 = new RegExp(
    `<meta\\s+[^>]*name=["'](?:og:)?${propertyName}["'][^>]*content=["']([^"']*)["']`,
    'i'
  );
  const match3 = html.match(regex3);
  if (match3) return match3[1];

  return '';
}

// ログインウォールの判定。
// 注意: '"httpErrorPage"' を混ぜてはいけない。この文字列は Instagram の通常ページの
// JS バンドルにも入っており、公開プロフィール（HTTP 200）を誤ってログインウォール扱いする
// （2026-10-15 実測: www.instagram.com/lahaina_ushimado/ の 637KB 応答に含まれていた）。
export function isLoginWall(html) {
  if (!html) return false;
  return (
    html.includes('<title>Login • Instagram</title>') ||
    html.includes('"LoginAndSignupPage"') ||
    html.includes('/accounts/login/')
  );
}

// Instagram はログアウト状態のプロフィール/投稿URLに、メタ情報を含まない JS シェルを返すことがある
// （<title>Instagram</title> のみ・og:title/og:description 無し）。この場合「未検証」が正しい結論で、
// 「投稿が出た」とも「出ていない」とも言ってはいけない（引継書 §5: API の成功応答で判定しない）。
export function isJsShell(html) {
  if (!html) return false;
  const hasOg = Boolean(extractMetaContent(html, 'description') || extractMetaContent(html, 'title'));
  if (hasOg) return false;
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  return title === 'Instagram' || title === '';
}

export const JS_SHELL_EVIDENCE =
  'サーバー描画メタ無し（JSシェル）。素のHTTP取得では実表示を確認できない。ブラウザで開いて目視するか、ログイン済みセッションが必要';

export function judgePermalink(html, { expect } = {}) {
  if (!html) {
    return { verdict: 'unverified', evidence: 'HTMLが空です' };
  }
  if (isLoginWall(html)) {
    return {
      verdict: 'unverified',
      evidence: 'ログインウォールを検出しました',
    };
  }
  const ogDescription = extractMetaContent(html, 'description');
  const ogTitle = extractMetaContent(html, 'title');

  if (isJsShell(html)) {
    return { verdict: 'unverified', evidence: JS_SHELL_EVIDENCE };
  }

  if (expect) {
    if (ogDescription.includes(expect) || html.includes(expect)) {
      return {
        verdict: 'verified',
        evidence: `og:description または本文に期待文字列 '${expect}' を検出`,
      };
    }
    return {
      verdict: 'mismatch',
      evidence: `期待文字列 '${expect}' が見つかりませんでした (og:description: '${ogDescription.slice(0, 100)}')`,
    };
  }

  if (ogDescription || ogTitle) {
    return {
      verdict: 'verified',
      evidence: `og:description/og:title に投稿メタデータを検出 (title: '${ogTitle}', desc: '${ogDescription.slice(0, 80)}')`,
    };
  }

  return {
    verdict: 'unverified',
    evidence: 'Instagram 投稿メタデータが見つかりませんでした',
  };
}

export function judgeProfile(html, username = 'lahaina_ushimado') {
  if (!html) {
    return { verdict: 'unverified', evidence: 'HTMLが空です' };
  }
  if (isLoginWall(html)) {
    return {
      verdict: 'unverified',
      evidence: 'ログインウォールを検出しました',
    };
  }
  if (isJsShell(html)) {
    return { verdict: 'unverified', evidence: JS_SHELL_EVIDENCE };
  }
  const ogTitle = extractMetaContent(html, 'title');
  const ogDescription = extractMetaContent(html, 'description');
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';

  const combined = `${ogTitle} ${ogDescription} ${title}`.toLowerCase();
  const lowerUser = username.toLowerCase();

  if (
    combined.includes(lowerUser) ||
    combined.includes('フォロワー') ||
    combined.includes('followers')
  ) {
    return {
      verdict: 'verified',
      evidence: `プロフィール情報を検出 (title: '${ogTitle || title}', desc: '${ogDescription.slice(0, 80)}')`,
    };
  }

  return {
    verdict: 'unverified',
    evidence: `プロフィール情報 (${username}) を特定できませんでした`,
  };
}

// --- ヘッドレスChromeによる実表示の読み戻し -------------------------------
// 素の HTTP はログインウォール/JS シェルしか返さないが、公開ページをブラウザで
// 「描画」すればログイン不要で実表示が読める（2026-10-20 実測:
//  /lahaina_ushimado/ は og:title/og:description と「フォロワー1,149人・投稿166件」、
//  /p/Ddf_thXPDK_/ は描画後DOMに "caption":{"text":"ラハイナPVです…"} を検出）。
// これは「ログインにブラウザを使う」ことではなく、公開ページの閲覧なので §7 に該当しない。
export const RENDER_EVIDENCE_FALLBACK =
  '描画後DOMにも実表示が見つかりません（ログインウォール／削除済み／Chrome起動失敗の可能性）';

// 公開ページをヘッドレスChromeで描画し、描画後DOMを返す（ログイン操作は一切しない）。
// execFile は「非0終了＝失敗」として stdout を捨てるが、Chrome は正常描画後も
// updater 等の ERROR で非0を返すことがあるため、spawn で stdout を確保し、
// 描画結果が取れていれば成功として扱う（2026-10-20 実測）。
export function renderPublicPage(url, { chromePath, timeoutMs = 90000, spawnImpl = spawn } = {}) {
  const executable = chromePath || findChromeExecutable();
  if (!executable) {
    return Promise.reject(
      new Error('ヘッドレスChromeが見つかりません（CHROME_PATH で指定してください）')
    );
  }
  const profileDir = path.join(
    os.tmpdir(),
    `ig-verify-${process.pid}-${Date.now()}`
  );
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--virtual-time-budget=15000',
    '--dump-dom',
    `--user-data-dir=${profileDir}`,
    url,
  ];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`描画がタイムアウトしました（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdout.trim()) {
        resolve(stdout);
        return;
      }
      reject(new Error(`描画結果が空です (exit=${code}) ${stderr.slice(-300)}`));
    });
  });
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findChromeExecutable({
  env = process.env,
  exists = fs.existsSync,
  platform = process.platform,
} = {}) {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) return env.CHROME_PATH;
  const candidates = platform === 'win32' ? CHROME_CANDIDATES : [];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'chromium', 'chrome']) {
    const pathEnv = env.PATH ?? '';
    for (const dir of pathEnv.split(platform === 'win32' ? ';' : ':')) {
      if (!dir) continue;
      const candidate = `${dir}${platform === 'win32' ? '\\' : '/'}${name}`;
      const withExt = platform === 'win32' ? `${candidate}.exe` : candidate;
      if (exists(withExt)) return withExt;
    }
  }
  return '';
}

// 描画後DOMから投稿本文を取り出す。Instagram は "caption":{"text":"..."} を
// JSON 文字列（非ASCIIは \uXXXX）で埋め込むため、JSON.parse で復号する。
export function extractRenderedCaption(html) {
  if (!html) return '';
  const match = html.match(/"caption":\{"text":"((?:[^"\\]|\\.)*)"/);
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

export function judgeRenderedPost(html, { expect } = {}) {
  if (!html) {
    return { verdict: 'unverified', evidence: 'HTMLが空です' };
  }
  const caption = extractRenderedCaption(html);
  const hasImage = Boolean(extractMetaContent(html, 'image'));
  // 描画後DOMは常に /accounts/login/ 等の文字列を含むため、先に実表示の有無で判定する。
  if (!caption && !hasImage) {
    if (isLoginWall(html)) {
      return { verdict: 'unverified', evidence: 'ログインウォールを検出しました' };
    }
    return { verdict: 'unverified', evidence: RENDER_EVIDENCE_FALLBACK };
  }
  if (expect) {
    if (caption.includes(expect) || html.includes(expect)) {
      return {
        verdict: 'verified',
        evidence: `描画後DOMに期待文字列 '${expect}' を検出 (caption: '${caption.slice(0, 80)}')`,
      };
    }
    return {
      verdict: 'mismatch',
      evidence: `描画後DOMに '${expect}' が見つかりません (caption: '${caption.slice(0, 80)}')`,
    };
  }
  return {
    verdict: 'verified',
    evidence: `描画後DOMに投稿の実表示を検出 (og:image=${hasImage ? 'あり' : 'なし'} / caption: '${caption.slice(0, 80)}')`,
  };
}

export function judgeRenderedProfile(html, username = 'lahaina_ushimado') {
  if (!html) {
    return { verdict: 'unverified', evidence: 'HTMLが空です' };
  }
  const ogTitle = extractMetaContent(html, 'title');
  const ogDescription = extractMetaContent(html, 'description');
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';
  const combined = `${ogTitle} ${ogDescription} ${title}`.toLowerCase();
  const handle = `@${String(username).toLowerCase()}`;
  // 描画後DOMは常に /accounts/login/ 等の文字列を含むため、先に実表示の有無で判定する。
  if (
    combined.includes(handle) ||
    combined.includes('フォロワー') ||
    combined.includes('followers')
  ) {
    return {
      verdict: 'verified',
      evidence: `描画後DOMにプロフィール表示を検出 (title: '${ogTitle || title}', desc: '${ogDescription.slice(0, 80)}')`,
    };
  }
  if (isLoginWall(html)) {
    return { verdict: 'unverified', evidence: 'ログインウォールを検出しました' };
  }
  return { verdict: 'unverified', evidence: RENDER_EVIDENCE_FALLBACK };
}

// --- Graph API 読み戻し ---------------------------------------------------
// 素の HTTP 取得はログアウト状態だと JS シェル（og: メタ無し）しか返さず、実表示を確認できない
// （2026-10-15 実測: /lahaina_ushimado/ は HTTP 200 だが title="Instagram" /
//  pageID="httpErrorPage" の PolarisErrorRoot で og:title・og:description ともに無し）。
// 人が目視する代わりに、トークンを持つ経路では Graph API の /me/media を正本として読む。
export const MEDIA_FIELDS = 'id,permalink,caption,timestamp,media_type';

export async function fetchRecentMedia({
  accessToken,
  limit = 10,
  fetchImpl = globalThis.fetch,
}) {
  const data = await callGraph({
    path: '/me/media',
    params: { fields: MEDIA_FIELDS, limit },
    accessToken,
    fetchImpl,
  });
  return Array.isArray(data?.data) ? data.data : [];
}

export function normalizePermalink(url) {
  return String(url ?? '')
    .split('?')[0]
    .replace(/\/+$/, '');
}

export function judgeGraphMedia(media, { permalink, expect } = {}) {
  const items = Array.isArray(media) ? media : [];
  if (items.length === 0) {
    return {
      verdict: 'unverified',
      evidence: 'Graph API の /me/media が0件（まだ投稿が無い）',
    };
  }
  if (permalink) {
    const target = normalizePermalink(permalink);
    const hit = items.find((m) => normalizePermalink(m.permalink) === target);
    if (hit) {
      return {
        verdict: 'verified',
        evidence: `Graph API に該当 permalink を確認 (id=${hit.id}, ${hit.timestamp ?? '時刻不明'})`,
      };
    }
    const recent = items.slice(0, 3).map((m) => normalizePermalink(m.permalink)).join(', ');
    return {
      verdict: 'mismatch',
      evidence: `Graph API の直近${items.length}件に ${target} が無い (最近: ${recent})`,
    };
  }
  if (expect) {
    const hit = items.find((m) => String(m.caption ?? '').includes(expect));
    if (hit) {
      return {
        verdict: 'verified',
        evidence: `Graph API の本文に期待文字列 '${expect}' を検出 (id=${hit.id})`,
      };
    }
    return {
      verdict: 'mismatch',
      evidence: `Graph API 本文に '${expect}' が見つからない（直近${items.length}件を確認）`,
    };
  }
  const newest = items
    .slice()
    .sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))[0];
  return {
    verdict: 'verified',
    evidence: `Graph API に投稿を確認（直近${items.length}件・最新 ${newest?.timestamp ?? '時刻不明'}）`,
  };
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fsImpl = dependencies.fsImpl ?? fs;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 1;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (!options.permalink && !options.mediaId && !options.profile) {
    stderr.write(
      `エラー: --permalink, --media-id, --profile のいずれかを指定してください\n${USAGE}\n`
    );
    return 1;
  }

  let targetUrl = options.permalink;

  if (options.mediaId) {
    const envPath = options.env || dependencies.envPath || DEFAULT_ENV_PATH;
    const envVars = readEnvFile(envPath, fsImpl);
    const accessToken = envVars.INSTAGRAM_ACCESS_TOKEN;
    if (!accessToken) {
      stderr.write(
        `エラー: --media-id の解決に必要な INSTAGRAM_ACCESS_TOKEN が未設定です (${envPath})\n`
      );
      return 1;
    }
    try {
      const mediaData = await getMediaPermalink({
        mediaId: options.mediaId,
        accessToken,
        fetchImpl,
      });
      targetUrl = mediaData.permalink;
      if (!targetUrl) {
        stderr.write(`エラー: メディアID ${options.mediaId} から permalink を取得できませんでした\n`);
        return 1;
      }
    } catch (error) {
      stderr.write(`エラー: メディア情報の取得に失敗しました: ${error.message}\n`);
      return 1;
    }
  } else if (options.profile) {
    targetUrl = `https://www.instagram.com/${options.username.replace(/^\/+|\/+$/g, '')}/`;
  }

  // Graph API 経路: トークンがあるなら、JS シェルの目視ではなく API を正本にする。
  const envPathForGraph = options.env || dependencies.envPath || DEFAULT_ENV_PATH;
  const graphToken = readEnvFile(envPathForGraph, fsImpl).INSTAGRAM_ACCESS_TOKEN;
  const wantGraph = options.via === 'graph' || (options.via === 'auto' && Boolean(graphToken));

  if (wantGraph) {
    if (!graphToken) {
      stderr.write(
        `エラー: --via graph には INSTAGRAM_ACCESS_TOKEN が必要です (${envPathForGraph})\n`
      );
      return 1;
    }
    let media;
    try {
      media = await fetchRecentMedia({ accessToken: graphToken, fetchImpl });
    } catch (error) {
      const failResult = {
        verdict: 'unverified',
        evidence: `Graph API エラー: ${error.message}`,
        url: targetUrl ?? '',
        via: 'graph',
      };
      if (options.json) stdout.write(`${JSON.stringify(failResult, null, 2)}\n`);
      else stderr.write(`unverified: Graph API エラー: ${error.message}\n`);
      return 1;
    }
    const judgement = judgeGraphMedia(media, {
      permalink: options.permalink,
      expect: options.expect,
    });
    const graphResult = {
      verdict: judgement.verdict,
      evidence: judgement.evidence,
      url: targetUrl ?? '',
      via: 'graph',
    };
    if (options.json) stdout.write(`${JSON.stringify(graphResult, null, 2)}\n`);
    else stdout.write(`${graphResult.verdict}: ${judgement.evidence}\n`);
    return graphResult.verdict === 'verified' ? 0 : 1;
  }

  // 描画経路: 公開ページをヘッドレスChromeで描画し、実表示（ogメタ・投稿本文）を読む。
  if (options.via === 'render') {
    let renderedHtml = '';
    try {
      renderedHtml = await (dependencies.renderImpl ?? renderPublicPage)(targetUrl, {
        chromePath: dependencies.chromePath,
      });
    } catch (error) {
      const failResult = {
        verdict: 'unverified',
        evidence: `描画エラー: ${error.message}`,
        url: targetUrl,
        via: 'render',
      };
      if (options.json) stdout.write(`${JSON.stringify(failResult, null, 2)}\n`);
      else stderr.write(`unverified: ${targetUrl} (描画エラー: ${error.message})\n`);
      return 1;
    }
    const judgement = options.profile
      ? judgeRenderedProfile(renderedHtml, options.username)
      : judgeRenderedPost(renderedHtml, { expect: options.expect });
    const renderResult = {
      verdict: judgement.verdict,
      evidence: judgement.evidence,
      url: targetUrl,
      via: 'render',
    };
    if (options.json) stdout.write(`${JSON.stringify(renderResult, null, 2)}\n`);
    else stdout.write(`${renderResult.verdict}: ${targetUrl} (${judgement.evidence})\n`);
    return renderResult.verdict === 'verified' ? 0 : 1;
  }

  let html = '';
  try {
    const response = await fetchImpl(targetUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok) {
      const failResult = {
        verdict: 'unverified',
        evidence: `HTTP ${response.status} ${response.statusText}`,
        url: targetUrl,
      };
      if (options.json) {
        stdout.write(`${JSON.stringify(failResult, null, 2)}\n`);
      } else {
        stdout.write(`unverified: ${targetUrl} (HTTPステータス: ${response.status})\n`);
      }
      return 1;
    }

    html = await response.text();
  } catch (error) {
    const failResult = {
      verdict: 'unverified',
      evidence: `通信エラー: ${error.message}`,
      url: targetUrl,
    };
    if (options.json) {
      stdout.write(`${JSON.stringify(failResult, null, 2)}\n`);
    } else {
      stderr.write(`unverified: ${targetUrl} (通信エラー: ${error.message})\n`);
    }
    return 1;
  }

  const judgement = options.profile
    ? judgeProfile(html, options.username)
    : judgePermalink(html, { expect: options.expect });

  const finalResult = {
    verdict: judgement.verdict,
    evidence: judgement.evidence,
    url: targetUrl,
  };

  if (options.json) {
    stdout.write(`${JSON.stringify(finalResult, null, 2)}\n`);
  } else {
    stdout.write(`${finalResult.verdict}: ${targetUrl} (${finalResult.evidence})\n`);
  }

  return finalResult.verdict === 'verified' ? 0 : 1;
}

if (isEntry(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
