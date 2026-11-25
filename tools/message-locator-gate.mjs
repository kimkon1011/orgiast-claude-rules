#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "message-locator-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "message-locator-gate"}]};
import { latestAssistantText } from './lib/assistant-text.mjs';
import { isEntry } from './is-entry.mjs';

// 2026-10-26 kim 指摘: 「Discord の DM で今日19時ごろの通知を開き…」と書いたが、
// どのアカウントの・誰からの・どのメッセージかが分からず、毎日1000件以上届く中から見つけられなかった。
// メッセージ・通知を user に案内するときは、一発で見つかる目印（送信者・場所・日時・先頭行・直リンク）を必須にする。

const CHANNEL = /Discord|ディスコード|LINE|Slack|Gmail|メール|受信箱|\bDM\b|ＤＭ|通知|チャンネル|スレッド/;
const POINTER = /届いて(?:い|お)|届きます|届いた|届く(?:の|はず)|送りました|送っています|送信しました|送信済み|投稿しました|確認して(?:ください|もらう|ほしい)|開いて|開き、|見て(?:ください|もらう)|探して|ご覧/;
const DATE = /\d{1,2}\s*[\/／]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日|今日|本日|昨日|今朝|毎朝/;
const TIME = /\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*時(?:\s*\d{1,2}\s*分)?/;
const SENDER = /送信者|差出人|送信元|Bot|bot|ボット|[\w.+-]+@[\w-]+\.[\w.-]+|さんから|様から|から届|名義/;
const LOCATOR = /discord(?:app)?\.com\/channels\/|mail\.google\.com|line\.me|slack\.com\/archives|先頭行|件名|冒頭|「[^」\n]{6,}」/;
const OVERRIDE = /\[MSG-LOCATOR-OK:[ \t]*[^\]\r\n]+\]/;

export const REMEDY_EXAMPLES = [
  'Discord（cr@ でログイン）の Bot「ClaudeInboxBridge」との DM に、10/26 09:03 に届いた「📩 【営業メール返信チェック】」が該当です: [そのメッセージを開く](https://discord.com/channels/@me/123/456)',
];

const stripCode = text => String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

export function judge(text) {
  const body = stripCode(text);
  if (OVERRIDE.test(body)) return { triggered: false, missing: [] };
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!CHANNEL.test(line) || !POINTER.test(line)) continue;
    const block = lines.slice(Math.max(0, i - 2), i + 4).join('\n');
    const missing = [];
    if (!DATE.test(block) || !TIME.test(block)) missing.push('日時（日付と時:分）');
    if (!SENDER.test(block)) missing.push('送信者（Bot 名・人の名前・メールアドレス）');
    if (!LOCATOR.test(block)) missing.push('先頭行か件名（原文）と、そのメッセージへの直接リンク');
    if (missing.length) return { triggered: true, missing, line: line.trim().slice(0, 120) };
  }
  return { triggered: false, missing: [] };
}

export function formatReason(missing, line = '') {
  return `[MSG-LOCATOR] メッセージ・通知を user に案内していますが、毎日1000件以上届く中から一発で見つける目印が足りません（kim 2026-10-26）。
該当行: ${line}
不足: ${missing.join(' / ')}
必ず書くこと: ①アプリと開くアカウント（例: Discord の cr@ ログイン、Gmail の seisaku-team@） ②送信者（Bot 名・人の名前・メール） ③場所（DM の相手名・チャンネル名・ラベル） ④日時（日付と時:分） ⑤先頭行か件名を原文のまま＋そのメッセージへの直接リンク（Discord は https://discord.com/channels/<guild|@me>/<channel>/<message>）。
可能なら中身の要点も本文に書き、user が開かなくても判断できるようにする。本当に目印が不要な文脈だけ [MSG-LOCATOR-OK: <理由>] を付ける。
例: ${REMEDY_EXAMPLES[0]}`;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      if (!input?.transcript_path) return;
      const text = latestAssistantText(input.transcript_path);
      const result = judge(text);
      if (result.triggered) console.log(JSON.stringify({ decision: 'block', reason: formatReason(result.missing, result.line) }));
    } catch {}
  });
}

if (isEntry(import.meta.url)) main();
