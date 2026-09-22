import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const dir = path.dirname(new URL(import.meta.url).pathname);
const settingsFile = '/mnt/c/Users/uers/.claude/settings.json';
const raw = fs.readFileSync(settingsFile, 'utf8');
const settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
const groups = settings.hooks.PostToolUse.filter(g => g.hooks?.some(h => h.command?.includes('gemini-mcp-usage-hook.mjs')));
assert.equal(groups.length, 1);
const hook = groups[0].hooks.find(h => h.command.includes('gemini-mcp-usage-hook.mjs'));
const windowsPath = hook.command.match(/^node "([^"]+)"$/)?.[1];
assert.ok(windowsPath);
const script = windowsPath.replace(/^C:\\/i, '/mnt/c/').replaceAll('\\', '/');
assert.equal(script, '/mnt/c/Users/uers/orgiast-main/tools/gemini-mcp-usage-hook.mjs');
assert.ok(fs.existsSync(script));
const home = fs.mkdtempSync('/tmp/gemini-hook-verify-');
const ledger = path.join(home, '.claude/executor-usage.jsonl');
const cases = [];
for (const name of ['ask-gemini', 'geminiChat', 'googleSearch']) {
 const tool = `mcp__gemini-cli__${name}`;
 assert.ok(new RegExp(`^(?:${groups[0].matcher})$`).test(tool));
 const event = {hook_event_name:'PostToolUse', tool_name:tool, tool_use_id:`isolated-${name}`, tool_response:{structuredContent:{modelVersion:'test-model',usageMetadata:{promptTokenCount:17,candidatesTokenCount:5,thoughtsTokenCount:2}}}};
 const child = spawnSync(process.execPath, [script], {input:JSON.stringify(event),encoding:'utf8',env:{...process.env,ORGIAST_HOME:home},timeout:10000});
 assert.equal(child.status,0);
 assert.equal(child.error,undefined);
 const rows = fs.readFileSync(ledger,'utf8').trim().split('\n').map(JSON.parse);
 const row = rows.at(-1);
 assert.equal(row.tool,tool); assert.equal(row.in,17); assert.equal(row.out,7); assert.equal(row.source,'mcp'); assert.equal(row.toolUseId,event.tool_use_id);
 cases.push({tool,status:'passed',row});
}
const before = fs.readFileSync(ledger,'utf8');
spawnSync(process.execPath,[script],{input:JSON.stringify({tool_name:'Bash'}),env:{...process.env,ORGIAST_HOME:home},timeout:10000});
assert.equal(fs.readFileSync(ledger,'utf8'),before);
let production = {exists:false};
const liveLedger = '/mnt/c/Users/uers/.claude/executor-usage.jsonl';
if(fs.existsSync(liveLedger)) {
 let count=0, measured=0, last=null;
 for(const line of fs.readFileSync(liveLedger,'utf8').split('\n')) {try {const r=JSON.parse(line);if(r.source==='mcp'&&r.provider==='gemini'){count++;if(Number.isInteger(r.in)&&Number.isInteger(r.out))measured++;last=r.t;}}catch{}}
 production={exists:true,geminiMcpRows:count,measuredRows:measured,lastTimestamp:last};
}
assert.equal(fs.readFileSync(settingsFile,'utf8'),raw);
const report={checkedAt:new Date().toISOString(),task:'Gemini MCP 使用量 hook 登録',finding:'PostToolUse は既に orgiast-main の対象 hook を登録済み。設定変更不要。',settingsFile,settingsSha256:crypto.createHash('sha256').update(raw).digest('hex'),registration:groups[0],script,scriptSha256:crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'),cases,unrelatedToolIgnored:true,productionLedger:production,settingsUnchanged:true,externalApiCalls:0,limitations:['実 Claude セッションからの発火は未検証。外部送信・課金を避け隔離入力で直接実行した。','指定結果 JSON 保存先は書き込み許可範囲外。'],otherFailureRegistration:settings.hooks.PostToolUseFailure?.filter(g=>g.hooks?.some(h=>h.command?.includes('gemini-mcp-usage-hook.mjs')))};
const evidenceFile=path.join(dir,'verification.json');
fs.writeFileSync(evidenceFile,JSON.stringify(report,null,2)+'\n');
const result={completed:false,summary:'対象 hook は既に正しい PostToolUse 設定に登録済み。3種類の模擬 MCP 応答から台帳へのトークン記録を直接確認し、設定は変更していない。ただし指定の結果 JSON 保存先はセッションの書き込み許可範囲外のため、保存条件を満たせない。',evidence:{file:evidenceFile,sha256:crypto.createHash('sha256').update(fs.readFileSync(evidenceFile)).digest('hex')}};
fs.writeFileSync(path.join(dir,'acb3cb665a28ab7024b1-1790104640589.result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({cases:cases.map(c=>({tool:c.tool,status:c.status})),production,result},null,2));
