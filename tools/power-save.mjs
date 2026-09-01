import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isEntry } from './is-entry.mjs';

const CONFIG_DIR = path.join(os.homedir(), '.claude');
const CONFIG_FILE = path.join(CONFIG_DIR, 'cost-reporter.env');
const BACKUP_FILE = path.join(CONFIG_DIR, 'power-save-backup.json');

const CPU_MAX = { subgroup: 'SUB_PROCESSOR', setting: 'PROCTHROTTLEMAX', default: 100 };
const CPU_MIN = { subgroup: 'SUB_PROCESSOR', setting: 'PROCTHROTTLEMIN', default: 5 };
const COOL_POLICY = { subgroup: 'SUB_PROCESSOR', setting: 'SYSCOOLPOL', default: 1 };
const VIDEO_IDLE = { subgroup: 'SUB_VIDEO', setting: 'VIDEOIDLE', default: 600 };

let discordWebhook = '';
let reporterLabel = '';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.substring(0, eq).trim();
            const value = trimmed.substring(eq + 1).trim();
            if (key === 'DISCORD_COST_WEBHOOK' || key === 'COST_WEBHOOK') {
              if (!discordWebhook) discordWebhook = value;
            } else if (key === 'REPORTER_LABEL') {
              reporterLabel = value;
            }
          }
        }
      }
    }
    if (!reporterLabel) reporterLabel = os.hostname();
  } catch (e) {
    // 設定読み込み失敗は無視
  }
}

export function parsePowercfgQuery(text) {
  const lines = text.split(/\r?\n/);
  let ac = null;
  let dc = null;
  let foundAc = false;
  let foundDc = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/AC/i.test(line) && !foundAc) {
      const m = line.match(/0x([0-9a-fA-F]+)/);
      if (m) {
        ac = parseInt(m[1], 16);
        foundAc = true;
      }
    } else if (/DC/i.test(line) && !foundDc) {
      const m = line.match(/0x([0-9a-fA-F]+)/);
      if (m) {
        dc = parseInt(m[1], 16);
        foundDc = true;
      }
    }
  }
  return { ac, dc };
}

export function buildPlan({ max, videoOff }) {
  const maxVal = Math.max(0, Math.min(100, parseInt(max, 10) || 80));
  const plan = [
    { name: 'PROCTHROTTLEMAX', subgroup: CPU_MAX.subgroup, setting: CPU_MAX.setting, value: maxVal },
    { name: 'PROCTHROTTLEMIN', subgroup: CPU_MIN.subgroup, setting: CPU_MIN.setting, value: CPU_MIN.default },
    { name: 'SYSCOOLPOL', subgroup: COOL_POLICY.subgroup, setting: COOL_POLICY.setting, value: 0 }
  ];
  if (videoOff !== undefined && videoOff !== null) {
    plan.push({ name: 'VIDEOIDLE', subgroup: VIDEO_IDLE.subgroup, setting: VIDEO_IDLE.setting, value: videoOff });
  }
  return plan;
}

function runPowercfg(args) {
  try {
    const stdout = execFileSync('powercfg', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { success: true, stdout, stderr: '' };
  } catch (err) {
    return { success: false, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function getCurrentValues() {
  const result = {};
  const items = [
    { name: 'PROCTHROTTLEMAX', subgroup: 'SUB_PROCESSOR', setting: 'PROCTHROTTLEMAX' },
    { name: 'PROCTHROTTLEMIN', subgroup: 'SUB_PROCESSOR', setting: 'PROCTHROTTLEMIN' },
    { name: 'SYSCOOLPOL', subgroup: 'SUB_PROCESSOR', setting: 'SYSCOOLPOL' },
    { name: 'VIDEOIDLE', subgroup: 'SUB_VIDEO', setting: 'VIDEOIDLE' }
  ];

  for (const item of items) {
    const res = runPowercfg(['/query', 'SCHEME_CURRENT', item.subgroup, item.setting]);
    if (res.success) {
      result[item.name] = parsePowercfgQuery(res.stdout);
    } else {
      result[item.name] = { ac: null, dc: null };
    }
  }
  return result;
}

function formatValue(name, value) {
  if (value === null || value === undefined) return '取得失敗';
  if (name === 'SYSCOOLPOL') {
    return value === 0 ? 'パッシブ' : 'アクティブ';
  }
  if (name === 'VIDEOIDLE') {
    return `${value}秒`;
  }
  return `${value}%`;
}

export function formatStatus(values, target) {
  const lines = [
    `CPU電力上限(PROCTHROTTLEMAX): AC ${formatValue('PROCTHROTTLEMAX', values.PROCTHROTTLEMAX?.ac)} / DC ${formatValue('PROCTHROTTLEMAX', values.PROCTHROTTLEMAX?.dc)}`,
    `CPU下限(PROCTHROTTLEMIN):     AC ${formatValue('PROCTHROTTLEMIN', values.PROCTHROTTLEMIN?.ac)} / DC ${formatValue('PROCTHROTTLEMIN', values.PROCTHROTTLEMIN?.dc)}`,
    `冷却ポリシー(SYSCOOLPOL):     AC ${formatValue('SYSCOOLPOL', values.SYSCOOLPOL?.ac)} / DC ${formatValue('SYSCOOLPOL', values.SYSCOOLPOL?.dc)}`,
    `画面OFF(VIDEOIDLE):           AC ${formatValue('VIDEOIDLE', values.VIDEOIDLE?.ac)} / DC ${formatValue('VIDEOIDLE', values.VIDEOIDLE?.dc)}`
  ];
  if (target !== undefined) {
    lines.push(`推定効果: 上限を${target}%にすると このPCの高負荷時消費電力は概ね15〜25%低下します`);
  }
  return lines.join('\n');
}

export function formatPost({ label, hostname, before, after, failures }) {
  const lines = [`⚡ 省電力設定 [${label}]`];
  
  const items = [
    { name: 'PROCTHROTTLEMAX', display: 'CPU電力上限' },
    { name: 'PROCTHROTTLEMIN', display: 'CPU下限' },
    { name: 'SYSCOOLPOL', display: '冷却ポリシー' },
    { name: 'VIDEOIDLE', display: '画面OFF' }
  ];

  for (const item of items) {
    const b = before[item.name];
    const a = after[item.name];
    const failed = failures[item.name] || false;
    let line = `${item.display}: `;
    if (failed) {
      line += '⚠️ 設定失敗';
    } else {
      line += `${formatValue(item.name, b?.ac)}/${formatValue(item.name, b?.dc)} → ${formatValue(item.name, a?.ac)}/${formatValue(item.name, a?.dc)}`;
    }
    lines.push(line);
  }

  lines.push(`🖥 hostname=${hostname}`);
  return lines.join('\n');
}

async function sendDiscord(msg) {
  if (!discordWebhook) {
    console.log('Discord通知: webhook未設定のためスキップ');
    return false;
  }

  try {
    const response = await fetch(discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ content: msg }),
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) {
      console.log('Discord通知: 送信しました');
      return true;
    } else {
      console.log('Discord通知: 失敗しました');
      return false;
    }
  } catch (err) {
    console.log('Discord通知: 失敗しました');
    return false;
  }
}

function loadBackup() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    }
  } catch (e) {
    // 破損は無視
  }
  return null;
}

function saveBackup(scheme, values) {
  const backup = {
    savedAt: new Date().toISOString(),
    scheme: 'SCHEME_CURRENT',
    values: {
      PROCTHROTTLEMAX: { ac: values.PROCTHROTTLEMAX?.ac, dc: values.PROCTHROTTLEMAX?.dc },
      PROCTHROTTLEMIN: { ac: values.PROCTHROTTLEMIN?.ac, dc: values.PROCTHROTTLEMIN?.dc },
      SYSCOOLPOL: { ac: values.SYSCOOLPOL?.ac, dc: values.SYSCOOLPOL?.dc },
      VIDEOIDLE: { ac: values.VIDEOIDLE?.ac, dc: values.VIDEOIDLE?.dc }
    }
  };
  try {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function applySetting(setting, value, setAcValue) {
  let failures = [];
  try {
    const args = [setAcValue ? '/setacvalueindex' : '/setdcvalueindex', 'SCHEME_CURRENT', setting.subgroup, setting.setting, value.toString()];
    const res = runPowercfg(args);
    if (!res.success) {
      failures.push({ setting, ac: setAcValue, error: res.stderr });
    }
  } catch (err) {
    failures.push({ setting, ac: setAcValue, error: err.message });
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  let isStatus = false;
  let isApply = false;
  let isRestore = false;
  let isJson = false;
  let isPost = false;
  let maxVal = 80;
  let videoOff = null;

  if (args.includes('--help')) {
    console.log(`使用方法:
  node power-save.mjs --status              # 現在値を表示
  node power-save.mjs --apply [--max 80] [--video-off <秒>]  # 適用
  node power-save.mjs --restore             # バックアップから復元
  node power-save.mjs --json                # JSON出力（併用）
  node power-save.mjs --post                # Discord投稿（併用）
  node power-save.mjs --help

--video-off <秒>: 画面OFFまでの時間を設定します。
  リモート操作（VNC/AnyDesk等）で黒画面になる場合があるため、既定では変更しません。
  明示的に指定した場合のみ適用されます。`);
    return;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--status') { isStatus = true; }
    else if (arg === '--apply') { isApply = true; }
    else if (arg === '--restore') { isRestore = true; }
    else if (arg === '--json') { isJson = true; }
    else if (arg === '--post') { isPost = true; }
    else if (arg === '--max') {
      if (i + 1 < args.length) {
        maxVal = parseInt(args[++i], 10);
      }
    } else if (arg === '--video-off') {
      if (i + 1 < args.length) {
        videoOff = parseInt(args[++i], 10);
      }
    } else {
      console.error('不明な引数: ' + arg);
      process.exitCode = 2;
      return;
    }
  }

  if (isApply && isRestore) {
    console.error('--apply と --restore は同時に指定できません');
    process.exitCode = 2;
    return;
  }

  if (process.platform !== 'win32') {
    console.error('このツールはWindows専用です');
    process.exitCode = 1;
    return;
  }

  loadConfig();

  const currentValues = getCurrentValues();

  if (isStatus) {
    const output = formatStatus(currentValues, maxVal);
    if (isJson) {
      console.log(JSON.stringify({ status: 'ok', values: currentValues }, null, 2));
    } else {
      console.log(output);
    }
    if (isPost) {
      const msg = `⚡ 省電力設定 [${reporterLabel}]\n${output}\n🖥 hostname=${os.hostname()}`;
      await sendDiscord(msg);
    }
    return;
  }

  if (isRestore) {
    const backup = loadBackup();
    const plan = [];
    for (const item of [CPU_MAX, CPU_MIN, COOL_POLICY, VIDEO_IDLE]) {
      const acValue = backup ? (backup.values[item.setting]?.ac ?? item.default) : item.default;
      const dcValue = backup ? (backup.values[item.setting]?.dc ?? null) : null;
      plan.push({ subgroup: item.subgroup, setting: item.setting, acValue, dcValue });
    }
    const failures = {};
    for (const item of plan) {
      const acFailures = applySetting({ subgroup: item.subgroup, setting: item.setting }, item.acValue, true);
      let dcFailures = [];
      if (item.dcValue !== null && item.dcValue !== undefined) {
        dcFailures = applySetting({ subgroup: item.subgroup, setting: item.setting }, item.dcValue, false);
      }
      if (acFailures.length > 0 || dcFailures.length > 0) {
        failures[item.setting] = true;
      }
    }
    runPowercfg(['/setactive', 'SCHEME_CURRENT']);
    const afterValues = getCurrentValues();
    const msg = formatPost({ label: reporterLabel, hostname: os.hostname(), before: currentValues, after: afterValues, failures });
    if (isJson) {
      console.log(JSON.stringify({ status: 'restored', values: afterValues, failures }, null, 2));
    } else {
      console.log(`リストア完了: ${backup ? 'バックアップから復元' : 'デフォルト値に復元'}`);
    }
    if (isPost) await sendDiscord(msg);
    return;
  }

  if (isApply) {
    const backup = loadBackup();
    if (!backup) {
      saveBackup('SCHEME_CURRENT', currentValues);
    }
    const plan = buildPlan({ max: maxVal, videoOff });
    const failures = {};
    let changed = false;

    for (const item of plan) {
      const acFailures = applySetting(item, item.value, true);
      const dcFailures = applySetting(item, item.value, false);
      const dcFailureOnly = dcFailures.length > 0 && item.name === 'PROCTHROTTLEMIN';
      if (acFailures.length > 0) {
        failures[item.name] = true;
      } else if (dcFailures.length > 0 && !dcFailureOnly) {
        failures[item.name] = true;
      }
      if (acFailures.length === 0) {
        const beforeValue = currentValues[item.name]?.ac;
        if (beforeValue !== null && beforeValue !== undefined && beforeValue !== item.value) {
          changed = true;
        }
      }
    }

    runPowercfg(['/setactive', 'SCHEME_CURRENT']);
    const afterValues = getCurrentValues();

    if (!changed) {
      const msg = `⚡ 省電力設定 [${reporterLabel}] (変更なし)\n🖥 hostname=${os.hostname()}`;
      if (isJson) {
        console.log(JSON.stringify({ status: 'unchanged', values: afterValues }, null, 2));
      } else {
        console.log('変更なし: 既に目標値に設定されています');
      }
      if (isPost) await sendDiscord(msg);
      return;
    }

    const msg = formatPost({ label: reporterLabel, hostname: os.hostname(), before: currentValues, after: afterValues, failures });
    if (isJson) {
      console.log(JSON.stringify({ status: 'applied', values: afterValues, failures }, null, 2));
    } else {
      console.log('省電力設定を適用しました');
    }
    if (isPost) await sendDiscord(msg);
    return;
  }

  // 引数無し
  console.error('引数が必要です: --status, --apply, --restore');
  process.exitCode = 2;
}

if (isEntry(import.meta.url)) {
  main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
}
