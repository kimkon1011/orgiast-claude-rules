import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHandoff } from './auto-session.mjs';
import { applyAutoHeal, collectFindings, emptyOutputReason, parseRateLimitsFromText, readCodexUsedPercent, upsertFixTasks } from './delegation-health-check.mjs';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const homes = [];
function home() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-health-')); homes.push(dir); fs.mkdirSync(path.join(dir, '.claude')); return dir; }
function write(dir, name, value) { fs.writeFileSync(path.join(dir, '.claude', name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); }
function row(value) { return `${JSON.stringify(value)}\n`; }
function handoff() { return '<!-- NEXT-SESSION v1 -->\n## 対象\nテスト\n## 残TODO\n\n1. 既存TODO\n\n## 完了条件\n完了\n'; }
test.after(() => homes.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

test('偽陽性を検出し cooldown を解除して残TODO先頭へ起票する', () => {
  const dir = home();
  write(dir, 'codex-limit-history.jsonl', row({ t: '2026-09-09T10:00:00Z', reason: 'usage_limit' }) + row({ t: '2026-09-09T11:00:00Z', reason: 'usage_limit' }));
  write(dir, 'provider-cooldown.json', { codex: { until: NOW.getTime() + 1000, reason: 'usage_limit' }, glm: { until: 1 } });
  write(dir, 'next-session.md', handoff());
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: { usedPercent: 1, windowMinutes: 300, resetsAt: 99 } });
  assert.equal(findings[0].id, 'codex_false_usage_limit');
  assert.match(findings[0].evidence.join(' '), /2件.*used_percent 1.*window 300.*resets_at 99/);
  applyAutoHeal({ home: dir, findings, now: NOW });
  assert.equal(readCooldown(dir).codex, undefined);
  upsertFixTasks({ home: dir, findings, now: NOW, todayStr: '2026-09-09' });
  const parsed = parseHandoff(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'));
  assert.match(parsed.todos[0], /^\[delegation-health:codex_false_usage_limit\]/);
  assert.match(parsed.todos[1], /^既存TODO/);
});

function readCooldown(dir) { return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'provider-cooldown.json'), 'utf8')); }

test('同じマーカーは3日未満なら二重起票せず、3日後は再起票する', () => {
  const dir = home(), finding = { id: 'codex_empty_output', severity: 'medium', title: 'zero', evidence: ['1件'], fixTask: '修正する' };
  write(dir, 'next-session.md', handoff().replace('1. 既存TODO', '1. [delegation-health:codex_empty_output] 古い — (起票 2026-09-08)\n2. 既存TODO'));
  assert.equal(upsertFixTasks({ home: dir, findings: [finding], now: NOW, todayStr: '2026-09-09' }), false);
  assert.equal((fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8').match(/\[delegation-health:codex_empty_output\]/g) || []).length, 1);
  assert.equal(upsertFixTasks({ home: dir, findings: [finding], now: NOW, todayStr: '2026-09-11' }), true);
  const md = fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8');
  assert.equal((md.match(/\[delegation-health:codex_empty_output\]/g) || []).length, 1);
  assert.match(parseHandoff(md).todos[0], /起票 2026-09-11/);
});

test('140日先の cooldown を検出して削除する', () => {
  const dir = home(), until = NOW.getTime() + 140 * 86_400_000;
  write(dir, 'provider-cooldown.json', { glm: { until, reason: 'bad parse' } });
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(findings[0].id, 'cooldown_too_far');
  applyAutoHeal({ home: dir, findings, now: NOW });
  assert.equal(readCooldown(dir).glm, undefined);
});

test('claude-fallback の件数と reason 上位を evidence に含める', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'claude-fallback', reason: 'timeout' }) + row({ t: '2026-09-09T10:01:00Z', provider: 'claude-fallback', reason: 'timeout' }) + row({ t: '2026-09-09T10:02:00Z', provider: 'claude-fallback', reason: 'auth' }));
  const finding = collectFindings({ home: dir, now: NOW, codexUsedPercent: null })[0];
  assert.equal(finding.id, 'unattended_claude_fallback');
  assert.deepEqual(finding.evidence, ['3件', 'timeout(2件)', 'auth(1件)']);
});

test('timeout で打ち切られた出力ゼロは codex_empty_output に数えない', () => {
  const dir = home();
  for (const details of [{ secs: 404.8, timedOut: true }, { secs: 600 }]) {
    write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, ...details }));
    assert.equal(collectFindings({ home: dir, now: NOW, codexUsedPercent: null })[0].id, 'healthy');
  }
});

test('打ち切りでない出力ゼロは原因付きで起票する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 5, timedOut: false, status: 1 }));
  const finding = collectFindings({ home: dir, now: NOW, codexUsedPercent: null })[0];
  assert.equal(finding.id, 'codex_empty_output');
  assert.deepEqual(finding.evidence, ['1件', 'exit_1(1件)']);
});

test('emptyOutputReason は timeout・終了コード・原因不明を分類する', () => {
  assert.equal(emptyOutputReason({ timedOut: true }), 'timeout');
  assert.equal(emptyOutputReason({ secs: 600 }), 'timeout');
  assert.equal(emptyOutputReason({ status: 1 }), 'exit_1');
  assert.equal(emptyOutputReason({ secs: 0 }), 'no_output');
  assert.equal(emptyOutputReason({ secs: 299 }), 'no_output');
  assert.equal(emptyOutputReason({ secs: 300 }), 'timeout');
  assert.equal(emptyOutputReason({ secs: 600, timedOut: false, status: 1 }), 'exit_1');
  assert.equal(emptyOutputReason({ status: 1, stderrTail: 'failed to lookup address information' }), 'infra_transient');
  assert.equal(emptyOutputReason({ status: 1, stderrTail: 'Not inside a trusted directory and --skip-git-repo-check was not specified.' }), 'untrusted_cwd');
  assert.equal(emptyOutputReason({ status: 1 }), 'exit_1');
  // 起動失敗は「出力ゼロ」ではなく「そもそも走っていない」。exit_3 に埋もれさせない。
  assert.equal(emptyOutputReason({ launched: false, status: 3, secs: 0 }), 'launch_failed');
  assert.equal(emptyOutputReason({ launched: true, status: 3, secs: 0 }), 'exit_3');
});

test('emptyOutputReason は spawn 自体の失敗を spawn_failed に分類する', () => {
  // 子プロセスの起動失敗は exitCode が null で残る(child.on('error') 経路)。実障害と混ぜない。
  assert.equal(emptyOutputReason({ launched: true, status: 'error', exitCode: null, secs: 0.15 }), 'spawn_failed');
  assert.equal(emptyOutputReason({ launched: true, status: null, secs: 0.15 }), 'spawn_failed');
  // 数値 exit の本物の失敗は従来どおり exit_N のまま。対照群を張らないと spawn_failed の張りすぎに気づけない。
  assert.equal(emptyOutputReason({ launched: true, status: 1, exitCode: 1, secs: 0.15 }), 'exit_1');
  // 実台帳は status が文字列 'error'・exitCode が数値なので、この形でも spawn_failed にしない。
  assert.notEqual(emptyOutputReason({ launched: true, status: 'error', exitCode: 1, secs: 0.15 }), 'spawn_failed');
  // launched / status を欠く旧行・部分行(undefined)は spawn_failed にしない。
  assert.equal(emptyOutputReason({ secs: 0 }), 'no_output');
});

test('emptyOutputReason は Codex の認証失敗と ChatGPT モデル認証不整合を分類する', () => {
  assert.equal(emptyOutputReason({ status: 1, stderrTail: 'cted status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' }), 'auth_failed');
  assert.equal(emptyOutputReason({ status: 1, stderrTail: '..."message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}' }), 'model_auth_mismatch');
  assert.equal(emptyOutputReason({ status: 1 }), 'exit_1');
});

test('認証失敗とモデル認証不整合は codex_empty_output でなく名前付き finding に分離する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' })
    + row({ t: '2026-09-09T10:01:00Z', provider: 'codex', out: 0, status: 1, stderrTail: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account." }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_model_auth_mismatch', 'codex_auth_failed']);
  assert.equal(findings.find((item) => item.id === 'codex_model_auth_mismatch').severity, 'medium');
  assert.equal(findings.find((item) => item.id === 'codex_auth_failed').severity, 'high');
  assert.ok(!findings.some((item) => item.id === 'codex_empty_output'));
});

test('codex_auth_failed は high で next-session.md へ起票する', () => {
  const dir = home();
  write(dir, 'next-session.md', handoff());
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW, todayStr: '2026-09-22' }), true);
  assert.match(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), /codex_auth_failed/);
});

test('認証失敗と本物の出力ゼロが混在しても codex_empty_output は本物だけを数える', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' })
    + row({ t: '2026-09-09T10:01:00Z', provider: 'codex', out: 0, status: 1 }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_auth_failed', 'codex_empty_output']);
  assert.deepEqual(findings.find((item) => item.id === 'codex_empty_output').evidence, ['1件', 'exit_1(1件)', 'インフラ/起動失敗で除外 1件']);
});

test('起動失敗は codex_empty_output でなく codex_launch_failed として起票する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_launch_failed']);
  assert.deepEqual(findings[0].evidence, ['1件', 'launch_failed(1件)']);
});

test('WSL 不在の起動失敗は high で修理手順を付ける', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL ディストリが見つかりませんでした' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_lane_unavailable']);
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].fixTask, /wsl --install.*node.*22.*codex login status/);
});

test('WSL 不在と他の起動失敗を別々に起票する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL ディストリが見つかりませんでした' })
    + row({ t: '2026-09-09T10:01:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL Ubuntu の codex 起動確認に失敗しました' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_launch_failed', 'codex_lane_unavailable']);
  assert.deepEqual(findings[0].evidence, ['1件', 'launch_failed(1件)']);
});

// spawn 自体の失敗(exitCode:null)は「codex が走って何も出さなかった」ではない。
// no_output に混ぜると毎日 codex_empty_output が誤起票され続ける(2026-10-04 診断: 直近24hの3件がこれ)。
test('spawn 失敗だけの出力ゼロは codex_empty_output でなく codex_spawn_failed(high) に分離する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, launched: true, timedOut: false, status: 'error', exitCode: null, secs: 0.15, stderrTail: 'spawn codex ENOENT' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_spawn_failed']);
  const spawnFailed = findings[0];
  assert.equal(spawnFailed.severity, 'high');
  assert.match(spawnFailed.fixTask, /where codex.*command -v codex.*npm i -g/);
  assert.equal(spawnFailed.title, 'Codex の子プロセスが spawn に失敗（起動できていない）');
  assert.deepEqual(spawnFailed.evidence, ['1件', 'spawn_failed(1件)']);
  assert.equal(findings.some((item) => item.id === 'codex_empty_output'), false);
});

// 対照群: 数値 exit を持つ本物の出力ゼロ行は従来どおり codex_empty_output に出る。
// ここを張らないと spawn_failed 判定が広すぎても緑になってしまう。
test('数値 exit の本物の出力ゼロ行は従来どおり codex_empty_output に出る', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, launched: true, timedOut: false, status: 'error', exitCode: 1, secs: 0.15 }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_empty_output']);
  assert.equal(findings.some((item) => item.id === 'codex_spawn_failed'), false);
});

// 台帳(~/.claude/executor-usage.jsonl)の実データをそのまま使う。手写しの要約にすると
// 「reason/status が文字列の番兵」という判別条件そのものが抜け落ちて偽の緑になる。
const PREFLIGHT_BLOCKED_ROW = {
  t: '2026-09-22T18:27:08.929Z', provider: 'codex', model: 'codex-cli', in: 298, out: 0,
  secs: 0.005, cwd: 'C:\\Users\\kimko\\nf-minpaku-automation', launched: false, timedOut: false,
  stderrTail: '', reason: 'spec-missing-context', status: 'spec-missing-context',
};
// 2026-09-23T18:05 に生成された delegation-health.json が codex_launch_failed 2件と報告した窓。
const WHEN_REPORTED = new Date('2026-09-23T18:05:00.424Z');

test('emptyOutputReason は起動前ゲートが止めた行を launch_failed と混同しない', () => {
  assert.equal(emptyOutputReason(PREFLIGHT_BLOCKED_ROW), 'preflight_blocked');
  // 対照群: 起動を試みて失敗した行(数値 status)は従来どおり launch_failed のまま。
  // ここが preflight_blocked に流れると本物の起動失敗が消えるので、必ず両方を張る。
  assert.equal(emptyOutputReason({ launched: false, status: 3, secs: 0 }), 'launch_failed');
  assert.equal(emptyOutputReason({ launched: false, status: 3, secs: 0, stderrTail: 'WSL ディストリが見つかりませんでした' }), 'launch_failed');
});

test('起動前ゲートが止めた行は codex_launch_failed として起票しない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row(PREFLIGHT_BLOCKED_ROW) + row({ ...PREFLIGHT_BLOCKED_ROW, t: '2026-09-22T18:27:44.522Z', secs: 0.004 }));
  const findings = collectFindings({ home: dir, now: WHEN_REPORTED, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_preflight_blocked']);
  assert.equal(findings[0].severity, 'low');
  assert.equal(findings[0].fixTask, undefined);
});

test('起動前ゲートで止めた行を codex_empty_output としても数えない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row(PREFLIGHT_BLOCKED_ROW));
  const findings = collectFindings({ home: dir, now: WHEN_REPORTED, codexUsedPercent: null });
  assert.equal(findings.find((item) => item.id === 'codex_empty_output'), undefined);
});

test('codex_lane_unavailable は high で next-session.md へ起票する', () => {
  const dir = home();
  write(dir, 'next-session.md', handoff());
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL ディストリが見つかりませんでした' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW, todayStr: '2026-09-19' }), true);
  assert.match(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), /codex_lane_unavailable/);
});

test('起動失敗と本物の出力ゼロが混在しても codex_empty_output は本物だけを数える', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false })
    + row({ t: '2026-09-09T10:01:00Z', provider: 'codex', out: 0, secs: 5, timedOut: false, status: 1, launched: true }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  const ids = findings.map((item) => item.id);
  assert.deepEqual(ids, ['codex_launch_failed', 'codex_empty_output']);
  assert.deepEqual(findings.find((item) => item.id === 'codex_empty_output').evidence, ['1件', 'exit_1(1件)', 'インフラ/起動失敗で除外 1件']);
});

test('信頼されていない cwd の出力ゼロは原因を隠さず起票する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: 'Not inside a trusted directory and --skip-git-repo-check was not specified.' }));
  const finding = collectFindings({ home: dir, now: NOW, codexUsedPercent: null })[0];
  assert.equal(finding.id, 'codex_empty_output');
  assert.ok(finding.evidence.includes('untrusted_cwd(1件)'));
});

test('インフラ起因だけの出力ゼロは codex_empty_output に数えない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 5, timedOut: false, status: 1, stderrTail: 'failed to lookup address information' }));
  assert.equal(collectFindings({ home: dir, now: NOW, codexUsedPercent: null })[0].id, 'healthy');
});

test('実障害を起票し、同時に除外したインフラ起因件数も evidence に出す', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 5, timedOut: false, status: 1 })
    + row({ t: '2026-09-09T10:01:00Z', provider: 'codex', out: 0, secs: 4, timedOut: false, status: 1, stderrTail: 'failed to connect to websocket' }));
  const finding = collectFindings({ home: dir, now: NOW, codexUsedPercent: null })[0];
  assert.equal(finding.id, 'codex_empty_output');
  assert.deepEqual(finding.evidence, ['1件', 'exit_1(1件)', 'インフラ/起動失敗で除外 1件']);
});

test('正常時は healthy のみで next-session を変更しない', () => {
  const dir = home(); write(dir, 'next-session.md', handoff()); const before = fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8');
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: { usedPercent: 10 } });
  assert.deepEqual(findings.map((item) => item.id), ['healthy']);
  upsertFixTasks({ home: dir, findings, now: NOW });
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), before);
});

test('rollout ログ断片から最後の primary rate_limits を読む', () => {
  const text = '{"rate_limits":{"primary":{"used_percent":12,"window_minutes":300,"resets_at":10}}}\nnoise\n{\\"rate_limits\\":{\\"primary\\":{\\"used_percent\\":34.5,\\"window_minutes\\":10080,\\"resets_at\\":20}}}';
  assert.deepEqual(parseRateLimitsFromText(text), { usedPercent: 34.5, windowMinutes: 10080, resetsAt: 20 });
});

test('注入した WSL spawn の実測値を読み、失敗時は null にする', () => {
  const output = '{"rate_limits":{"primary":{"used_percent":7,"window_minutes":300,"resets_at":42}}}';
  assert.deepEqual(readCodexUsedPercent({ spawnImpl: () => ({ status: 0, stdout: output }) }), { usedPercent: 7, windowMinutes: 300, resetsAt: 42 });
  assert.equal(readCodexUsedPercent({ spawnImpl: () => ({ status: 1, stdout: output }) }), null);
});

// 単発の起動失敗(OS エラー)は低成果(2件閾値)では拾えず、翌朝 healthy と判定されてしまった
// (2026-09-21 実測: spawn ENAMETOOLONG / in=4964tok / out=0 / status=1)。
test('fallback の spawn ENAMETOOLONG を1件で検出する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T11:00:00Z', provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash', out: 0, status: 1, secs: 1446.7, stderrTail: "at async file:///C:/x/cheap-code.mjs:303:50 { errno: -4064, code: 'ENAMETOOLONG', syscall: 'spawn' } Node.js v24.18.0" }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(findings[0].id, 'fallback_spawn_failed');
  assert.match(findings[0].evidence.join('/'), /1件/);
  assert.match(findings[0].evidence.join('/'), /ENAMETOOLONG/);
  assert.equal(typeof findings[0].fixTask, 'string');
  assert.match(findings[0].fixTask, /ENAMETOOLONG/);
});

test('spawn エラーでない fallback の単発失敗は fallback_spawn_failed を出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T11:00:00Z', provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash', out: 0, status: 1, secs: 100, stderrTail: 'timeout waiting for gemini' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(findings.some((item) => item.id === 'fallback_spawn_failed'), false);
  assert.equal(findings[0].id, 'healthy');
});

test('chain のタイムアウトが2件あれば fallback_chain_timeout を出す', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({
      t: '2026-09-09T11:00:00Z', provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash',
      out: 800, status: 0, secs: 640, stderrTail: '',
      chain: [
        { backend: 'gemini-cli', model: 'gemini-3.7-flash', status: 124, timedOut: true, spawnFailed: false, out: 0, secs: 600, stderrTail: '', outcome: 'timeout' },
        { backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', status: 0, timedOut: false, spawnFailed: false, out: 800, secs: 40, stderrTail: '', outcome: 'ok' }
      ]
    }) +
    row({
      t: '2026-09-09T11:10:00Z', provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash',
      out: 800, status: 0, secs: 640, stderrTail: '',
      chain: [
        { backend: 'gemini-cli', model: 'gemini-3.7-flash', status: 124, timedOut: true, spawnFailed: false, out: 0, secs: 600, stderrTail: '', outcome: 'timeout' },
        { backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', status: 0, timedOut: false, spawnFailed: false, out: 800, secs: 40, stderrTail: '', outcome: 'ok' }
      ]
    })
  );
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  const target = findings.find((item) => item.id === 'fallback_chain_timeout');
  assert.ok(target);
  assert.equal(target.severity, 'medium');
  assert.match(target.evidence[1], /backend gemini-cli/);
  assert.equal(target.evidence[0], '2件');
  assert.equal(target.evidence[2], '捨てた秒数 合計1200秒');
  assert.equal(typeof target.fixTask, 'string');
});

test('chain のタイムアウトが1件だけなら fallback_chain_timeout を出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({
      t: '2026-09-09T11:00:00Z', provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash',
      out: 800, status: 0, secs: 640, stderrTail: '',
      chain: [
        { backend: 'gemini-cli', model: 'gemini-3.7-flash', status: 124, timedOut: true, spawnFailed: false, out: 0, secs: 600, stderrTail: '', outcome: 'timeout' },
        { backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', status: 0, timedOut: false, spawnFailed: false, out: 800, secs: 40, stderrTail: '', outcome: 'ok' }
      ]
    })
  );
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(findings.some((item) => item.id === 'fallback_chain_timeout'), false);
});

test('最終成功でも spawn 失敗が chain にあるだけでは fallback_spawn_failed を出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({
    t: '2026-09-09T11:00:00Z',
    provider: 'fallback',
    model: 'cheap-code:deepseek/deepseek-v4-flash',
    out: 500,
    status: 0,
    secs: 30,
    stderrTail: '',
    chain: [
      { backend: 'gemini-cli', model: 'x', status: 1, timedOut: false, spawnFailed: true, out: 0, secs: 0.1, stderrTail: 'Error: spawn ENAMETOOLONG', outcome: 'spawn_failed' },
      { backend: 'cheap-code', model: 'y', status: 0, timedOut: false, spawnFailed: false, out: 500, secs: 29, stderrTail: '', outcome: 'ok' }
    ]
  }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(findings.some((item) => item.id === 'fallback_spawn_failed'), false);
});

test('dry-run 相当では cooldown ファイルを変更しない', () => {
  const dir = home(), original = { codex: { until: NOW.getTime() + 9999, reason: 'usage_limit' } };
  write(dir, 'provider-cooldown.json', original); write(dir, 'codex-limit-history.jsonl', row({ t: '2026-09-09T10:00:00Z', reason: 'usage_limit' }));
  collectFindings({ home: dir, now: NOW, codexUsedPercent: 1 });
  assert.deepEqual(readCooldown(dir), original);
});

test('文字列 status の WSL 不在3件は high の環境故障と未修理全滅になる', () => {
  const dir = home();
  const rows = [2, 0, 1].map(i => ({ t: `2026-09-09T10:0${i}:00Z`, provider: 'codex', out: 0, launched: false, status: '3', stderrTail: 'WSL ディストリが見つかりませんでした' }));
  write(dir, 'executor-usage.jsonl', rows.map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(emptyOutputReason(rows[0]), 'launch_failed');
  const absent = findings.find(f => f.id === 'codex_lane_unavailable');
  assert.equal(absent.severity, 'high'); assert.ok(absent.fixTask);
  assert.ok(!findings.some(f => f.id === 'codex_preflight_blocked'));
  const outage = findings.find(f => f.id === 'lane_outage_unrepaired');
  assert.equal(outage.provider, 'codex'); assert.equal(outage.severity, 'high');
  assert.deepEqual(outage.evidence, ['3件すべて失敗', '最初 2026-09-09T10:00:00Z', '最後 2026-09-09T10:02:00Z', 'WSL ディストリが見つかりませんでした(3件)']);
});
test('全レーンの未修理全滅は provider ごとに集計し集計窓外を除く', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', ['gemini', 'qwen'].flatMap(provider => Array.from({length:3}, (_,i) => row({t:`2026-09-09T10:0${i}:00Z`,provider,status:'error',out:5,stderrTail:'HTTP 402'}))).join('') + row({t:'2020-01-01T00:00:00Z',provider:'gemini',status:'ok',out:10}));
  assert.deepEqual(collectFindings({home:dir,now:NOW}).filter(f=>f.id==='lane_outage_unrepaired').map(f=>f.provider), ['gemini','qwen']);
});
test('失敗2件だけまたは失敗2件と成功1件では未修理全滅を出さない', () => {
  const dir = home();
  const failed = [0,1].map(i=>({t:`2026-09-09T10:0${i}:00Z`,provider:'gemini',status:'error',out:0}));
  for (const success of [null, {status:'ok'}, {status:0}, {status:'0'}, {ok:true}]) {
    write(dir,'executor-usage.jsonl', [...failed,...(success?[{t:'2026-09-09T10:02:00Z',provider:'gemini',out:10,...success}]:[])].map(row).join(''));
    assert.ok(!collectFindings({home:dir,now:NOW}).some(f=>f.id==='lane_outage_unrepaired'));
  }
});

const ENVIRONMENT_FAILURES = [
  ['codex_lane_unavailable', { launched: false, status: 3, stderrTail: 'WSL ディストリが見つかりませんでした' }],
  ['codex_spawn_failed', { launched: true, status: 'error', exitCode: null, stderrTail: 'spawn codex ENOENT' }],
  ['codex_auth_failed', { status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' }],
];

for (const [id, failure] of ENVIRONMENT_FAILURES) {
  test(`${id}: 失敗3件の後に codex の成功1件があれば出さない`, () => {
    const dir = home();
    const failed = [2, 0, 1].map(i => ({ t: `2026-09-09T10:0${i}:00Z`, provider: 'codex', out: 0, ...failure }));
    // 成功を先頭に書き、ファイル順ではなく時刻で判断することも確認する。
    write(dir, 'executor-usage.jsonl', [{ t: '2026-09-09T10:03:00Z', provider: 'codex', status: '0', out: 10 }, ...failed].map(row).join(''));
    const findings = collectFindings({ home: dir, now: NOW });
    assert.equal(findings.some(f => f.id === id), false);
    assert.equal(findings.some(f => f.id === 'lane_outage_unrepaired'), false);
  });

  test(`${id}: 成功1件の後に失敗3件があれば high で出る`, () => {
    const dir = home();
    const failed = [2, 0, 1].map(i => ({ t: `2026-09-09T10:0${i}:00Z`, provider: 'codex', out: 0, ...failure }));
    write(dir, 'executor-usage.jsonl', [...failed, { t: '2026-09-09T09:59:00Z', provider: 'codex', status: 'ok', out: 10 }].map(row).join(''));
    const finding = collectFindings({ home: dir, now: NOW }).find(f => f.id === id);
    assert.equal(finding?.severity, 'high');
    assert.equal(finding.evidence[0], '3件');
  });

  test(`${id}: 同時刻の成功・別 provider の成功・出力ゼロ・失敗状態は修復扱いしない`, () => {
    const dir = home();
    write(dir, 'executor-usage.jsonl', [
      { t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, ...failure },
      { t: '2026-09-09T10:00:00Z', provider: 'codex', status: 0, out: 10 },
      { t: '2026-09-09T10:01:00Z', provider: 'fallback', status: 0, out: 10 },
      { t: '2026-09-09T10:02:00Z', provider: 'codex', status: 0, out: 0 },
      { t: '2026-09-09T10:03:00Z', provider: 'codex', status: 1, out: 10 },
    ].map(row).join(''));
    assert.equal(collectFindings({ home: dir, now: NOW }).find(f => f.id === id)?.severity, 'high');
  });
}

test('環境故障は種類ごとの最後の失敗時刻で修復を判定する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [
    { t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, ...ENVIRONMENT_FAILURES[0][1] },
    { t: '2026-09-09T10:01:00Z', provider: 'codex', status: 0, out: 10 },
    { t: '2026-09-09T10:02:00Z', provider: 'codex', out: 0, ...ENVIRONMENT_FAILURES[2][1] },
  ].map(row).join(''));
  assert.deepEqual(collectFindings({ home: dir, now: NOW }).map(f => f.id), ['codex_auth_failed']);
});
