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
  assert.equal(findings.find((item) => item.id === 'codex_auth_failed').severity, 'low');
  assert.ok(!findings.some((item) => item.id === 'codex_empty_output'));
});

test('codex_auth_failed は low なので next-session.md へ起票しない', () => {
  const dir = home();
  write(dir, 'next-session.md', handoff());
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW, todayStr: '2026-09-22' }), false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), /codex_auth_failed/);
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

// WSL のディストリが1つも無い PC では codex レーンは構造的に使えず、コードでは直せない。
// 「コードで直す欠陥」として毎日起票し続けると、直せない修正タスクが残TODOを占有し続ける(2026-09-19 実測)。
test('WSL 不在の起動失敗は欠陥でなく環境の事実として low で残し、fixTask を付けない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL ディストリが見つかりませんでした' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_lane_unavailable']);
  assert.equal(findings[0].severity, 'low');
  assert.equal(findings[0].fixTask, undefined);
});

test('WSL 不在と直せる起動失敗が混在しても、起票対象は直せる方だけ', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl',
    row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL ディストリが見つかりませんでした' })
    + row({ t: '2026-09-09T10:01:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL Ubuntu の codex 起動確認に失敗しました' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.deepEqual(findings.map((item) => item.id), ['codex_launch_failed', 'codex_lane_unavailable']);
  assert.deepEqual(findings[0].evidence, ['1件', 'launch_failed(1件)']);
});

test('codex_lane_unavailable は low なので next-session.md へ起票しない', () => {
  const dir = home();
  write(dir, 'next-session.md', handoff());
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, secs: 0, timedOut: false, status: 3, launched: false, stderrTail: 'WSL ディストリが見つかりませんでした' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW, todayStr: '2026-09-19' }), false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), /codex_lane_unavailable/);
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

test('dry-run 相当では cooldown ファイルを変更しない', () => {
  const dir = home(), original = { codex: { until: NOW.getTime() + 9999, reason: 'usage_limit' } };
  write(dir, 'provider-cooldown.json', original); write(dir, 'codex-limit-history.jsonl', row({ t: '2026-09-09T10:00:00Z', reason: 'usage_limit' }));
  collectFindings({ home: dir, now: NOW, codexUsedPercent: 1 });
  assert.deepEqual(readCooldown(dir), original);
});
