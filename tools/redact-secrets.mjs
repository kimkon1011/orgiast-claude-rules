#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REDACTED = '***REDACTED***';

export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let value = text;
  value = value.replace(/\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)([^\s/:@]+):([^\s/@]+)@/gi, (_, scheme, user) => `${scheme}${user}:${REDACTED}@`);
  value = value.replace(/\b(https:\/\/discord\.com\/api\/webhooks\/)[^\s<>'"`]+/gi, `$1${REDACTED}`);
  value = value.replace(/\b(https:\/\/hooks\.slack\.com\/)[^\s<>'"`]+/gi, `$1${REDACTED}`);
  value = value.replace(/\b(sk_live_|github_pat_|sk-ant-|xoxb-|xoxp-|ghp_|gho_|AIza|gsk_|xai-|sk-)[A-Za-z0-9._-]{10,}/g, (_, prefix) => `${prefix}${REDACTED}`);
  value = value.replace(/\b(eyJ)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, `$1${REDACTED}`);
  value = value.replace(/\b(password|passwd|pwd|token|secret|api_key)(\s*[:=]\s*)(["']?)([^\s&;,}"']+)(["']?)/gi, (_, key, separator, quote) => `${key}${separator}${quote}${REDACTED}${quote}`);
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@([^\s/@]+)/gi, (_, scheme, user, _password, host) => `${scheme}${user}:${REDACTED}@${host}`);
  value = value.replace(/\b([^\s/:@]+):([^\s/@]+)@([a-z0-9.-]+(?::[0-9]+)?)/gi, (_, user, _password, host) => `${user}:${REDACTED}@${host}`);
  return value;
}

function selftest() {
  const samples = [
    'postgresql://alice:p%40ssword@db.example.test:5432/app',
    'mongodb+srv://robot:made-up-pass@cluster.example.test/db',
    'https://discord.com/api/webhooks/123456789/fakeWebhookSecret',
    'https://hooks.slack.com/services/T000/B000/fakeWebhookSecret',
    'sk-exampleToken1234567890 ghp_abcdefghijklmnopqrstuvwxyz',
    'xoxb-1234567890-exampletoken AIza1234567890abcdefghijk',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.fake_signature',
    'password=hunter2&api_key=fake-api-key-value token: "fake-token-value"',
    'https://demo:fake-password@example.test/private',
    'demo:fake-password@example.test',
  ];
  const output = samples.map(redactSecrets);
  const leaked = output.some((line) => !line.includes(REDACTED) || /p%40ssword|made-up-pass|fakeWebhookSecret|abcdefghijklmnopqrstuvwxyz|1234567890abcdefghijk|fake_signature|hunter2|fake-api-key-value|fake-token-value|fake-password/.test(line));
  if (leaked) {
    console.error('redact-secrets selftest: FAILED');
    output.forEach((line) => console.error(line));
    process.exitCode = 1;
  } else console.log(`redact-secrets selftest: OK (${samples.length} samples)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    console.error('使い方: node tools/redact-secrets.mjs --selftest');
    process.exitCode = 2;
  }
}
