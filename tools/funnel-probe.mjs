#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Resolver } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { isEntry } from './is-entry.mjs';

const PREFIX = '[funnel-probe]';
const DEFAULT_HOST = 'claude-pc.tailc5d751.ts.net';

export function verdictOf({ dns, https, local }) {
  if (!local.ok) return 'local-down';
  if (!dns.ok) return 'dns-missing';
  if (!https.ok) return 'https-unreachable';
  return 'ok';
}

export function trimLines(lines, maxLines) {
  return lines.length <= maxLines ? lines : lines.slice(-maxLines);
}

function parseArgs(argv) {
  const options = {
    out: path.join(os.homedir(), '.claude', 'logs', 'funnel-probe.jsonl'),
    maxLines: 2000,
    host: DEFAULT_HOST,
    localUrl: 'http://localhost:3939/',
    dnsServer: '8.8.8.8',
  };
  const keys = {
    '--out': 'out',
    '--max-lines': 'maxLines',
    '--host': 'host',
    '--local-url': 'localUrl',
    '--dns-server': 'dnsServer',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = keys[argv[i]];
    if (!key) throw new Error(`不明な引数です: ${argv[i]}`);
    if (!argv[i + 1]) throw new Error(`${argv[i]} には値が必要です`);
    options[key] = argv[++i];
  }
  options.maxLines = Number(options.maxLines);
  if (!Number.isInteger(options.maxLines) || options.maxLines < 1) {
    throw new Error('--max-lines は1以上の整数にしてください');
  }
  return options;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// DNS は OS/MagicDNS を使わず、GitHub 側から見える公開 DNS の状態を測る。
//
// resolve4 と resolve6 は **必ず別の Resolver インスタンス**で引く。同一インスタンスに
// 2本を並行で投げると c-ares 側で片方が握られ、応答があるのに ETIMEOUT になる
// (2026-09-02 実測: 同一で並行=v4がETIMEOUT/5050ms、別インスタンスで並行=両方成功/30ms、
// 同一で逐次=両方成功/22ms)。これを踏むと本当は健全なのに毎時 dns-missing を出し続ける
// 常時赤の計測になり、指標として死ぬ。
export const DNS_QUERY_TIMEOUT_MS = 4_000;
export const DNS_TOTAL_TIMEOUT_MS = 8_000; // 個別より必ず長くする。短いと成功した側まで巻き添えで落ちる

export function createResolver(dnsServer) {
  const resolver = new Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: 1 });
  resolver.setServers([dnsServer]);
  return resolver;
}

// deps.createResolver はテストから差し替える。resolve4/resolve6 それぞれに対して
// 1回ずつ呼ばれる（＝インスタンスを共有しない）ことをテストで固定している。
export async function probeDns(host, dnsServer, deps = {}) {
  const makeResolver = deps.createResolver || createResolver;
  const started = performance.now();
  const lookup = async (method) => {
    const resolver = makeResolver(dnsServer);
    try { return { addresses: await resolver[method](host), error: null }; }
    catch (error) { return { addresses: [], error: errorText(error) }; }
  };
  let timer;
  try {
    const result = await Promise.race([
      Promise.all([lookup('resolve4'), lookup('resolve6')]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`DNS timeout (${DNS_TOTAL_TIMEOUT_MS}ms)`)), DNS_TOTAL_TIMEOUT_MS); }),
    ]);
    const [v4, v6] = result;
    const ok = v4.addresses.length > 0 || v6.addresses.length > 0;
    return {
      ok,
      a: v4.addresses,
      aaaa: v6.addresses,
      ms: Math.round(performance.now() - started),
      error: ok ? null : [v4.error, v6.error].filter(Boolean).join('; ') || 'アドレスがありません',
    };
  } catch (error) {
    return { ok: false, a: [], aaaa: [], ms: Math.round(performance.now() - started), error: errorText(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeHttp(url, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    // HTTP 応答が返れば、ステータスにかかわらず経路には到達している。
    await response.body?.cancel();
    return { ok: true, status: response.status, ms: Math.round(performance.now() - started), error: null };
  } catch (error) {
    return { ok: false, status: null, ms: Math.round(performance.now() - started), error: errorText(error) };
  }
}

function appendAndTrim(outPath, record, maxLines) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8');
  const lines = fs.readFileSync(outPath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
  fs.writeFileSync(outPath, `${trimLines(lines, maxLines).join('\n')}\n`, 'utf8');
}

function summary(name, result) {
  return `${PREFIX} ${name}: ok=${result.ok} status=${result.status ?? '-'} ms=${result.ms} error=${result.error ?? '-'}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dns = await probeDns(options.host, options.dnsServer);
  const localPromise = probeHttp(options.localUrl, 5_000);
  const https = dns.ok
    ? await probeHttp(`https://${options.host}/`, 10_000)
    : { ok: false, status: null, ms: 0, error: 'DNS が引けないため未実施' };
  const local = await localPromise;
  const verdict = verdictOf({ dns, https, local });
  const record = { t: new Date().toISOString(), dns, https, local, verdict };
  appendAndTrim(options.out, record, options.maxLines);

  console.log(`${PREFIX} verdict: ${verdict}`);
  console.log(`${PREFIX} dns: ok=${dns.ok} a=${dns.a.join(',') || '-'} aaaa=${dns.aaaa.join(',') || '-'} ms=${dns.ms} error=${dns.error ?? '-'}`);
  console.log(summary('https', https));
  console.log(summary('local', local));
  if (verdict !== 'ok') {
    console.error(`${PREFIX} error: verdict=${verdict}`);
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) main().catch((error) => {
  console.error(`${PREFIX} error: ${error.stack || error.message}`);
  process.exitCode = 1;
});
