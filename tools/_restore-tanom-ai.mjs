import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const deployment = 'dpl_6y8Rm9yaFPGheeaFpPNtbHdpbVaf';
const destination = 'C:/Users/kimko/tanom-ai';
const envText = fs.readFileSync(path.join(os.homedir(), '.claude', 'vercel.env'), 'utf8');
const token = envText.match(/^VERCEL_TOKEN=(.*)$/m)?.[1]?.trim();
if (!token) throw new Error('VERCEL_TOKEN is missing');
const headers = { Authorization: `Bearer ${token}` };
const api = async (url) => {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
};
const tree = await api(`https://api.vercel.com/v6/deployments/${deployment}/files`);
const files = [];
const walk = (nodes, prefix = '') => {
  for (const node of nodes || []) {
    const rel = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === 'directory') walk(node.children, rel);
    else if (node.uid && (rel === 'package.json' || rel === 'package-lock.json' || rel === 'tsconfig.json' || rel === 'next.config.js' || rel === 'next.config.mjs' || rel === '.feedback-exempt' || rel === 'HANDOVER.md' || rel.startsWith('src/') || rel.startsWith('public/'))) files.push({ rel, uid: node.uid });
  }
};
walk(Array.isArray(tree) ? tree : tree.files || tree.children);
fs.mkdirSync(destination, { recursive: true });
for (const file of files) {
  const payload = await api(`https://api.vercel.com/v7/deployments/${deployment}/files/${file.uid}`);
  const data = Buffer.from(payload.data, payload.encoding === 'base64' || !payload.encoding ? 'base64' : payload.encoding);
  const target = path.join(destination, ...file.rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
console.log(`restored ${files.length} files`);
