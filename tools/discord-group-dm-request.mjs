#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as fleetMailMain } from './fleet-mail.mjs';
import { isEntry } from './is-entry.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

export function buildRequestBody(target, body, chat) {
  const candidate = chat ? `\nグループDM名の候補: ${chat}` : '';
  return `【グループDM投稿依頼】
相手名: ${target}${candidate}

投稿する本文（このまま投稿）:
---
${body}
---

手順:
1. discord-read-window.ps1 で「${target}さんと金功勇が入っている既存グループDM」を開く。
2. 会話名を確認する。
3. discord-post.ps1 -Chat <会話名> -BodyFile <本文ファイル> で上記本文を投稿する。
4. 読み戻し、本文が kim の発言として見えたら完了と返信する。

見つからない／Discord 未起動／投稿が確認できない時は、グループDMへは投稿せず、node tools/discord-dm.mjs "${target}" --body-file <本文ファイル> で送る（金功勇への写しは自動）。その実行結果を返信する。`;
}

function parseArgs(args) {
  const target = args[0] && !args[0].startsWith('--') ? args[0] : '';
  let bodyFile;
  let chat;
  let dryRun = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--body-file') bodyFile = args[++i];
    else if (args[i] === '--chat') chat = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else throw new Error(`不明な引数です: ${args[i]}`);
  }
  if (!target || !bodyFile) throw new Error('usage: discord-group-dm-request.mjs <相手名> --body-file <path> [--chat <グループDM名>] [--dry-run]');
  return { target, bodyFile, chat, dryRun };
}

async function defaultSendFleet(requestBody, { home }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-group-dm-'));
  const file = path.join(temp, 'request.txt');
  try {
    fs.writeFileSync(file, requestBody);
    return await fleetMailMain(['--send', '--to', 'kim-PC', '--kind', 'prompt', '--body-file', file,
      '--why', '[作業依頼] 既存グループDMへ社内連絡を投稿'], { home });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), options = {}) {
  let parsed;
  try { parsed = parseArgs(args); }
  catch (error) { console.error(`discord-group-dm-request: ${error.message}`); return 1; }
  const home = options.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  let body;
  try { body = fs.readFileSync(parsed.bodyFile, 'utf8'); }
  catch (error) { console.error(`discord-group-dm-request: ${error.message}`); return 1; }
  const requestBody = buildRequestBody(parsed.target, body, parsed.chat);
  if (parsed.dryRun) {
    console.log(JSON.stringify({ dryRun: true, to: 'kim-PC', kind: 'prompt', requestBody }));
    return 0;
  }
  const label = (options.resolveFleetLabel ?? resolveFleetLabel)(home);
  if (label === 'kim-PC') {
    console.log(requestBody);
    return 4;
  }
  return await (options.sendFleet ?? defaultSendFleet)(requestBody, { home });
}

if (isEntry(import.meta.url)) process.exitCode = await main();
