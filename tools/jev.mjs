#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const homeDir = () => process.env.ORGIAST_HOME || os.homedir();
function apiKey(home) {
  return process.env.TYPESAFE_API_KEY || readEnvValue(path.join(home, '.claude', 'typesafe.env'), 'TYPESAFE_API_KEY');
}
// 本文・例外・応答に鍵が反射されても、呼び出し元や使用量ログへ漏らさない。
export async function askJev({ state, questions, model = 'jev-latest', timeoutMs = 8000, label = 'ask', home = homeDir() } = {}) {
  const key = apiKey(home);
  if (!key) return { ok: false, reason: 'missing_key' };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { ok: false, reason: 'invalid_timeout' };
  const controller = new AbortController();
  let timer;
  try {
    const expired = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs);
    });
    // fetch だけでなく本文読込にも期限を適用する。abort 非対応のスタブでも待ち続けない。
    return await Promise.race([expired, (async () => {
      const response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state, questions }), signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: `http_${Number(response.status) || 0}` };
      const data = await response.json();
      if (!data?.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) return { ok: false, reason: 'invalid_response' };
      if (JSON.stringify({ ...data, model: data.model || model }).includes(key)) return { ok: false, reason: 'unsafe_response' };
      if (controller.signal.aborted) return { ok: false, reason: 'timeout' };
      try {
        const dir = path.join(home, '.claude');
        const usage = { ts: new Date().toISOString(), model: data.model || model, input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0, label };
        if (!JSON.stringify(usage).includes(key)) {
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(path.join(dir, 'jev-usage.jsonl'), `${JSON.stringify(usage)}\n`);
        }
      } catch { /* 記録失敗だけで判断を失敗させない。 */ }
      return { ok: true, model: data.model || model, answers: data.answers, usage: data.usage };
    })()]);
  } catch { return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'request_failed' }; }
  finally { clearTimeout(timer); }
}
export const choose = (state, instructions, criteria) => askJev({ state, questions: { choice: { type: 'choice', instructions, criteria } }, label: 'choice' });
export const noul = (state, instructions) => askJev({ state, questions: { noul: { type: 'noul', instructions } }, label: 'noul' });

export async function main(argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      state: { type: 'string' }, instructions: { type: 'string' }, option: { type: 'string', multiple: true },
    } });
    const command = positionals[0];
    if (command === 'doctor') {
      const keyPresent = Boolean(apiKey(homeDir()));
      const result = await noul('Connection check', 'Return zero.');
      return { ...result, keyPresent };
    }
    if (!values.state || !values.instructions) return { ok: false, reason: 'state_and_instructions_required' };
    if (command === 'noul') return noul(values.state, values.instructions);
    if (command === 'choice') {
      const criteria = Object.fromEntries((values.option || []).map(option => {
        const i = option.indexOf('=');
        return i < 0 ? [option, null] : [option.slice(0, i), option.slice(i + 1)];
      }));
      if (!Object.keys(criteria).length) return { ok: false, reason: 'options_required' };
      return choose(values.state, values.instructions, criteria);
    }
    return { ok: false, reason: 'unknown_command' };
  } catch { return { ok: false, reason: 'invalid_arguments' }; }
}
if (isEntry(import.meta.url)) console.log(JSON.stringify(await main()));
