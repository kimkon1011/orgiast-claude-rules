#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"seat-name-gate","remedies":[{"kind":"repo-file","ref":"ONBOARDING.md"}]};
import { pcMapEntries } from './fleet-pc-identity.mjs';
import { readPcMap, resolveSeat } from './seat-name.mjs';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { appendStopLedger, registerStopViolation, stopGateOutput } from './lib/stop-recheck.mjs';
import { withStopRetryInstruction } from './lib/stop-retry-message.mjs';

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blank = value => value.replace(/[^\r\n]/g, ' ');
function prose(text) {
  return text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\S\r\n]*$/gm, blank)
    .replace(/(`+)[^\r\n]*?\1/g, blank)
    .replace(/https?:\/\/[^\s<>`"'）)\]]+/g, blank);
}
const except = (text, code) => new RegExp(`\\[${code}-OK:[ \\t]*[^\\s\\]][^\\]\\r\\n]*\\]`).test(text);
export function judge(text, pcMap = readPcMap()) {
  const raw = String(text || '');
  const body = prose(raw);
  const reasons = [];
  const reasonCodes = [];
  if (!except(body, 'SEAT-NAME')) {
    const names = new Set();
    for (const [key, mapped] of pcMapEntries(pcMap)) {
      const seat = resolveSeat(key, pcMap).seat;
      for (const name of [key, mapped.hostname]) {
        if (name && name !== seat && (name !== 'DELL' || mapped.hostname === 'DELL')) names.add(name);
      }
    }
    for (const line of body.split(/\r?\n/)) {
      const candidates = new Set([...names, ...(line.match(/(?<![A-Za-z0-9])DESKTOP-[A-Z0-9]{7}(?![A-Za-z0-9])/g) || [])]);
      for (const name of candidates) {
        const suffix = name === 'DELL' ? '(?=[ \\t]*(?:席|ＰＣ|PC|機|のPC|側|の|で|（|\\(|：|:|、|，|。|$))' : '';
        if (!new RegExp(`(?<![A-Za-z0-9])${escape(name)}(?![A-Za-z0-9])${suffix}`).test(line)) continue;
        const resolved = resolveSeat(name, pcMap);
        const seatMentioned = resolved.registered && new RegExp(`${escape(resolved.seat)}(?![A-Za-z0-9])`).test(line);
        // DELL は「作業用014（DELL 席）」等の括弧注記でのみ席ラベル併記を許す。散文の「作業用014 は DELL です」等は
        // hostname 表記（human 向け文は席ラベルで呼ぶ・2026-11-05 実害）なので検出する。他の名前は従来通り席ラベル併記で救済。
        const seatAnnotation = seatMentioned && (name !== 'DELL' || new RegExp(`${escape(resolved.seat)}[^\\r\\n]*[（(][^\\r\\n]*${escape(name)}`).test(line));
        if (line.includes('番号未登録の席') || seatAnnotation) continue;
        reasons.push(`${name} → ${resolved.seat} と書く（ONBOARDING §1.5.0.2）。`);
      }
    }
    if (reasons.length) reasonCodes.push('SEAT-NAME');
  }
  // 手渡しのパスはコード表記されることもあるため、こちらはコード内も検査する。
  if (!except(body, 'LOCAL-HANDOFF')) {
    const lines = raw.split(/\r?\n/);
    const local = /AppData[\\/]Local[\\/]Temp|scratchpad|[\\/]\.claude[\\/]|C:\\Users\\[^\s`]+/i;
    if (lines.some((line, index) => local.test(line) && /開き|開いて|コピー|貼り付け/.test(lines.slice(index, index + 3).join('\n')))) {
      reasonCodes.push('LOCAL-HANDOFF');
      reasons.push('ONBOARDING §1.5.0.3: Google ドキュメントを対象席アカウントに共有し、その席の Claude に読ませる。kim にローカルファイルを開かせたりコピーさせない。');
    }
  }
  return { decision: reasonCodes.length ? 'block' : 'pass', reasonCodes, reason: reasonCodes.map(code => `[${code}]`).join(' ') + '\n' + [...new Set(reasons)].join('\n') };
}
async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const text = input.last_assistant_message ?? input.assistant_text ?? latestAssistantText(input.transcript_path);
    if (!text) return;
    const result = judge(text);
    if (result.decision !== 'block') return;
    const recheck = registerStopViolation({ input, assistantText: text, blockedBy: ['seat-name-gate'], reasonCodes: result.reasonCodes });
    // ローカル手渡しの本文には秘密が含まれ得るので、ログへ本文を複製しない。
    appendStopLedger({ sessionId: recheck.sessionId, verdict: recheck.verdict, blockedBy: recheck.blockedBy, reasonCodes: recheck.reasonCodes, retryCap: recheck.retryCap });
    console.log(JSON.stringify(stopGateOutput(recheck, withStopRetryInstruction(result.reason))));
  } catch { /* 既存ゲートと同じ fail-open 規約。 */ }
}
if (isEntry(import.meta.url)) await main();
