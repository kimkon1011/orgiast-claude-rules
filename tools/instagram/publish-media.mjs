import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from '../is-entry.mjs';

const USAGE = `使い方:
  node tools/instagram/publish-media.mjs --file <ローカルの .jpg|.jpeg|.png|.mp4> [--repo kimkon1011/orgiast-claude-rules] [--dir media/lahaina] [--branch main] [--dry-run] [--json]
  node tools/instagram/publish-media.mjs --check-url <公開HTTPS URL> [--json]

オプション:
  --file <path>       アップロードするローカル画像・動画ファイル
  --check-url <url>   公開HTTPS URLの取得可能性とContent-Typeを検証
  --repo <repo>       GitHubリポジトリ (既定: kimkon1011/orgiast-claude-rules)
  --dir <path>        リポジトリ内ディレクトリ (既定: media/lahaina)
  --branch <branch>   ブランチ名 (既定: main)
  --dry-run           アップロードを行わず、設定とURLを検証して終了
  --json              JSON形式で結果を出力
  --help              このヘルプを表示`;

export function parseArgs(argv) {
  const options = {
    file: undefined,
    checkUrl: undefined,
    repo: 'kimkon1011/orgiast-claude-rules',
    dir: 'media/lahaina',
    branch: 'main',
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (['--file', '--check-url', '--repo', '--dir', '--branch'].includes(arg)) {
      const val = argv[++i];
      if (val === undefined) throw new Error(`${arg} の値が指定されていません`);
      if (arg === '--file') options.file = val;
      else if (arg === '--check-url') options.checkUrl = val;
      else if (arg === '--repo') options.repo = val;
      else if (arg === '--dir') options.dir = val;
      else if (arg === '--branch') options.branch = val;
    } else if (arg.startsWith('--')) {
      throw new Error(`不明なオプション: ${arg}`);
    }
  }
  return options;
}

export function buildRawUrl({ repo = 'kimkon1011/orgiast-claude-rules', branch = 'main', path: filePath }) {
  const cleanPath = filePath.replace(/^\/+/, '');
  return `https://raw.githubusercontent.com/${repo}/${branch}/${cleanPath}`;
}

export function validateMediaFile({ filePath, sizeBytes }) {
  if (!filePath) {
    return { valid: false, reason: 'ファイルパスが指定されていません' };
  }
  const ext = path.extname(filePath).toLowerCase();
  const allowedExts = ['.jpg', '.jpeg', '.png', '.mp4'];
  if (!allowedExts.includes(ext)) {
    return {
      valid: false,
      reason: `サポートされていない拡張子です: ${ext} (許可: ${allowedExts.join(', ')})`,
    };
  }
  const MAX_SIZE = 8 * 1024 * 1024; // 8MB
  if (sizeBytes !== undefined && sizeBytes > MAX_SIZE) {
    return {
      valid: false,
      reason: `ファイルサイズが8MBを超えています: ${(sizeBytes / (1024 * 1024)).toFixed(2)}MB`,
    };
  }
  return { valid: true, ext };
}

export async function checkPublicMediaUrl(url, { fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'HEAD' });
    if (!response.ok && response.status === 405) {
      response = await fetchImpl(url, { method: 'GET' });
    }
  } catch {
    try {
      response = await fetchImpl(url, { method: 'GET' });
    } catch (error) {
      return { ok: false, status: 0, contentType: '', url, error: error.message };
    }
  }

  const status = response.status;
  const contentType = response.headers?.get?.('content-type') || '';
  const isMedia = contentType.startsWith('image/') || contentType.startsWith('video/');
  const ok = response.ok && isMedia;

  return { ok, status, contentType, url };
}

export async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fsImpl = dependencies.fsImpl ?? fs;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const token =
    dependencies.githubToken ??
    (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null);

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

  if (options.checkUrl) {
    const checkResult = await checkPublicMediaUrl(options.checkUrl, { fetchImpl });
    if (options.json) {
      stdout.write(`${JSON.stringify(checkResult, null, 2)}\n`);
    } else if (checkResult.ok) {
      stdout.write(`公開URL確認成功: ${checkResult.url} (${checkResult.contentType}, status: ${checkResult.status})\n`);
    } else {
      stderr.write(
        `公開URL確認失敗: ${checkResult.url} (status: ${checkResult.status}, contentType: ${checkResult.contentType})\n`
      );
    }
    return checkResult.ok ? 0 : 1;
  }

  if (!options.file) {
    stderr.write(`エラー: --file または --check-url を指定してください\n${USAGE}\n`);
    return 1;
  }

  if (!token) {
    stderr.write(
      'GitHub トークン未設定。`--check-url` で既存の公開URLを検証するか、`tools/image-gen.mjs` が返す公開URLをそのまま `post.mjs --image` に渡してください\n'
    );
    return 1;
  }

  if (!fsImpl.existsSync(options.file)) {
    stderr.write(`エラー: ファイルが存在しません: ${options.file}\n`);
    return 1;
  }

  const stats = fsImpl.statSync(options.file);
  const validation = validateMediaFile({ filePath: options.file, sizeBytes: stats.size });
  if (!validation.valid) {
    stderr.write(`エラー: ${validation.reason}\n`);
    return 1;
  }

  const fileName = path.basename(options.file);
  const targetDir = options.dir.replace(/^\/+|\/+$/g, '');
  const targetPath = `${targetDir}/${fileName}`;
  const rawUrl = buildRawUrl({ repo: options.repo, branch: options.branch, path: targetPath });

  if (options.dryRun) {
    const dryRunResult = {
      action: 'upload',
      repo: options.repo,
      branch: options.branch,
      targetPath,
      rawUrl,
      fileSize: stats.size,
    };
    if (options.json) {
      stdout.write(`${JSON.stringify(dryRunResult, null, 2)}\n`);
    } else {
      stdout.write(`dry-run: ${options.file} -> ${rawUrl}\n`);
    }
    return 0;
  }

  try {
    const fileBuffer = fsImpl.readFileSync(options.file);
    const contentBase64 = fileBuffer.toString('base64');

    const apiUrl = `https://api.github.com/repos/${options.repo}/contents/${targetPath}`;
    const uploadRes = await fetchImpl(apiUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'orgiast-instagram-publish-media',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `Add media ${fileName} for Instagram`,
        content: contentBase64,
        branch: options.branch,
      }),
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      stderr.write(`GitHub アップロードエラー (HTTP ${uploadRes.status}): ${errText}\n`);
      return 1;
    }

    const verifyCheck = await checkPublicMediaUrl(rawUrl, { fetchImpl });
    if (!verifyCheck.ok) {
      stderr.write(
        `アップロード後の読み戻し検証に失敗しました: ${rawUrl} (status: ${verifyCheck.status}, contentType: ${verifyCheck.contentType})\n`
      );
      return 1;
    }

    const successResult = {
      ok: true,
      rawUrl,
      repo: options.repo,
      branch: options.branch,
      path: targetPath,
    };

    if (options.json) {
      stdout.write(`${JSON.stringify(successResult, null, 2)}\n`);
    } else {
      stdout.write(`公開URL: ${rawUrl}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`アップロード処理失敗: ${error.message}\n`);
    return 1;
  }
}

if (isEntry(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
