import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const COMPANIES_URL = 'https://api.freee.co.jp/api/1/companies';
const DEFAULT_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

function parseArgs(argv) {
  const options = { check: false, printUrl: false, redirectUri: DEFAULT_REDIRECT_URI };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') options.check = true;
    else if (argv[i] === '--print-url') options.printUrl = true;
    else if (argv[i] === '--redirect-uri' && argv[i + 1]) options.redirectUri = argv[++i];
    else throw new Error('引数不正');
  }
  return options;
}

function extractCode(input) {
  const value = input.trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('code') || '';
  } catch {
    return value;
  }
}

function defaultReadLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

function defaultOpenBrowser(url) {
  return new Promise((resolve, reject) => {
    const child = execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.unref();
  });
}

function defaultOpRead() {
  return execFileSync('op', ['read', 'op://AI-Keys/orgiast-main/PURCHASING_APP_DATABASE_URL'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function defaultCreateSql(databaseUrl) {
  const require = createRequire(import.meta.url);
  const postgres = require('C:/Users/uers/.claude/tools-deps/node_modules/postgres');
  return postgres(databaseUrl, { max: 1, ssl: 'require', onnotice: () => {} });
}

export async function runReconnect(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const output = deps.output ?? ((message) => console.log(message));
  const errorOutput = deps.errorOutput ?? ((message) => console.error(message));
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const readLine = deps.readLine ?? defaultReadLine;
  const opRead = deps.opRead ?? defaultOpRead;
  const createSql = deps.createSql ?? defaultCreateSql;
  let sql = deps.sql;

  try {
    const options = parseArgs(argv);
    if (!sql) {
      const databaseUrl = process.env.PURCHASING_APP_DATABASE_URL || await opRead();
      sql = await createSql(databaseUrl);
    }

    const rows = await sql`select client_id, client_secret from freee_tokens where id = 'default' limit 1`;
    const row = rows[0];
    if (!row) {
      errorOutput('NG: freee_tokens に default 行なし');
      return 2;
    }
    if (options.check) {
      if (!row.client_id) {
        errorOutput('NG: client_id なし');
        return 2;
      }
      output('check OK');
      return 0;
    }

    const authorizationUrl = new URL(AUTHORIZE_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: row.client_id,
      redirect_uri: options.redirectUri,
      response_type: 'code',
      prompt: 'select_company',
    }).toString();
    if (options.printUrl) output(authorizationUrl.toString());
    await openBrowser(authorizationUrl.toString());

    const input = await readLine('freee で keiri2@orgiast.jp でログインし「許可する」を押してください。表示されたコード（またはアドレスバーの URL 全体）を貼り付けて Enter: ');
    const code = extractCode(input);
    if (!code) {
      errorOutput('NG: 認可コードなし');
      return 3;
    }

    const tokenResponse = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: row.client_id,
        client_secret: row.client_secret, code, redirect_uri: options.redirectUri,
      }),
    });
    if (!tokenResponse.ok) {
      let errorName = '';
      try { errorName = (await tokenResponse.json()).error || ''; } catch { /* sanitized below */ }
      errorOutput(`NG: トークン取得失敗 HTTP ${tokenResponse.status}${errorName ? ` error=${errorName}` : ''}`);
      return 3;
    }
    const tokens = await tokenResponse.json();
    const expiresAt = new Date(Date.now() + Number(tokens.expires_in) * 1000);
    await sql`update freee_tokens set refresh_token = ${tokens.refresh_token}, access_token = ${tokens.access_token}, access_expires_at = ${expiresAt}, updated_at = now() where id = 'default'`;
    const verifiedRows = await sql`select access_token from freee_tokens where id = 'default' limit 1`;
    if (verifiedRows[0]?.access_token !== tokens.access_token) {
      errorOutput('NG: DB 読み戻し不一致');
      return 4;
    }

    const companiesResponse = await fetchFn(COMPANIES_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!companiesResponse.ok) {
      errorOutput(`NG: 確認 HTTP ${companiesResponse.status}`);
      return 4;
    }
    const companiesJson = await companiesResponse.json();
    const count = Array.isArray(companiesJson.companies) ? companiesJson.companies.length : 0;
    output(`freee 再接続 OK（会社数 ${count}）`);
    return 0;
  } catch {
    errorOutput('NG: 再接続処理エラー');
    return 1;
  } finally {
    if (!deps.sql && sql?.end) {
      try { await sql.end({ timeout: 5 }); } catch { /* do not expose connection errors */ }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await runReconnect();
}
