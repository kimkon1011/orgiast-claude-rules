#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

const stopWords = new Set(['して', 'する', 'します', 'ください', 'お願い', 'それ', 'これ', 'あの', 'the', 'and', 'for', 'with', 'this', 'that']);
// ASCII 語は単語境界で判定する(/OK/i が "hook" に誤マッチして継続扱いになるのを防ぐ)。
const continuation = /続き|さっき|それ|その|同じ|直して|修正|テストして|確認して|デプロイ|もう一度|再実行|続けて|ありがとう|了解|はい|いいえ|なぜ|どうして|(?:ok|verify|commit|push)/i;
const newTask = /別件|ところで|次は|次に|新しく|もう一つ|他に|ついでに|話は変わ|別の件|新規で|今度は/;

function tokens(text) {
  const found = new Set();
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) || []) found.add(word.toLowerCase());
  for (const word of text.match(/[ァ-ヶー]{2,}/g) || []) found.add(word);
  for (const word of text.match(/[一-龥]{2,}/g) || []) {
    if (word.length >= 3) for (let i = 0; i < word.length - 1; i++) found.add(word.slice(i, i + 2));
    else found.add(word);
  }
  for (const word of [...found]) if (word.length < 2 || /^\d+$/.test(word) || stopWords.has(word)) found.delete(word);
  return found;
}

function output(event, additionalContext) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

try {
  if (!raw) process.exit(0);
  const j = JSON.parse(raw);
  const event = j.hook_event_name || (Object.hasOwn(j, 'prompt') ? 'UserPromptSubmit' : 'SessionStart');
  const home = process.env.ORGIAST_HOME || os.homedir();
  const dir = path.join(home, '.claude', 'session-purpose');
  const sessionId = String(j.session_id || 'unknown');
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  const file = path.join(dir, `${safeId}.json`);
  fs.mkdirSync(dir, { recursive: true });

  // 古い状態を起動時に少量だけ掃除する。
  const limit = Date.now() - 14 * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).slice(0, 200)) {
      const target = path.join(dir, name);
      try { if (fs.statSync(target).mtimeMs < limit) fs.unlinkSync(target); } catch {}
    }
  } catch {}

  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  state = { sessionId, startedAt: new Date().toISOString(), promptCount: 0, purpose: '', purposeTokens: [], lastNudgeAt: 0, nudgeCount: 0, nudgedAtCount: 0, ...(state || {}) };
  const save = () => { try { fs.writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8'); } catch {} };

  if (event === 'SessionStart') {
    save();
    let ctx = '【1セッション=1目的 §1.18】このセッションの目的は1件だけ。最初の依頼を受けたら応答の冒頭で `**[本セッションの目的]** <目的>` を1行宣言し、以後その目的から外れる依頼が来たら着手前に「ここで区切って /session-close → 続きは新セッションで」と1行提案せよ(userが「このまま続けて」と言えば継続)。目的が完了したら自分から /session-close を提案する。継続性は memory が担保するので区切って良い。';
    if (state.promptCount >= 1) ctx += `\n本セッションの目的は「${state.purpose}」。この目的に沿った作業だけを続け、別目的なら新セッションを提案せよ。`;
    output('SessionStart', ctx);
    process.exit(0);
  }
  if (event !== 'UserPromptSubmit') process.exit(0);

  const prompt = String(j.prompt || '');
  if (prompt.trimStart().startsWith('/')) process.exit(0);
  state.promptCount += 1;
  if (!prompt || prompt.length < 4) { save(); process.exit(0); }
  const current = tokens(prompt);

  if (state.promptCount === 1 || !state.purpose) {
    state.purpose = prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
    state.purposeTokens = [...current].slice(0, 200);
    save();
    output('UserPromptSubmit', '【本セッションの目的を宣言せよ】この依頼が本セッションの唯一の目的。応答冒頭に `**[本セッションの目的]** <目的>` を出せ。以後この目的以外の依頼は着手前に区切り提案。');
    process.exit(0);
  }

  const base = new Set(state.purposeTokens || []);
  let drift = false;
  if (prompt.length >= 20 && !continuation.test(prompt) && current.size >= 3) {
    if (newTask.test(prompt)) drift = true;
    else {
      let common = 0;
      for (const word of current) if (base.has(word)) common += 1;
      drift = common / Math.min(current.size, base.size || 1) < 0.12;
    }
  }
  let ctx = '';
  if (drift && state.promptCount - Number(state.lastNudgeAt || 0) > 3) {
    ctx = `【目的ドリフト検知 §1.18】本セッションの目的は「${state.purpose}」。今回の依頼は別目的の可能性が高い。**着手する前に**応答の冒頭で1行:『これは別目的なので、ここで /session-close して新セッションで続けるのを推奨します(このまま続けるなら「続けて」と言ってください)』と提案せよ。userが継続を選んだ場合のみ着手する。継続性は memory が担保。`;
  } else if (!drift) {
    state.purposeTokens = [...new Set([...base, ...current])].slice(0, 200);
    if (state.promptCount > 15 && state.promptCount - Number(state.lastNudgeAt || 0) >= 8) ctx = `【セッション肥大 §1.18】このセッションは ${state.promptCount} ターン目。目的「${state.purpose}」が完了しているなら /session-close を提案し、続きは新セッションへ。`;
  }
  if (ctx) {
    state.lastNudgeAt = state.promptCount;
    state.nudgeCount = Number(state.nudgeCount || 0) + 1;
    state.nudgedAtCount = state.promptCount;
  }
  save();
  if (ctx) output('UserPromptSubmit', ctx);
} catch {}
process.exit(0);
