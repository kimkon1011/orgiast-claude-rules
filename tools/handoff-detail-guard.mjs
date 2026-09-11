#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';

const __hookGuard = setTimeout(() => process.exit(0), 4000); __hookGuard.unref();

export function evaluateHandoffDetail(text) {
  const value = String(text || '');
  if (!value.trim() || /\[HANDOFF-DETAIL-OK\]/.test(value)) return { decision: 'pass' };
  const hasCmd = /```[^`]*?(?:git |gh |npm |npx |vercel |cd |node |clone|push|pull)[^`]*?```/s.test(value);
  const isRequest = /(これだけ|次を貼|下記を貼|以下を貼|そのまま貼|貼ってください|貼り付けて|してください|してもらえ|やってもら| そちらで|自分の(環境|PC|GitHub|Claude)|入力して|実行してくださ)/.test(value);
  const hasHow = /(ターミナル|PowerShell|コマンド ?プロンプト|Command Prompt|Windowsキー|開き方|を開いて|起動し|右クリック|Claude ?Code|チャット(に|の入力|欄)|アプリを開|貼る場所|どこで実行)/.test(value);
  const isDone = /(しました|済みです|済です|完了しました|流しました|push(?:し|済)|追加しました|作成しました|デプロイしました|反映しました)/.test(value);
  if (!(hasCmd && isRequest && !hasHow && !isDone)) return { decision: 'pass' };
  return { decision: 'block', reason: '[HANDOFF-DETAIL 不足] user にコマンド/手作業を頼むのに、非エンジニア向けの手順が欠けています(ONBOARDING §1.5.1)。\nコマンドを貼るだけ・「環境で実行して」だけは禁止。次を必ず書く:\n  ・どのアプリ/画面で行うか(例: Claude Codeのチャット / ターミナル / メモ帳)とその開き方(Windowsキー→…)\n  ・どこに入力/貼り付けるか、押すボタンの正確な名前\n  ・完了の見え方(成功時に何が表示されるか)、失敗時にどうするか\n  ※相手が Claude Code を使うなら、生コマンドでなく「Claude Code のチャットにこの1文を貼って」と自然文の指示にする。\n本当に詳細不要な相手(開発者等)なら理由を書いて [HANDOFF-DETAIL-OK] を付ける。' };
}

async function main() {
  try {
    let raw = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input?.stop_hook_active || !input?.transcript_path || !fs.existsSync(input.transcript_path)) return;
    const text = latestAssistantText(input.transcript_path); if (!text) return;
    const result = evaluateHandoffDetail(text);
    if (result.decision === 'block') console.log(JSON.stringify(result));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
