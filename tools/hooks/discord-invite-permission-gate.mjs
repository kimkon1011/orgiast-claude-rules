export const GATE_CONTRACT = {"name":"hooks/discord-invite-permission-gate","remedies":[{"kind":"repo-file","ref":"tools/discord-bot-permissions.json","reason":"permissions=<required> の招待リンクに直す（対象 Bot の required は参照ファイルで確認）"}]};
import fs from 'node:fs';
import { isEntry } from '../is-entry.mjs';
import { readTranscriptContext } from '../lib/assistant-text.mjs';
import { readStdinWithTimeout } from '../lib/hook-stdin.mjs';

const configUrl = new URL('../discord-bot-permissions.json', import.meta.url);
export function evaluateInvitePermissions(text, config = JSON.parse(fs.readFileSync(configUrl, 'utf8'))) {
  for (const match of String(text ?? '').matchAll(/https:\/\/discord\.com\/oauth2\/authorize\?[^\s<>"'`）)\]]+/gi)) {
    const url = new URL(match[0].replace(/[.,;。！、]+$/, '').replaceAll('&amp;', '&'));
    const bot = config[url.searchParams.get('client_id')];
    const permissions = url.searchParams.get('permissions');
    if (!bot || permissions === null) continue;
    const required = BigInt(bot.required);
    if (!/^\d+$/.test(permissions) || (BigInt(permissions) & required) !== required) {
      return { decision: 'block', reason: `${bot.name}: 参加済み Bot の権限を上書きして狭める招待リンクです。permissions=${bot.required} にせよ。` };
    }
  }
  return { decision: 'pass' };
}

export function run(input) {
  const text = input.last_assistant_message ?? input.assistant_text ?? readTranscriptContext(input.transcript_path).assistantText;
  return evaluateInvitePermissions(text);
}

if (isEntry(import.meta.url)) {
  const raw = await readStdinWithTimeout();
  if (raw.trim()) {
    const result = run(JSON.parse(raw));
    if (result.decision === 'block') console.log(JSON.stringify(result));
  }
}
