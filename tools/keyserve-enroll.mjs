#!/usr/bin/env node
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { keyserveAuthHeaders } from './keyserve-auth.mjs';
import { notifyKim } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';

const ENROLL_URL = process.env.ORGIAST_KEYSERVE_ENROLL_URL || 'https://orgiast-keyserve.vercel.app/api/enroll';
const INSTALL_URL = 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/tools/install-orgiast.ps1';
const DRY_TOKEN = 'DRY_RUN_TOKEN_NOT_VALID';

export function buildInstallCommand(token) {
  // Escape PowerShell literals, without interpreting the token's contents.
  if (typeof token !== 'string' || !token || /[\r\n\0]/.test(token)) throw new Error('トークンを1行コマンドに格納できません');
  const literal = `'${token.replaceAll("'", "''")}'`;
  return `Set-ExecutionPolicy -Scope Process Bypass -Force; $p=Join-Path $env:TEMP ('orgiast-install-'+[guid]::NewGuid().ToString('N')+'.ps1'); [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing '${INSTALL_URL}' -OutFile $p; & $p -Enroll ${literal} -Yes -NonInteractive -NoOllama -NoReboot`;
}

export function formatInstructions({ pc, command, fingerprint, dryRun }) {
  return [
    `${pc} の鍵設定・復帰手順${dryRun ? '（予行演習・発行も送信もしません）' : ''}`,
    '1. 対象PCで作業中のファイルを保存します。インターネットに接続してください。',
    '2. 画面下のスタート（Windowsマーク）を押し、「Windows PowerShell」と入力します。',
    '3. 「Windows PowerShell」をクリックして開きます。管理者として開く必要はありません。',
    '4. 次の1行を行末までコピーし、PowerShell の画面で右クリックして貼り付け、Enter キーを押します。',
    command,
    '5. ダウンロードが終わるまで待ちます。「鍵の復帰に成功：認証経路 primary / HTTP 200」が出れば鍵の設定は完了です。続くセットアップが終わるまで画面を開いておいてください。',
    '6. 赤字の失敗が出たら、表示された理由とPC名を kim に伝えてください。期限切れの場合は新しいコマンドを受け取ってやり直します。',
    'このコマンドには秘密が含まれます。共有チャンネルへ貼らず、対象PCの人だけに渡してください。',
    `確認用 SHA-256: ${fingerprint}`,
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), {
  home = process.env.ORGIAST_HOME || os.homedir(), fetchImpl = globalThis.fetch,
  notify = notifyKim, stdout = console.log, stderr = console.error,
} = {}) {
  try {
    let pc, ttlHours = 24;
    const flags = new Set();
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--pc' || arg === '--ttl-hours') {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error('--pc / --ttl-hours の値が必要です');
        if (arg === '--pc') pc = value; else ttlHours = Number(value);
      } else if (['--dm', '--json', '--dry-run'].includes(arg)) flags.add(arg);
      else throw new Error('使い方: node tools/keyserve-enroll.mjs --pc "PC名" [--ttl-hours 24] [--dm] [--json] [--dry-run]');
    }
    if (!pc?.trim() || /[\r\n\0]/.test(pc)) throw new Error('--pc に対象PC名を指定してください');
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error('--ttl-hours は正の時間数を指定してください');
    // Issuance must use the primary file, never a legacy webhook or an enrollment token.
    const secret = readEnvValue(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET');
    if (!secret) throw new Error('このPCは primary を持っていないので発行できません。primary を持つ別PCで実行してください。');
    const dryRun = flags.has('--dry-run');
    let issued = { token: DRY_TOKEN, pc, expiresAt: null, ttlHours };
    if (!dryRun) {
      let response;
      try {
        response = await fetchImpl(ENROLL_URL, {
          method: 'POST', headers: { ...keyserveAuthHeaders(secret), 'Content-Type': 'application/json' },
          body: JSON.stringify({ pc, ttlHours }), signal: AbortSignal.timeout(15000),
        });
      } catch { throw new Error('発行APIへ接続できません。ネットワーク接続を確認してください。'); }
      if (!response.ok) throw new Error(`発行APIが HTTP ${response.status} を返しました。${response.status === 401 ? 'primary 認証を確認してください。' : 'サーバの実装・稼働状況を確認してください。'}`);
      try { issued = await response.json(); } catch { throw new Error('発行APIの応答がJSONではありません'); }
      if (typeof issued?.token !== 'string' || !issued.token) throw new Error('発行APIの応答にトークンがありません');
    }
    const result = { token: issued.token, pc, expiresAt: issued.expiresAt, ttlHours: issued.ttlHours,
      fingerprint: crypto.createHash('sha256').update(issued.token).digest('hex').slice(0, 10),
      command: buildInstallCommand(issued.token), dryRun };
    const instructions = formatInstructions(result);
    if (flags.has('--json')) stdout(JSON.stringify({ ...result, instructions }));
    else stdout(instructions);
    if (flags.has('--dm') && !dryRun) {
      // A secret command must stay in DM. The existing helper's public webhook fallback is disabled.
      let sent;
      try { sent = await notify(instructions, { home, webhookFallback: false }); }
      catch { throw new Error('Discord DM 送信に失敗しました。表示されたコマンドを対象PCの人へ個別に渡してください。'); }
      if (sent?.delivered !== 'dm') throw new Error('Discord DM を送信できませんでした。Bot と kim のユーザーID設定を確認してください。');
    }
    return 0;
  } catch (error) {
    // Only locally constructed diagnostics are emitted; API bodies and credentials are never logged.
    stderr(error.message);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
