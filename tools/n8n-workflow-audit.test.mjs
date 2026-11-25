import test from 'node:test';
import assert from 'node:assert/strict';
import { auditWorkflow } from './n8n-workflow-audit.mjs';

const wf = (...nodes) => ({ nodes });

test('安全な合成ワークフローは pass', () => {
  const r = auditWorkflow(wf({ name: 'T', type: 'n8n-nodes-base.webhook', parameters: { path: 'x' } }, { name: 'S', type: 'n8n-nodes-base.set', parameters: { v: 'hello' } }));
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(r.high, []);
});

test('Code / Execute Command ノードは reject', () => {
  assert.equal(auditWorkflow(wf({ name: 'C', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return items' } })).verdict, 'reject');
  assert.equal(auditWorkflow(wf({ name: 'E', type: 'n8n-nodes-base.executeCommand', parameters: { command: 'ls' } })).verdict, 'reject');
});

test('ハードコード秘密と難読化は reject、外部 URL は収集', () => {
  const secret = auditWorkflow(wf({ name: 'H', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://evil.example/x', apiKey: 'sk-' + 'a'.repeat(30) } }));
  assert.equal(secret.verdict, 'reject');
  assert.deepEqual(secret.urls, ['https://evil.example/x']);
  assert.equal(auditWorkflow(wf({ name: 'O', type: 'n8n-nodes-base.set', parameters: { v: 'eval(atob("x"))' } })).verdict, 'reject');
});

test('active:true と HTTP は medium 指摘', () => {
  const r = auditWorkflow({ active: true, nodes: [{ name: 'H', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.notion.com/v1/pages' } }] });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.medium.length, 2);
});
