#!/usr/bin/env node
// login-health.mjs — ログイン切れの自動点検・修復・通知
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { addItem as addKimInboxItem, listItems as listKimInboxItems, markSeen as markKimInboxSeen } from './kim-inbox.mjs';

export function loginHome() {
  return process.env.ORGIAST_HOME || os.homedir();
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function writeAtomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

export function nonInteractiveEnv(extra = {}) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    ...extra,
  };
}

export function desktopCmdExists(home, filename) {
  const desktopPaths = [
    path.join(home, 'Desktop', filename),
    path.join(home, 'デスクトップ', filename),
  ];
  return desktopPaths.some(p => fs.existsSync(p));
}

// ---------------------------------------------------------
// Probes
// ---------------------------------------------------------

export async function probeGithub({
  home = loginHome(),
  execImpl = spawnSync,
  fetchImpl = fetch,
  fix = false,
} = {}) {
  let pat = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
  let patSource = pat ? 'env' : null;

  if (!pat) {
    // Try GCM
    const res = execImpl('git', ['-c', 'core.askPass=', 'credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      cwd: home,
      timeout: 15000,
      windowsHide: true,
      env: nonInteractiveEnv(),
    });
    const stdout = String(res?.stdout || '');
    const match = stdout.match(/^password=(.+)$/m);
    if (match && match[1].trim().length >= 10) {
      pat = match[1].trim();
      patSource = 'git-credential';
    } else {
      // Try direct credential-manager
      const res2 = execImpl('git', ['-c', 'core.askPass=', 'credential-manager', 'get'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
        cwd: home,
        timeout: 15000,
        windowsHide: true,
        env: nonInteractiveEnv(),
      });
      const stdout2 = String(res2?.stdout || '');
      const match2 = stdout2.match(/^password=(.+)$/m);
      if (match2 && match2[1].trim().length >= 10) {
        pat = match2[1].trim();
        patSource = 'gcm';
      }
    }
  }

  let patValid = false;
  let patLogin = '';
  let expDays = null;

  if (pat) {
    try {
      const resp = await fetchImpl('https://api.github.com/user', {
        headers: {
          'Authorization': `token ${pat}`,
          'User-Agent': 'login-health',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        patValid = true;
        const data = await resp.json();
        patLogin = data?.login || '';
        const expHeader = resp.headers.get('github-authentication-token-expiration');
        if (expHeader) {
          const expTime = Date.parse(expHeader);
          if (Number.isFinite(expTime)) {
            expDays = Math.max(0, Math.floor((expTime - Date.now()) / 86400000));
          }
        }
      }
    } catch {}
  }

  // Check gh auth status
  const ghRes = execImpl('gh', ['auth', 'status'], {
    encoding: 'utf8',
    cwd: home,
    timeout: 15000,
    windowsHide: true,
    env: nonInteractiveEnv({ GH_TOKEN: pat || '' }),
  });
  let ghLoggedIn = ghRes?.status === 0;

  // Self fix: gh not logged in but PAT is valid
  if (fix && patValid && !ghLoggedIn) {
    const loginRes = execImpl('gh', ['auth', 'login', '--with-token'], {
      input: `${pat}\n`,
      encoding: 'utf8',
      cwd: home,
      timeout: 15000,
      windowsHide: true,
      env: nonInteractiveEnv(),
    });
    if (loginRes?.status === 0) {
      const verifyRes = execImpl('gh', ['auth', 'status'], {
        encoding: 'utf8',
        cwd: home,
        timeout: 15000,
        windowsHide: true,
        env: nonInteractiveEnv(),
      });
      if (verifyRes?.status === 0) {
        ghLoggedIn = true;
      }
    }
  }

  if (patValid && ghLoggedIn) {
    if (expDays !== null && expDays <= 7) {
      return {
        id: 'github',
        status: 'warn',
        detail: `PAT有効(${patLogin}, 期限${expDays}日以内)`,
        remedy: 'PATを再発行して GCM へ登録',
      };
    }
    return {
      id: 'github',
      status: 'ok',
      detail: `PAT有効・gh認証済み (${patLogin})`,
      remedy: 'gh auth status',
    };
  } else if (patValid && !ghLoggedIn) {
    return {
      id: 'github',
      status: 'warn',
      detail: `PAT有効(${patLogin})・gh未ログイン`,
      remedy: 'gh auth login（PAT有効）',
    };
  } else {
    return {
      id: 'github',
      status: 'fail',
      detail: 'GitHub 認証切れ(PAT/gh不可)',
      remedy: 'gh auth login または PAT 再発行',
    };
  }
}

export async function probeClaude({
  home = loginHome(),
  execImpl = spawnSync,
} = {}) {
  const res = execImpl('claude', ['auth', 'status'], {
    encoding: 'utf8',
    cwd: home,
    timeout: 15000,
    windowsHide: true,
    env: nonInteractiveEnv(),
  });
  const output = String(res?.stdout || '') + String(res?.stderr || '');
  let statusJson = null;
  try {
    statusJson = JSON.parse(output.trim().match(/\{[\s\S]*\}/)?.[0] || '');
  } catch {}

  const loggedIn = statusJson?.loggedIn === true || /Logged in as/i.test(output);
  const authMethod = statusJson?.authMethod || (output.includes('API key') ? 'api_key' : 'claude.ai');
  const subscriptionType = statusJson?.subscriptionType || '';

  if (loggedIn) {
    if (authMethod && authMethod !== 'claude.ai') {
      return {
        id: 'claude',
        status: 'fail',
        detail: `認証方式不正 (${authMethod}。claude.ai が必須)`,
        remedy: 'claude auth login',
      };
    }
    return {
      id: 'claude',
      status: 'ok',
      detail: `ログイン済み (${subscriptionType || 'claude.ai'})`,
      remedy: 'claude auth status',
    };
  } else {
    return {
      id: 'claude',
      status: 'fail',
      detail: 'Claude Code 未ログイン',
      remedy: 'claude auth login',
    };
  }
}

export async function probeCodex({
  home = loginHome(),
  execImpl = spawnSync,
  platform = process.platform,
  now = Date.now(),
} = {}) {
  // 1. Check WSLService
  if (platform === 'win32') {
    const scRes = execImpl('sc', ['query', 'WslService'], {
      encoding: 'utf8',
      cwd: home,
      timeout: 10000,
      windowsHide: true,
    });
    const scOut = String(scRes?.stdout || '');
    if (/STOP_PENDING/i.test(scOut)) {
      // Try running OrgiastWslFix task if schtasks exists
      let fixed = false;
      try {
        const runTask = execImpl('schtasks', ['/run', '/tn', 'OrgiastWslFix'], {
          encoding: 'utf8',
          cwd: home,
          timeout: 10000,
          windowsHide: true,
        });
        if (runTask?.status === 0) {
          fixed = true;
        }
      } catch {}

      const hasCmd = desktopCmdExists(home, 'WSL-fix.cmd');
      return {
        id: 'codex',
        status: 'fail',
        detail: 'wsl_hung (WSLService STOP_PENDING)',
        remedy: hasCmd ? 'WSL-fix.cmd をダブルクリック（初回だけ、以後は自動）' : 'schtasks /run /tn OrgiastWslFix',
      };
    }
  }

  // 2. Check lane-health.json for recent auth failure (auth_lost)
  const laneHealth = readJson(path.join(home, '.claude', 'lane-health.json'), null);
  const codexLane = laneHealth?.lanes?.codex;
  if (codexLane) {
    const real24h = codexLane.real24h;
    const authPattern = /401|unauthorized|bearer or basic authentication|authentication|refresh_token|token_revoked|invalid_grant|not logged in/i;
    const lastOk = Date.parse(codexLane.lastProbeOkAt || codexLane.probedAt || 0) || 0;
    const hasAuthError = real24h?.events?.some(e => e.at > lastOk && authPattern.test(e.reason || ''))
      || (codexLane.reason && /oauth_consent|auth_invalid/i.test(codexLane.reason));

    if (hasAuthError) {
      const hasCmd = desktopCmdExists(home, 'Codexログイン（ダブルクリック）.cmd');
      return {
        id: 'codex',
        status: 'fail',
        detail: 'auth_lost (401/認証切れ)',
        remedy: hasCmd ? 'Codexログイン（ダブルクリック）.cmd' : 'codex login',
      };
    }
  }

  // 3. Check auth.json
  const winAuthPath = path.join(home, '.codex', 'auth.json');
  const winAuth = readJson(winAuthPath, null);
  if (!winAuth) {
    const hasCmd = desktopCmdExists(home, 'Codexログイン（ダブルクリック）.cmd');
    return {
      id: 'codex',
      status: 'fail',
      detail: 'auth.json 不在',
      remedy: hasCmd ? 'Codexログイン（ダブルクリック）.cmd' : 'codex login',
    };
  }

  return {
    id: 'codex',
    status: 'ok',
    detail: 'Codex ログイン済み',
    remedy: 'codex login status',
  };
}

export async function probeAiLanes({
  home = loginHome(),
  now = Date.now(),
} = {}) {
  const laneHealth = readJson(path.join(home, '.claude', 'lane-health.json'), null);
  if (!laneHealth?.lanes) {
    return [{
      id: 'ai-lanes',
      status: 'unknown',
      detail: 'lane-health.json 未作成',
      remedy: 'node tools/lane-doctor.mjs --probe',
    }];
  }

  const results = [];
  const STALE_MS = 24 * 3600_000;

  for (const [provider, state] of Object.entries(laneHealth.lanes)) {
    if (provider === 'gemini-cli') continue;
    const lastOkAt = Date.parse(state.lastProbeOkAt || state.probedAt || 0) || 0;
    const isStale = !lastOkAt || (now - lastOkAt > STALE_MS);

    if (isStale) {
      results.push({
        id: `ai-lane:${provider}`,
        status: 'stale',
        detail: `${provider} 最終実測から24時間超過`,
        remedy: 'node tools/lane-doctor.mjs --probe',
      });
    } else if (state.alive === false) {
      results.push({
        id: `ai-lane:${provider}`,
        status: 'fail',
        detail: `${provider} 停止 (${state.reason || '理由不明'})`,
        remedy: 'node tools/lane-doctor.mjs --probe',
      });
    } else {
      results.push({
        id: `ai-lane:${provider}`,
        status: 'ok',
        detail: `${provider} 稼働`,
        remedy: 'node tools/lane-doctor.mjs',
      });
    }
  }

  return results;
}

export async function probeBrowserSessions({
  home = loginHome(),
  now = Date.now(),
} = {}) {
  const browserDir = path.join(home, '.claude');
  const results = [];

  const findSessionFiles = (dir) => {
    let files = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findSessionFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('-session-state.json')) {
          files.push(fullPath);
        }
      }
    } catch {}
    return files;
  };

  const files = findSessionFiles(browserDir);
  const SIX_HOURS_MS = 6 * 3600_000;

  const SERVICE_REMEDY_MAP = {
    'booking': 'デスクトップの Booking.comログイン窓を開く（ダブルクリック）.cmd をダブルクリック（専用Chrome・CDP 9226 で1回ログイン）',
    'beds24': 'node tools/browser/beds24-keepalive.mjs --ping で状態確認し、reCAPTCHA が出ていれば CDP 9222 の窓で1回ログイン',
    'airbnb': 'CDP 9223 の窓で1回ログイン',
    'nomu-gmail': 'node tools/browser/nomu-gmail-keepalive.mjs --ensure で窓を起動し1回ログイン',
  };

  for (const file of files) {
    const serviceName = path.basename(file, '-session-state.json');
    const state = readJson(file, null);
    if (!state) continue;

    const checkedAt = Date.parse(state.checkedAt || 0) || 0;
    const isStale = !checkedAt || (now - checkedAt > SIX_HOURS_MS);
    const loggedIn = state.loggedIn === true;
    const needsHumanSince = state.needsHumanSince || null;

    let daysText = '';
    if (needsHumanSince) {
      const days = Math.max(0, Math.floor((now - Date.parse(needsHumanSince)) / 86400000));
      daysText = `${days}日`;
    }

    const relPath = path.relative(home, file).replace(/\\/g, '/');
    const remedy = SERVICE_REMEDY_MAP[serviceName] ?? `~/${relPath} の reason を確認し、該当の keepalive の窓で1回ログイン`;

    if (!loggedIn || state.needsHuman) {
      results.push({
        id: `browser:${serviceName}`,
        status: 'fail',
        detail: `${serviceName} 未ログイン${daysText ? ` (${daysText})` : ''}`,
        since: needsHumanSince,
        remedy,
      });
    } else if (isStale) {
      results.push({
        id: `browser:${serviceName}`,
        status: 'stale',
        detail: `${serviceName} 点検から6時間超過`,
        remedy,
      });
    } else {
      results.push({
        id: `browser:${serviceName}`,
        status: 'ok',
        detail: `${serviceName} ログイン維持`,
        remedy: 'keepalive 正常',
      });
    }
  }

  return results;
}

// ---------------------------------------------------------
// Main Execution
// ---------------------------------------------------------

export async function runLoginHealth({
  home = loginHome(),
  fix = false,
  notify = false,
  fleet = false,
  sessionStart = false,
  json = false,
  execImpl = spawnSync,
  fetchImpl = fetch,
  now = Date.now(),
  io = {},
} = {}) {
  const healthFile = path.join(home, '.claude', 'login-health.json');

  // Quick mode for session-start
  if (sessionStart) {
    return loginHealthSessionStart({ home });
  }

  const results = [];

  // Run probes
  const ghRes = await probeGithub({ home, execImpl, fetchImpl, fix });
  results.push(ghRes);

  const claudeRes = await probeClaude({ home, execImpl });
  results.push(claudeRes);

  const codexRes = await probeCodex({ home, execImpl, now });
  results.push(codexRes);

  const aiRes = await probeAiLanes({ home, now });
  results.push(...aiRes);

  const browserRes = await probeBrowserSessions({ home, now });
  results.push(...browserRes);

  const host = os.hostname();
  const outputObj = {
    checkedAt: new Date(now).toISOString(),
    host,
    results,
  };

  // Save to ~/.claude/login-health.json
  writeAtomicJson(healthFile, outputObj);

  // Notify if requested
  if (notify) {
    const addFn = io.addKimInboxItem ?? addKimInboxItem;
    const listFn = io.listKimInboxItems ?? listKimInboxItems;
    const markSeenFn = io.markKimInboxSeen ?? markKimInboxSeen;

    for (const res of results) {
      const dedupeKey = `login-health:${host}:${res.id}`;
      if (res.status === 'fail' || res.status === 'stale' || res.status === 'warn') {
        const text = `🔑 ログイン切れ検知: ${res.id}\n状態: ${res.detail}\n直し方: ${res.remedy}`;
        await addFn(home, {
          kind: 'ask',
          source: 'login-health',
          text,
          dedupeKey,
        });
      } else if (res.status === 'ok') {
        // Close if open
        try {
          const openItems = listFn(home, { status: 'open' });
          const match = openItems.find(item => item.dedupeKey === dedupeKey);
          if (match) {
            markSeenFn(home, match.id);
          }
        } catch {}
      }
    }

    // Handle fleet notification
    if (fleet && isKimOperated(home)) {
      try {
        const fleetUrl = process.env.FLEET_SHEET_URL;
        if (fleetUrl) {
          const fleetResp = await fetchImpl(fleetUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'fleet-beacon-list' }),
            signal: AbortSignal.timeout(15000),
          });
          if (fleetResp.ok) {
            const data = await fleetResp.json();
            const beacons = data?.beacons || [];
            const failingPcs = [];
            for (const b of beacons) {
              const reportedAt = Date.parse(b.reportedAt || 0) || 0;
              const isStalePc = !reportedAt || (now - reportedAt > 48 * 3600_000);
              const loginFails = (b.steps || []).filter(s => s.id?.startsWith('login:') && s.status === 'fail').map(s => s.id);
              if (isStalePc || loginFails.length > 0) {
                failingPcs.push(`${b.label || b.hostname} (${isStalePc ? '48h超未報告' : loginFails.join(',')})`);
              }
            }
            if (failingPcs.length > 0) {
              await addFn(home, {
                kind: 'ask',
                source: 'login-health-fleet',
                text: `🔑 全社PCログイン要約:\n${failingPcs.join('\n')}`,
                dedupeKey: 'login-health:fleet',
              });
            }
          }
        }
      } catch {}
    }
  }

  if (json) {
    console.log(JSON.stringify(outputObj, null, 2));
    return outputObj;
  }

  // Format table output
  const lines = [
    '| 対象 | 状態 | 直し方 |',
    '| --- | --- | --- |',
  ];
  for (const r of results) {
    const badge = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : r.status === 'stale' ? '⏳' : '❌';
    lines.push(`| ${r.id} | ${badge} ${r.detail} | ${r.remedy} |`);
  }

  const tableText = lines.join('\n');
  console.log(tableText);
  return outputObj;
}

export function loginHealthSessionStart({ home = loginHome() } = {}) {
  const healthFile = path.join(home, '.claude', 'login-health.json');
  const data = readJson(healthFile, null);
  if (!data?.results) return '';

  const fails = data.results.filter(r => r.status === 'fail' || r.status === 'stale');
  if (!fails.length) return '';

  const itemsText = fails.map(f => {
    let name = f.id.replace(/^(browser:|ai-lane:)/, '');
    if (f.since) {
      const days = Math.max(0, Math.floor((Date.now() - Date.parse(f.since)) / 86400000));
      name += `(${days}日)`;
    } else if (f.detail.includes('wsl_hung')) {
      name += '(wsl_hung)';
    }
    return name;
  }).join('・');

  const line = `🔑 ログイン切れ: ${itemsText} → node tools/login-health.mjs で直し方`;
  console.log(line);
  return line;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const fix = argv.includes('--fix');
  const notify = argv.includes('--notify');
  const fleet = argv.includes('--fleet');
  const sessionStart = argv.includes('--session-start');
  const json = argv.includes('--json');

  return runLoginHealth({ fix, notify, fleet, sessionStart, json, ...deps });
}

if (isEntry(import.meta.url)) {
  await main();
}
