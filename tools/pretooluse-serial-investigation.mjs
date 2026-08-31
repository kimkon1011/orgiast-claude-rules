#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isReadOnlyToolUse } from './usage-stats.mjs';

try {
  let raw = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw), name = String(input.tool_name || ''), sessionId = String(input.session_id || 'default');
  const home = process.env.ORGIAST_HOME || os.homedir(), file = path.join(home, '.claude', '.serial-investigation.json'), now = Date.now(); let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); if (!state || Array.isArray(state) || typeof state !== 'object') state = {}; } catch {}
  for (const [key, value] of Object.entries(state)) if (!value || now - Number(value.ts || 0) >= 864e5) delete state[key];
  const count = isReadOnlyToolUse(name, input.tool_input) ? Number(state[sessionId]?.count || 0) + 1 : 0, warn = count >= 4;
  state[sessionId] = { count: warn ? 0 : count, ts: now };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); } catch {}
  if (warn) {
    const context = `⚠️ 直近 ${count} 回、read-only の調査コマンドを1回ずつ別々に実行しています。thinking は出力の70%を占め、1レスポンスにつき1回課金されます。\n対策1: 依存関係のない調査コマンドは1レスポンスにまとめて同時に投げてください（現状まとめられているのは 6.1% だけです）。\n対策2: まとまった探索は Agent(Explore) に「結果は200字以内・コード本体は含めない」と指定して委譲し、監督は1レスポンスで受け取ってください。\neffort を下げて深さを削るのではなく、思考パスの回数を削ることが目的です。`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }));
  }
} catch {}
