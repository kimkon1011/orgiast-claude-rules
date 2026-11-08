#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { isEntry } from './is-entry.mjs';
import { dialogMetrics, readJson, writeJson } from './lib/stuck-dialog-state.mjs';
import { listScheduledTasks } from './lib/scheduled-task.mjs';
import { expectationLog, logIsStale } from './lib/health-signals.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { providerCooldownMs } from './codex-cooldown.mjs';
import { detectFailedJob } from './stall-sweeper.mjs';

const row = (kind, symptom, evidence, cause, nextAction, extra = {}) => ({ kind, symptom, evidence, cause, nextAction, ...extra });
export function probePort({ host = '127.0.0.1', port }) {
  if (!['127.0.0.1','::1','localhost'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error('ローカルサーバー設定の host/port が不正'));
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = error => { socket.destroy(); resolve({ listening: !error, error }); };
    socket.setTimeout(500, () => finish('ETIMEDOUT'));
    socket.once('connect', () => finish(null)); socket.once('error', e => finish(e.code));
  });
}
function jsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
export async function scan({ home = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir(), now = Date.now(), platform = process.platform,
  expectations = readJson(new URL('./nightly-health-expectations.json',import.meta.url), []), taskQuery = listScheduledTasks, probe = probePort,
  label = resolveFleetLabel(home), save = false } = {}) {
  now = Number(now);
  const rows = [], sources = [], dir = path.join(home,'.claude');
  const source = async (name, fn) => {
    try { await fn(); sources.push({ name, ok: true }); }
    catch(e) { rows.push(row('scan_error','診断できない項目',`${name}: ${e.message}`,'設定破損・権限不足・照会失敗','nightly-health-remediate で照会失敗を調査')); sources.push({name,ok:false}); }
  };
  await source('stuck-dialog', () => {
    if (platform !== 'win32') return;
    const metrics = dialogMetrics(home,now);
    const expectation = expectations.find(e => e.task === 'OrgiastStuckDialogWatch');
    if (metrics.stuckDialogs24h > 0) rows.push(row('stuck_dialog','操作を止める画面',`24時間=${metrics.stuckDialogs24h}件; ${path.join(dir,'logs','stuck-dialog')}`,'拡張子なし起動・クラッシュ。直前候補は因果関係未確定','監視が終了を試行。nightly-health-remediate で証拠から起動元を修復',{expectation}));
    if (!metrics.stuckDialogWatcherOk) rows.push(row('watcher_dead','画面監視が停止・異常',`heartbeat=${metrics.stuckDialogWatcherAt || '未作成'}`,'未登録・無効化・照会/終了失敗','監視タスクを再登録・開始して heartbeat を確認',{expectation}));
  });
  await source('scheduled-tasks', async () => {
    if (platform !== 'win32') return;
    const tasks = (await taskQuery()).filter(t => /(?:^|\\)Orgiast/.test(t.taskName));
    for (const failure of detectFailedJob(tasks, now)) rows.push(row('task_failed',failure.title,`${failure.reason}; ${failure.eventTime}; ${failure.location}`,'前回実行が異常終了','nightly-health-remediate でログと終了コードを調査',{expectation: expectations.find(e => failure.taskName.endsWith(e.task || '\0'))}));
    for (const t of tasks) {
      const exp = expectations.find(e => t.taskName.endsWith(e.task || '\0'));
      const cycle = t.cycleMinutes || (exp?.maxAgeHours ? exp.maxAgeHours*60 : null);
      const futureFirst = t.neverRun && Date.parse(t.nextRunTime) > now;
      const overdueNext = Date.parse(t.nextRunTime) > Date.UTC(2000,0,1) && now - Date.parse(t.nextRunTime) > 600000;
      if (!futureFirst && !t.running && (t.state === 'Disabled' || overdueNext || (t.neverRun && cycle) || (cycle && now - Date.parse(t.t) > cycle * 60000 * 2))) rows.push(row('task_missed','定期タスクが未実行',`${t.taskName}: state=${t.state}, last=${t.t}, next=${t.nextRunTime}, cycle=${cycle ?? '不明'}分`,'無効化・スリープ・起動拒否','nightly-health-remediate で登録と稼働条件を確認',{expectation:exp}));
    }
  });
  for (const exp of expectations.filter(e => !e.ignore && (!e.fleetLabel || e.fleetLabel === label) && (!e.platform || e.platform === platform))) {
    await source(`log:${exp.label}`, () => {
      const log = expectationLog(home,exp);
      if (!log || logIsStale(log.mtimeMs,exp.maxAgeHours,now)) rows.push(row('log_stale',`${exp.label}のログ停止`,`${log?.file || exp.log || exp.pattern}: 更新=${log ? new Date(log.mtimeMs).toISOString() : '未作成'}; 期待=${exp.maxAgeHours}時間以内`,'未実行・起動直後の停止・出力先変更','nightly-health の既存ログ修復経路で確認',{expectation:exp}));
    });
  }
  await source('heartbeats', () => {
    const root=path.join(dir,'heartbeat');
    for (const file of fs.existsSync(root) ? fs.readdirSync(root).filter(f=>f.endsWith('.json')) : []) {
      if (file === 'stuck-dialog-watch.json') continue;
      const hb=readJson(path.join(root,file));
      const stamp=hb.finishedAt || hb.startedAt;
      if (hb.cycleMinutes > 0 && (!Number.isFinite(Date.parse(stamp)) || now-Date.parse(stamp)>hb.cycleMinutes*120000 || hb.ok===false)) rows.push(row('heartbeat_stale',`${hb.job || file}の生存報告停止`,`${file}: ${stamp || '日時なし'}; ok=${hb.ok}; 周期=${hb.cycleMinutes}分`,'処理停止・前回失敗','nightly-health-remediate でジョブを調査'));
    }
  });
  await source('local-servers', async () => {
    const config=readJson(path.join(dir,'stall-scan-servers.json'),readJson(new URL('./stall-scan-servers.json',import.meta.url)));
    for (const server of config.servers.filter(s=>!s.fleetLabel || s.fleetLabel===label)) {
      const result=await probe(server);
      if (!result.listening) rows.push(row('server_down',`${server.name}へ接続できない`,`${server.host || '127.0.0.1'}:${server.port} ${result.error}`,'サーバー停止・ポート設定違い',server.repairHint || 'nightly-health-remediate で起動設定とログを調査'));
    }
  });
  await source('provider-cooldowns', () => {
    const file = path.join(dir,'provider-cooldown.json');
    for (const [provider, state] of Object.entries(readJson(file))) {
      if (providerCooldownMs(provider, now, file) <= 0) continue;
      rows.push(row('cooldown',`${provider}の利用待ち`,`${file}: until=${new Date(Number(state.until)).toISOString()}; reason=${state.reason || 'limit'}`,'利用枠の上限','既存 executor-gate が期限まで保留し、利用可能な別レーンへ回す',{remediate:false}));
    }
  });
  await source('stalled-sessions', () => {
    const ledger=readJson(path.join(dir,'stalled-session-resume.json'));
    const closed=readJson(path.join(dir,'session-closed-ledger.json'),{sessions:{}});
    for (const [id,s] of Object.entries(ledger.sessions || {})) if (!closed.sessions?.[id] && (s.noProgress>0 || s.attempts?.at(-1)?.outcome==='error')) rows.push(row('session_stalled','再開しても進まない会話',`session=${id}; noProgress=${s.noProgress}; last=${JSON.stringify(s.attempts?.at(-1) || {})}`,'再開先の失敗・会話の進展なし','stalled-session-resume の台帳と停止条件を確認'));
    const file=path.join(dir,'stall-sweeper-log.jsonl'), latest=new Map();
    for (const s of jsonLines(file)) latest.set(s.id,s);
    for (const s of latest.values()) if (s.kind==='stalled_session' && (s.result==='失敗' || (s.result==='実行中' && now-Date.parse(s.t)>3600000))) rows.push(row('session_stalled','停滞会話の処理が未完了',`${file}: ${s.id} ${s.t} ${s.result} ${s.error || ''}`,'再開失敗・処理中断','stall-sweeper が次回の巡回で再確認'));
  });
  const result={ at:new Date(now).toISOString(), rows, sources };
  if(save) writeJson(path.join(dir,'stall-scan.json'),result);
  return result;
}
export function asAnomalies(result) {
  return result.rows.filter(r=>r.remediate!==false && r.kind!=='log_stale').map(r=>({type:r.kind,label:r.symptom,message:`${r.evidence} / 原因候補: ${r.cause} / 次: ${r.nextAction}`,expectation:r.expectation || null}));
}
export function sessionSummary(home, now=Date.now()) {
  try {
    const cached=readJson(path.join(home,'.claude','stall-scan.json'));
    if (!cached.rows?.length) return '';
    const age=now-Date.parse(cached.at);
    return `停滞診断${age>30*3600000?'（古い結果・再確認が必要）':''}: ${cached.rows.length}件 / ${cached.rows.slice(0,3).map(r=>r.symptom).join('、')}。node tools/stall-scan.mjs で根拠を確認。`;
  } catch { return '停滞診断: 保存結果を読めません。node tools/stall-scan.mjs で再確認。'; }
}
export function formatTable(result) {
  const cell=s=>String(s).replace(/[\r\n|]/g,' ');
  return ['| 症状 | 根拠(実データ) | 原因候補 | 自動で次にやること |','| --- | --- | --- | --- |',...result.rows.map(r=>`| ${[r.symptom,r.evidence,r.cause,r.nextAction].map(cell).join(' | ')} |`)].join('\n');
}
if(isEntry(import.meta.url)) scan({save:true}).then(r=>console.log(process.argv.includes('--json')?JSON.stringify(r,null,2):formatTable(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
