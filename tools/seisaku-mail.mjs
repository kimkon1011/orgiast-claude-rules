#!/usr/bin/env node
/**
 * seisaku-team@ mail via GitHub Actions (Node standard library + gh only).
 * draft|send --to addr --subject text --body-file path [--cc a,b]
 *   [--reply-to-thread-of addr] [--attach-drive id1,id2] [--yes] [--wait 600] [--json]
 * search --query 'gmail query' [--max 10] [--user seisaku-team@orgiast.jp]
 * thread|message|delete-draft --id ID / drafts (also accept --wait and --json).
 * send requires --yes after reviewing the preview. No mail is sent by tests.
 * GH_TOKEN falls back to ~/.gh-device/token.txt; SEISAKU_MAIL_REPO overrides repo.
 */
import { spawnSync as nativeSpawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'kimkon1011/aujust-sales-automation';
const WRITE_WORKFLOW = 'seisaku-mail.yml';
const READ_WORKFLOW = 'seisaku-mail-read.yml';
const READ_ACTIONS = ['search', 'thread', 'message', 'drafts', 'delete-draft'];
class UsageError extends Error {}

function parse(argv) {
  const [action, ...rest] = argv;
  if (!['draft', 'send', ...READ_ACTIONS].includes(action)) throw new UsageError('Expected draft, send, search, thread, message, drafts or delete-draft');
  const write = ['draft', 'send'].includes(action);
  const allowed = new Set(['wait', 'json', ...(write ? ['to', 'subject', 'body-file', 'cc', 'reply-to-thread-of', 'attach-drive', 'yes'] : ['query', 'max', 'user', 'id'])]);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed.has(key) || Object.hasOwn(opts, key)) throw new UsageError(`Invalid or duplicate option: ${rest[i]}`);
    if (['yes', 'json'].includes(key)) opts[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new UsageError(`Missing value: --${key}`);
      opts[key] = rest[++i];
    }
  }
  for (const key of write ? ['to', 'subject', 'body-file'] : action === 'search' ? ['query'] : ['thread', 'message', 'delete-draft'].includes(action) ? ['id'] : []) {
    if (!opts[key]?.trim()) throw new UsageError(`Required: --${key}`);
  }
  for (const key of ['to', 'cc', 'subject', 'reply-to-thread-of']) {
    if (/[\r\n]/.test(opts[key] || '')) throw new UsageError(`Newline in --${key}`);
  }
  const wait = Number(opts.wait ?? 600);
  if (!Number.isFinite(wait) || wait <= 0) throw new UsageError('--wait must be positive seconds');
  if (opts.max !== undefined && (!/^\d+$/.test(opts.max) || Number(opts.max) < 1 || !Number.isSafeInteger(Number(opts.max)))) throw new UsageError('--max must be a positive integer');
  return { action, opts, write, wait };
}

export function createCli({ spawnSync = nativeSpawnSync, env = process.env, home = homedir(), now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), stdout = s => process.stdout.write(s) } = {}) {
  return async function run(argv) {
    let token = '', json = argv.includes('--json');
    const redact = value => token ? String(value).split(token).join('[REDACTED]') : String(value);
    const emit = value => stdout(redact(value) + '\n');
    const output = result => {
      if (json) emit(JSON.stringify(result));
      else {
        const detail = Object.entries(result).filter(([k]) => !['ok', 'runUrl'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ');
        emit(`${result.ok ? '✅' : '❌'} ${detail}  ${result.runUrl ? `run=${result.runUrl}` : ''}`.trim());
      }
    };
    try {
      const { action, opts, write, wait } = parse(argv);
      json = !!opts.json;
      let body;
      if (write) {
        try { body = readFileSync(opts['body-file'], 'utf8'); }
        catch { throw new UsageError('Cannot read --body-file as UTF-8'); }
      }
      if (action === 'send' && !opts.yes) {
        output({ ok: false, error: 'send requires --yes', to: opts.to, cc: opts.cc || '', subject: opts.subject, preview: body.split(/\r?\n/).slice(0, 3).join('\n'), attachmentDriveIds: opts['attach-drive'] || '' });
        return 64;
      }
      token = env.GH_TOKEN?.trim() || '';
      if (!token) {
        try { token = readFileSync(join(home, '.gh-device', 'token.txt'), 'utf8').trim(); } catch { /* gh may already be authenticated */ }
      }
      const repo = env.SEISAKU_MAIL_REPO || REPO;
      const gh = args => {
        const res = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, shell: false, env: { ...env, ...(token ? { GH_TOKEN: token } : {}) }, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        if (res.error || res.status !== 0) throw new Error(`gh ${args[0]} failed${res.status == null ? '' : ` (exit ${res.status})`}`);
        return res.stdout || '';
      };
      const workflow = write ? WRITE_WORKFLOW : READ_WORKFLOW;
      const inputs = write ? { mode: action, to: opts.to, subject: opts.subject, body_b64: Buffer.from(body, 'utf8').toString('base64') } : { action, user: opts.user || 'seisaku-team@orgiast.jp', ...(action === 'search' ? { query: opts.query, max: opts.max || '10' } : {}), ...(opts.id ? { id: opts.id } : {}) };
      if (write) for (const [flag, input] of [['cc', 'cc'], ['reply-to-thread-of', 'reply_to_thread_of'], ['attach-drive', 'attachment_drive_ids']]) if (opts[flag]) inputs[input] = opts[flag];
      const args = ['workflow', 'run', workflow, '--repo', repo];
      for (const [key, value] of Object.entries(inputs)) args.push('-f', `${key}=${value}`);
      // GitHub timestamps have second precision; preserve the dispatch second.
      const started = now();
      const createdAfter = Math.floor(started / 1000) * 1000;
      gh(args);
      const deadline = started + wait * 1000;
      let run;
      while (now() < deadline) {
        if (!run) {
          const listing = JSON.parse(gh(['api', `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=5`]));
          run = (listing.workflow_runs || []).filter(r => Date.parse(r.created_at) >= createdAfter).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
        } else {
          run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${run.id}`]));
        }
        if (run?.status === 'completed') break;
        await sleep(Math.min(5000, Math.max(0, deadline - now())));
      }
      const runUrl = run?.html_url || (run ? `https://github.com/${repo}/actions/runs/${run.id}` : undefined);
      if (run?.status !== 'completed') { output({ ok: false, error: 'wait timeout', ...(runUrl ? { runUrl } : {}) }); return 2; }
      let result;
      const dir = mkdtempSync(join(tmpdir(), 'seisaku-mail-'));
      try {
        gh(['run', 'download', String(run.id), '--repo', repo, '-n', write ? 'seisaku-mail-result' : 'seisaku-mail-read-result', '-D', dir]);
        result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
      } catch { /* Older workflows expose only a log result. */ }
      finally { rmSync(dir, { recursive: true, force: true }); }
      if (!result || typeof result.ok !== 'boolean') {
        result = undefined;
        let log = '';
        try { log = gh(['run', 'view', String(run.id), '--repo', repo, '--log']); } catch { /* No readable log result either. */ }
        for (const line of log.split(/\r?\n/)) {
          // gh log prefixes JSON with job, step and timestamp columns.
          const start = line.indexOf('{"ok":');
          if (start < 0) continue;
          try { const candidate = JSON.parse(line.slice(start).trim()); if (typeof candidate.ok === 'boolean') result = candidate; } catch { /* Not a result line. */ }
        }
      }
      result = { ...(result || { ok: false, error: 'result not found' }), runUrl };
      output(result);
      return result.ok === true ? 0 : 1;
    } catch (error) {
      output({ ok: false, error: error.message });
      return error instanceof UsageError ? 64 : 1;
    }
  };
}

if (isEntry(import.meta.url)) {
  process.exitCode = await createCli()(process.argv.slice(2));
}
