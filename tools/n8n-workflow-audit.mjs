#!/usr/bin/env node
// 第三者 n8n ワークフロー JSON の静的審査。ファイルを実行・import せず読むだけ。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

const EXEC_TYPES = ['n8n-nodes-base.code', 'n8n-nodes-base.executeCommand', 'n8n-nodes-base.function', 'n8n-nodes-base.functionItem', 'n8n-nodes-base.ssh'];
const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["'])/i;
const OBFUSCATION_RE = /(eval\s*\(|new Function\s*\(|atob\s*\(|fromCharCode|child_process|require\(['"]fs['"]\)|[A-Za-z0-9+/]{200,}={0,2})/;
const URL_RE = /https?:\/\/[^\s"'`)<>\\]+/g;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out));
  return out;
}

export function auditWorkflow(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const high = [], medium = [], urls = new Set();
  for (const node of nodes) {
    const label = `${node.name || '?'} (${node.type})`;
    if (EXEC_TYPES.includes(node.type)) high.push(`実行系ノード: ${label}`);
    const texts = strings(node.parameters);
    for (const text of texts) {
      for (const u of text.match(URL_RE) || []) urls.add(u.replace(/[.,;]+$/, ''));
      if (SECRET_RE.test(text)) high.push(`ハードコード秘密の疑い: ${label}`);
      if (OBFUSCATION_RE.test(text)) high.push(`難読化/動的実行の疑い: ${label}`);
    }
    if (node.type === 'n8n-nodes-base.httpRequest') medium.push(`外部HTTP: ${label}`);
    if (/gmail|email|slack|discord|telegram|twilio|stripe/i.test(node.type) && /send|message|charge|create/i.test(JSON.stringify(node.parameters || {}).slice(0, 4000))) medium.push(`外部送信/課金の可能性: ${label}`);
  }
  if (workflow?.active === true) medium.push('active:true（import 時に false 化が必要）');
  return { nodeCount: nodes.length, high: [...new Set(high)], medium: [...new Set(medium)], urls: [...urls].sort(), verdict: high.length ? 'reject' : 'pass' };
}

export function auditFile(file) {
  const buf = fs.readFileSync(file);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), ...auditWorkflow(JSON.parse(buf.toString('utf8'))) };
}

if (isEntry(import.meta.url)) {
  for (const file of process.argv.slice(2)) {
    const r = auditFile(file);
    console.log(JSON.stringify({ file, ...r, sha256: r.sha256.slice(0, 16) }, null, 2));
  }
}
