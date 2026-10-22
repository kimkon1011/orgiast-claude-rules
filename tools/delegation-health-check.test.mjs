import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHandoff } from './auto-session.mjs';
import { applyAutoHeal, authRestoredAfter, collectFindings, dedupeLimitEvents, emptyOutputReason, isCooldownSkippedRow, isEmptyDiffEscalationRow, isQuotaLimitedRow, lowYieldBackends, metricFromLaterWindow, parseRateLimitsFromText, readCodexUsedPercent, timeoutWasteSummary, upsertFixTasks, windowResetsAfterLimit } from './delegation-health-check.mjs';

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

test('修理済み id の起票行は当日の findings に無ければ自動閉鎖する', () => {
  const dir = home();
  write(dir, 'next-session.md', handoff().replace('1. 既存TODO', '1. [delegation-health:lane_outage_unrepaired] codex が全滅 — 証拠: 4件 (起票 2026-09-08)\n2. 既存TODO'));
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', status: 'ok', out: 10 }));
  const findings = [{ id: 'provider_usage_limit', provider: 'kimi', severity: 'low', title: 'x', evidence: ['e'] }];
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW }), true);
  const parsed = parseHandoff(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'));
  assert.match(parsed.todos[0], /^~~/);
  assert.match(parsed.todos[0], /→ ✅ 2026-09-09 完了（delegation-health 自動閉鎖/);
  assert.match(parsed.todos[0], /\[delegation-health:lane_outage_unrepaired\]/);
  assert.equal(parsed.todos[1], '既存TODO');
});

test('当日も検出されている id は自動閉鎖しない', () => {
  const dir = home(), md = handoff().replace('1. 既存TODO', '1. [delegation-health:codex_empty_output] 古い — (起票 2026-09-09)');
  write(dir, 'next-session.md', md);
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', status: 'ok', out: 10 }));
  const findings = [{ id: 'codex_empty_output', severity: 'medium', title: 'zero', evidence: ['1件'], fixTask: '修正する' }];
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW }), false);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), md);
});

test('自動閉鎖済みの id が再検出されたら新しい起票で復活させる', () => {
  const dir = home();
  write(dir, 'next-session.md', handoff().replace('1. 既存TODO', '1. ~~[delegation-health:codex_empty_output] 古い — (起票 2026-09-08)~~ → ✅ 2026-09-09 完了（delegation-health 自動閉鎖: 当日の findings に id なし）\n2. 既存TODO'));
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', status: 'ok', out: 10 }));
  const findings = [{ id: 'codex_empty_output', severity: 'medium', title: 'zero', evidence: ['1件'], fixTask: '修正する' }];
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW }), true);
  const md = fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), parsed = parseHandoff(md);
  assert.equal((md.match(/\[delegation-health:codex_empty_output\]/g) || []).length, 1);
  assert.doesNotMatch(parsed.todos[0], /~~/);
  assert.match(parsed.todos[0], /起票 2026-09-09/);
  assert.equal(parsed.todos[1], '既存TODO');
});

test('台帳に直近24hの行が無い日は自動閉鎖しない', () => {
  const dir = home(), md = handoff().replace('1. 既存TODO', '1. [delegation-health:lane_outage_unrepaired] codex が全滅 — 証拠: 4件 (起票 2026-09-08)\n2. 既存TODO');
  write(dir, 'next-session.md', md);
  write(dir, 'executor-usage.jsonl', row({ t: '2020-01-01T00:00:00Z', provider: 'codex', status: 'ok', out: 10 }));
  const findings = [{ id: 'provider_usage_limit', provider: 'kimi', severity: 'low', title: 'x', evidence: ['e'] }];
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW }), false);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), md);
});

test('delegation-health マーカーを持たない行は閉じない', () => {
  const dir = home(), md = handoff();
  write(dir, 'next-session.md', md);
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', status: 'ok', out: 10 }));
  const findings = [{ id: 'provider_usage_limit', provider: 'kimi', severity: 'low', title: 'x', evidence: ['e'] }];
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW }), false);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), md);
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
  assert.equal(emptyOutputReason({ status: 'error', exitCode: 1, launched: true, timedOut: false, secs: 38.4, stderrTail: 'ting... 2/5 ERROR: Reconnecting... 3/5 ERROR: Reconnecting... 4/5 ERROR: Reconnecting... 5/5 ERROR: workspace routing discovery unauthorized (401) ERROR: workspace routing discovery unauthorized (401)' }), 'auth_failed');
  assert.equal(emptyOutputReason({ status: 1, stderrTail: 'cted status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses' }), 'auth_failed');
  assert.equal(emptyOutputReason({ status: 1, stderrTail: '..."message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}' }), 'model_auth_mismatch');
  assert.equal(emptyOutputReason({ status: 1 }), 'exit_1');
});

test('emptyOutputReason は U+2019 と U+0027 の両方の usage limit 行を usage_limit に分類する', () => {
  // U+2019 (’)
  assert.equal(emptyOutputReason({
    status: 'error',
    exitCode: 1,
    launched: true,
    timedOut: false,
    stderrTail: 'M. ERROR: You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:53 PM.',
  }), 'usage_limit');
  // U+0027 (')
  assert.equal(emptyOutputReason({
    status: 1,
    exitCode: 1,
    launched: true,
    timedOut: false,
    stderrTail: "ERROR: You've hit your usage limit. Upgrade to Pro",
  }), 'usage_limit');
  // 対照群: stderrTail なしの status:1 は従来どおり exit_1、{secs:0} は no_output（張りすぎ検出）
  assert.equal(emptyOutputReason({ status: 1 }), 'exit_1');
  assert.equal(emptyOutputReason({ secs: 0 }), 'no_output');
});

test('実台帳行の Codex 上限到達行で collectFindings が codex_empty_output を出さず codex_usage_limit を出す', () => {
  const dir = home();
  const realUsageRow = {
    t: '2026-10-10T18:23:32.573Z',
    provider: 'codex',
    model: 'codex-cli/default',
    lane: 'chatgpt_auth_default:default_sol',
    in: 3531,
    out: 0,
    launched: true,
    timedOut: false,
    status: 'error',
    exitCode: 1,
    fastFail: true,
    attempts: 2,
    secs: 32.193,
    stderrTail: 'M. ERROR: You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:53 PM.',
  };
  write(dir, 'executor-usage.jsonl', row(realUsageRow));
  const findings = collectFindings({ home: dir, now: new Date('2026-10-10T18:23:35.000Z'), codexUsedPercent: null });
  const ids = findings.map((f) => f.id);
  assert.ok(ids.includes('codex_usage_limit'), 'codex_usage_limit が含まれること');
  assert.ok(!ids.includes('codex_empty_output'), 'codex_empty_output が含まれないこと');
  const limitFinding = findings.find((f) => f.id === 'codex_usage_limit');
  assert.equal(limitFinding.severity, 'low');
  assert.equal(limitFinding.fixTask, undefined);
  assert.deepEqual(limitFinding.evidence, ['1件', 'usage_limit(1件)']);
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

// 2026-10-12〜10-14 実測: token_revoked の 401 は "workspace routing discovery unauthorized (401)"
// の語順で出る。旧パターンに一致せず no_output に埋もれ、codex_empty_output が毎晩起票された。
const TOKEN_REVOKED_STDERR = 'ting... 2/5 ERROR: Reconnecting... 3/5 ERROR: Reconnecting... 4/5 ERROR: Reconnecting... 5/5 ERROR: workspace routing discovery unauthorized (401) ERROR: workspace routing discovery unauthorized (401)';

test('token_revoked 401 の出力ゼロは auth_failed に分類し codex_empty_output に出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [0, 1, 2].map((i) => row({
    t: `2026-09-09T10:0${i}:00Z`, provider: 'codex', out: 0, status: 'error', exitCode: 1, launched: true, timedOut: false, secs: 38 + i,
    stderrTail: TOKEN_REVOKED_STDERR,
  })).join(''));
  const ids = collectFindings({ home: dir, now: NOW, codexUsedPercent: null }).map((item) => item.id);
  assert.ok(ids.includes('codex_auth_failed'), JSON.stringify(ids));
  assert.ok(!ids.includes('codex_empty_output'), JSON.stringify(ids));
});

test('token_revoked 401 の失敗後に成功1件があれば何も起票しない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [
    { t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 'error', exitCode: 1, launched: true, timedOut: false, secs: 38.4, stderrTail: TOKEN_REVOKED_STDERR },
    { t: '2026-09-09T10:01:00Z', provider: 'codex', status: '0', out: 10 },
  ].map(row).join(''));
  assert.deepEqual(collectFindings({ home: dir, now: NOW, codexUsedPercent: null }).map((item) => item.id), ['healthy']);
});

test('codex_auth_failed は high で next-session.md へ起票する', () => {
  const dir = home();
  write(dir, 'next-session.md', handoff());
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: null });
  assert.equal(upsertFixTasks({ home: dir, findings, now: NOW, todayStr: '2026-09-22' }), true);
  assert.match(fs.readFileSync(path.join(dir, '.claude', 'next-session.md'), 'utf8'), /codex_auth_failed/);
});

test('Windows 側 auth.json が最後の auth 失敗より後に更新されていれば codex_auth_failed を出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' }));
  fs.mkdirSync(path.join(dir, '.codex'));
  const authFile = path.join(dir, '.codex', 'auth.json');
  fs.writeFileSync(authFile, '{"tokens":{"id_token":"x"}}');
  fs.utimesSync(authFile, new Date('2026-09-09T11:00:00Z'), new Date('2026-09-09T11:00:00Z'));
  assert.equal(collectFindings({ home: dir, now: NOW }).some((item) => item.id === 'codex_auth_failed'), false);
});

test('失敗より古い / トークン無し / 壊れた JSON / ファイル無し は従来どおり high で出る', () => {
  const failure = { t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' };
  for (const [name, contents, mtime] of [
    ['古い', '{"tokens":{"id_token":"x"}}', '2026-09-09T09:00:00Z'],
    ['トークン無し', '{"tokens":{}}', '2026-09-09T11:00:00Z'],
    ['壊れた JSON', '{', '2026-09-09T11:00:00Z'],
    ['ファイル無し', null, null],
  ]) {
    const dir = home();
    write(dir, 'executor-usage.jsonl', row(failure));
    if (contents !== null) {
      fs.mkdirSync(path.join(dir, '.codex'));
      const authFile = path.join(dir, '.codex', 'auth.json');
      fs.writeFileSync(authFile, contents);
      fs.utimesSync(authFile, new Date(mtime), new Date(mtime));
    }
    const finding = collectFindings({ home: dir, now: NOW }).find((item) => item.id === 'codex_auth_failed');
    assert.equal(finding?.severity, 'high', name);
  }
});

test('BOM 付き・access_token のみでも復旧扱い', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({ t: '2026-09-09T10:00:00Z', provider: 'codex', out: 0, status: 1, stderrTail: '401 Unauthorized: Missing bearer or basic authentication in header' }));
  fs.mkdirSync(path.join(dir, '.codex'));
  const authFile = path.join(dir, '.codex', 'auth.json');
  fs.writeFileSync(authFile, '\uFEFF{"tokens":{"access_token":"x"}}');
  fs.utimesSync(authFile, new Date('2026-09-09T11:00:00Z'), new Date('2026-09-09T11:00:00Z'));
  assert.equal(collectFindings({ home: dir, now: NOW }).some((item) => item.id === 'codex_auth_failed'), false);
});

test('authRestoredAfter は有効な t が無ければ false、statImpl 注入で mtime を制御できる', () => {
  assert.equal(authRestoredAfter('unused', [{ t: 'invalid' }], {
    statImpl: () => ({ mtimeMs: Infinity }),
    readFile: () => '{"tokens":{"id_token":"x"}}',
  }), false);
  assert.equal(authRestoredAfter('unused', [{ t: '2026-09-09T10:00:00Z' }], {
    statImpl: () => ({ mtimeMs: Date.parse('2026-09-09T11:00:00Z') }),
    readFile: () => '{"tokens":{"id_token":"x"}}',
  }), true);
  assert.equal(authRestoredAfter('unused', [{ t: '2026-09-09T10:00:00Z' }], {
    statImpl: () => ({ mtimeMs: Date.parse('2026-09-09T09:00:00Z') }),
    readFile: () => '{"tokens":{"id_token":"x"}}',
  }), false);
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

// 2026-10-10 18:23 JST の実測: codex は本物の usage_limit を出した(rollout に
// "codex_error_info":"usage_limit_exceeded")が、delegation-health は上限到達前に記録された
// primary 58% を最新値として読み、偽陽性と判定して生きていた cooldown を解除していた。
// 上限に達した codex は primary を null で返す(68セッション中、上限到達の2本だけが null)。
test('primary が null になったら古い used_percent を最新値として返さない', () => {
  const stream = '{"rate_limits":{"primary":{"used_percent":58.0,"window_minutes":43200,"resets_at":1792516579}}}\n'
    + '{"rate_limits":{"primary":null,"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"}}}';
  assert.deepEqual(parseRateLimitsFromText(stream), { exhausted: true });
  // 回復後は再び数値が返る(一度 null を見ただけでは以後ずっと exhausted にしない)。
  assert.deepEqual(parseRateLimitsFromText(`${stream}\n{"rate_limits":{"primary":{"used_percent":3,"window_minutes":43200,"resets_at":1792516579}}}`),
    { usedPercent: 3, windowMinutes: 43200, resetsAt: 1792516579 });
  // "null" で始まる別キー(nullify 等)を null と誤読しない。
  assert.deepEqual(parseRateLimitsFromText('{"primary":nullish}'), null);
});

test('primary が null の間は cooldown を解除しない', () => {
  const dir = home();
  write(dir, 'codex-limit-history.jsonl', row({ t: '2026-09-09T11:00:00Z', until: 1791982380000, reason: 'usage_limit' }));
  write(dir, 'provider-cooldown.json', { codex: { until: NOW.getTime() + 1000, reason: 'usage_limit' } });
  write(dir, 'next-session.md', handoff());
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: { exhausted: true } });
  assert.deepEqual(findings.map((item) => item.id), ['healthy']);
  assert.equal(applyAutoHeal({ home: dir, findings, now: NOW }), false);
  assert.equal(readCooldown(dir).codex.until, NOW.getTime() + 1000);
});

// 2026-10-10T12:16Z の起票の証拠になった実際の WSL 出力。その時点で「最新3本」だった
// セッションを find|sort -nr|head -3|sort -n の順(古い→新しい)に連結した grep 結果で、
// 末尾2行が上限到達セッションの "primary":null。古い 67%/10080分/resets_at 1791982428 は
// 8時間前のセッションの値なので、最新値として採用してはならない。
const REAL_20261010_REPLAY = [
  '"primary":{"used_percent":66.0,"window_minutes":10080,"resets_at":1791982427}',
  '"primary":{"used_percent":67.0,"window_minutes":10080,"resets_at":1791982427}',
  '"primary":{"used_percent":67.0,"window_minutes":10080,"resets_at":1791982427}',
  '"primary":{"used_percent":67.0,"window_minutes":10080,"resets_at":1791982428}',
  '"primary":null',
  '"primary":null',
].join('\n');

test('実機ログ(2026-10-10): 最新セッションが primary:null なら古い 67% を実測値にしない', () => {
  assert.deepEqual(parseRateLimitsFromText(REAL_20261010_REPLAY), { exhausted: true });
  assert.deepEqual(readCodexUsedPercent({ spawnImpl: () => ({ status: 0, stdout: REAL_20261010_REPLAY }) }), { exhausted: true });
});

// 上限到達(12:16Z, until 1791982380000)の後、codex は別の窓(43200分=30日枠 / resets_at
// 1794249388)で回復し used_percent 3 を返した。これを反証に使うと、本物の上限を毎晩
// 起票し直し、生きている cooldown まで消す。窓が進んでいたら反証にしない。
test('上限より後に別の窓へ進んだ低い使用率は偽陽性と判定しない', () => {
  const dir = home();
  write(dir, 'codex-limit-history.jsonl', row({ t: '2026-09-09T11:00:00Z', until: 1791982380000, reason: 'usage_limit' }));
  write(dir, 'provider-cooldown.json', { codex: { until: NOW.getTime() + 86_400_000, reason: 'usage_limit' } });
  write(dir, 'next-session.md', handoff());
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: { usedPercent: 3, windowMinutes: 43200, resetsAt: 1794249388 } });
  assert.deepEqual(findings.map((item) => item.id), ['healthy']);
  assert.equal(applyAutoHeal({ home: dir, findings, now: NOW }), false);
  assert.equal(readCooldown(dir).codex.until, NOW.getTime() + 86_400_000);
});

// 窓が進んでいない(同じ枠のまま低い)ときは従来どおり起票する。判定を緩めすぎていないことの固定。
test('同じ窓のまま低い使用率なら従来どおり偽陽性として起票する', () => {
  const dir = home();
  write(dir, 'codex-limit-history.jsonl', row({ t: '2026-09-09T11:00:00Z', until: 1791982380000, reason: 'usage_limit' }));
  const findings = collectFindings({ home: dir, now: NOW, codexUsedPercent: { usedPercent: 67, windowMinutes: 10080, resetsAt: 1791982428 } });
  assert.equal(findings[0].id, 'codex_false_usage_limit');
  assert.match(findings[0].evidence.join('/'), /used_percent 67/);
});

// 2026-10-20T19:15Z の実測データ。本物の上限(primary:null / credits 0)だが until のパースが
// 壊れて 2026-10-21T09:05Z になり、翌夜は 02:52Z 開始の 300 分窓の used_percent 8 を読んだ。
test('2026-10-20 の実測: 後から始まった窓の低使用率を偽陽性の根拠にしない', () => {
  const dir = home();
  const now = new Date('2026-10-21T18:09:49.000Z');
  write(dir, 'codex-limit-history.jsonl', [
    { t: '2026-10-20T19:15:41.089Z', until: 1792573500000, reason: 'usage_limit' },
    { t: '2026-10-20T19:24:44.528Z', until: 1792573500000, reason: 'usage_limit_no_fallback' },
  ].map(row).join(''));
  const findings = collectFindings({ home: dir, now, codexUsedPercent: { usedPercent: 8, windowMinutes: 300, resetsAt: 1792569159 } });
  assert.equal(findings.some((item) => item.id === 'codex_false_usage_limit'), false);
});

test('metricFromLaterWindow: 短い窓が検出より後に始まった時だけ true', () => {
  const rows = [{ t: '2026-10-20T19:15:41.000Z', until: 1792573500000 }];
  assert.equal(metricFromLaterWindow(rows, { usedPercent: 8, windowMinutes: 300, resetsAt: 1792569159 }), true);
  assert.equal(metricFromLaterWindow(rows, { usedPercent: 67, windowMinutes: 10080, resetsAt: 1791982428 }), false);
  assert.equal(metricFromLaterWindow(rows, { usedPercent: 8, windowMinutes: 300, resetsAt: 1792530000 }), false);
  assert.equal(metricFromLaterWindow(rows, { usedPercent: 8, windowMinutes: null, resetsAt: 1792569159 }), false);
});

test('dedupeLimitEvents: until が同じ usage_limit と usage_limit_no_fallback を1件に数える', () => {
  assert.equal(dedupeLimitEvents([
    { until: 1792573500000, reason: 'usage_limit' },
    { until: 1792573500000, reason: 'usage_limit_no_fallback' },
    { reason: 'usage_limit' },
  ]).length, 2);
});

test('windowResetsAfterLimit: 窓が進んだ時だけ true、until 不明なら判定しない', () => {
  assert.equal(windowResetsAfterLimit([{ reason: 'usage_limit' }], { usedPercent: 1, resetsAt: 1794249388 }), false);
  assert.equal(windowResetsAfterLimit([{ reason: 'usage_limit' }], null), false);
  assert.equal(windowResetsAfterLimit([{ until: 1791982380000 }], { usedPercent: 1, resetsAt: 1794249388 }), true);
  assert.equal(windowResetsAfterLimit([{ until: 1791982380000 }], { usedPercent: 1, resetsAt: 1791982428 }), false);
  assert.equal(windowResetsAfterLimit([{ until: 1791982380000 }], { usedPercent: 1, resetsAt: null }), false);
  // until が壊れていても throw せず従来どおり起票する側に倒す。
  assert.equal(windowResetsAfterLimit([{ until: 'x' }], { usedPercent: 1, resetsAt: 1794249388 }), false);
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

// 2026-10-13 診断: glm の「3件すべて失敗」は 1 リクエストの再試行(attempt 0/1/2)で、
// 実体は z.ai Coding Plan の週次/月次上限到達(HTTP 429 / error.code 1310)。
// レーンの故障ではないので high の修理タスクとして起票してはならない。
const GLM_LIMIT_ROWS = [0, 1, 2].map((i) => ({
  t: `2026-09-09T10:25:1${i}.083Z`, provider: 'glm', model: 'glm-5.3',
  in: 0, out: 0, secs: 1.7, status: 'http_429', attempt: i, failover: false,
}));

test('isQuotaLimitedRow は上限/レート制限の status だけを true にする', () => {
  for (const status of ['http_429', 'http_402', 'HTTP_429', 'http429']) assert.equal(isQuotaLimitedRow({ status }), true, status);
  for (const status of ['http_500', 'http_401', 'error', 'ok', '0', '']) assert.equal(isQuotaLimitedRow({ status }), false, status);
  assert.equal(isQuotaLimitedRow({}), false);
  assert.equal(isQuotaLimitedRow(null), false);
  assert.equal(isQuotaLimitedRow(), false);
});

test('上限/レート制限だけで全滅したレーンは lane_outage_unrepaired ではなく low の可視化にする', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', GLM_LIMIT_ROWS.map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((f) => f.id === 'lane_outage_unrepaired'), false);
  const limit = findings.find((f) => f.id === 'provider_usage_limit');
  assert.equal(limit.provider, 'glm');
  assert.equal(limit.severity, 'low');
  // low には fixTask を付けない＝upsertFixTasks (high/medium のみ) が起票しない。
  assert.equal(limit.fixTask, undefined);
  assert.equal(limit.evidence[0], '3件すべて失敗');
  // 証拠は catch-all の no_output ではなく、台帳に書かれた失敗の種類をそのまま出す
  // (「no_output(3件)」では上限到達が原因不明の故障に見える。2026-10-13 診断)。
  assert.equal(limit.evidence[1], 'quota_limited(3件)');
});

// 2026-10-19 実測: fallback の「直近3件すべて失敗」は、gemini が応答を返した(chain outcome=ok)が
// 作業ツリーを1行も変えなかった行だった。バックエンドは動いており、レーン障害ではない。
// codex-do が付ける reason:'empty_diff' で識別し、high の未修理全滅として起票しない。
test('fallback の空diff昇格行はレーン全滅ではなく low の可視化にする', () => {
  const dir = home();
  const emptyDiffRows = [
    { t: '2026-09-09T09:00:00Z', provider: 'fallback', model: 'gemini-cli/gemini-3.7-flash', status: 'error', out: 623, reason: 'empty_diff', stderrTail: 'YOLO mode is enabled.', chain: [{ backend: 'gemini-cli', status: 0, out: 623, outcome: 'ok' }] },
    { t: '2026-09-09T10:00:00Z', provider: 'fallback', model: 'gemini-cli/gemini-3.7-flash', status: 'error', out: 258, reason: 'empty_diff', stderrTail: 'Ripgrep is not available.', chain: [{ backend: 'gemini-cli', status: 0, out: 258, outcome: 'ok' }] },
    { t: '2026-09-09T11:00:00Z', provider: 'fallback', model: 'gemini-cli/gemini-3.7-flash', status: 'error', out: 81, reason: 'empty_diff', chain: [{ backend: 'gemini-cli', status: 0, out: 81, outcome: 'ok' }] },
  ];
  write(dir, 'executor-usage.jsonl', emptyDiffRows.map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((f) => f.id === 'lane_outage_unrepaired'), false);
  const visible = findings.find((f) => f.id === 'fallback_empty_diff_escalation');
  assert.equal(visible.provider, 'fallback');
  assert.equal(visible.severity, 'low');
  assert.equal(visible.fixTask, undefined);
  assert.equal(visible.evidence[0], '3件すべて空diff');
});

test('chain が ok でない fallback 失敗行は従来どおりレーン全滅として起票する', () => {
  const dir = home();
  const failed = [
    { t: '2026-09-09T09:00:00Z', provider: 'fallback', status: 'error', out: 0, reason: 'empty_diff', chain: [{ backend: 'gemini-cli', status: 1, outcome: 'failed' }] },
    { t: '2026-09-09T10:00:00Z', provider: 'fallback', status: 'error', out: 0, chain: [{ backend: 'gemini-cli', status: 1, outcome: 'failed' }] },
    { t: '2026-09-09T11:00:00Z', provider: 'fallback', status: 'error', out: 0, chain: [{ backend: 'gemini-cli', status: 1, outcome: 'failed' }] },
  ];
  write(dir, 'executor-usage.jsonl', failed.map(row).join(''));
  assert.equal(isEmptyDiffEscalationRow(failed[0]), false);
  const outage = collectFindings({ home: dir, now: NOW }).find((f) => f.id === 'lane_outage_unrepaired');
  assert.equal(outage.provider, 'fallback');
  assert.equal(outage.severity, 'high');
});

test('上限行に 1 件でも上限以外の失敗が混ざれば従来どおり high の未修理全滅にする', () => {
  const dir = home();
  const mixed = [...GLM_LIMIT_ROWS.slice(0, 2), { t: '2026-09-09T10:25:13.050Z', provider: 'glm', out: 0, status: 'error' }];
  write(dir, 'executor-usage.jsonl', mixed.map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((f) => f.id === 'provider_usage_limit'), false);
  const outage = findings.find((f) => f.id === 'lane_outage_unrepaired');
  assert.equal(outage.provider, 'glm');
  assert.equal(outage.severity, 'high');
});

test('上限行が2件だけなら 3件閾値に届かずどの finding も出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', GLM_LIMIT_ROWS.slice(0, 2).map(row).join(''));
  const ids = collectFindings({ home: dir, now: NOW }).map((f) => f.id);
  assert.equal(ids.includes('lane_outage_unrepaired'), false);
  assert.equal(ids.includes('provider_usage_limit'), false);
});

// 2026-10-13 実測（~/.claude/executor-usage.jsonl の glm 11件）: cooldown 5件 + http_429 6件。
// cooldown 行は cheap-code が「上限中なのでリクエストを投げなかった」記録で、失敗ではない。
// これを分母に入れていたため、上限到達の実体が high の未修理全滅（＝毎晩の偽の修理起票）に見えていた。
const COOLDOWN_ROW = (i) => ({ t: `2026-09-09T10:2${i}:10.987Z`, provider: 'glm', model: 'glm-5.3', in: 4529, out: 0, secs: 0, ok: false, status: 'cooldown' });
const GLM_REAL_ROWS = [0, 1, 2, 3, 4].map(COOLDOWN_ROW).concat(
  [0, 1, 2, 3, 4, 5].map((i) => ({ t: `2026-09-09T10:2${i}:30.083Z`, provider: 'glm', model: 'glm-5.3', in: 0, out: 0, secs: 1.7, status: 'http_429', attempt: i % 3, failover: false })));

test('isCooldownSkippedRow は cooldown の行だけを true にする', () => {
  for (const status of ['cooldown', 'Cooldown', 'COOLDOWN']) assert.equal(isCooldownSkippedRow({ status }), true, status);
  for (const status of ['http_429', 'ok', 0, '0', 'error', '']) assert.equal(isCooldownSkippedRow({ status }), false, status);
  assert.equal(isCooldownSkippedRow({}), false);
  assert.equal(isCooldownSkippedRow(null), false);
  assert.equal(isCooldownSkippedRow(), false);
});

test('emptyOutputReason は台帳の文字列 status を no_output に潰さない', () => {
  assert.equal(emptyOutputReason({ status: 'http_429' }), 'quota_limited');
  assert.equal(emptyOutputReason({ status: 'http_402' }), 'quota_limited');
  assert.equal(emptyOutputReason({ status: 'cooldown' }), 'cooldown_skipped');
  // 数値 status(終了コード)と既存の文字列 status の扱いは変えない。
  assert.equal(emptyOutputReason({ status: 3 }), 'exit_3');
  assert.equal(emptyOutputReason({ status: 'error' }), 'spawn_failed');
});

test('cooldown 行を分母から外し、上限到達の glm を high の未修理全滅にしない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', GLM_REAL_ROWS.map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((f) => f.id === 'lane_outage_unrepaired'), false);
  const limit = findings.find((f) => f.id === 'provider_usage_limit');
  assert.equal(limit.provider, 'glm');
  assert.equal(limit.severity, 'low');
  assert.equal(limit.fixTask, undefined);
  // 分母は実際に投げた6件(cooldown 2件は未試行なので数えない)。
  assert.equal(limit.evidence[0], '6件すべて失敗');
  assert.equal(limit.evidence[1], 'quota_limited(6件)');
});

test('cooldown だけで埋まった窓は可視化だけ残し high の起票にしない', () => {
  const dir = home();
  const until = NOW.getTime() + 3_600_000;
  write(dir, 'provider-cooldown.json', { glm: { until, reason: 'lane_doctor_usage_limit', at: NOW.getTime() } });
  write(dir, 'executor-usage.jsonl', [0, 1, 2].map(COOLDOWN_ROW).map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((f) => f.id === 'lane_outage_unrepaired'), false);
  const skippedFinding = findings.find((f) => f.id === 'provider_cooldown_skipped');
  assert.equal(skippedFinding.provider, 'glm');
  assert.equal(skippedFinding.severity, 'low');
  assert.equal(skippedFinding.fixTask, undefined);
  assert.equal(skippedFinding.evidence[0], '3件すべて cooldown');
  assert.equal(skippedFinding.evidence[3], 'cooldown lane_doctor_usage_limit / until 2026-09-09T13:00:00.000Z');
});

test('cooldown 行が混ざっても上限以外の失敗があれば high の未修理全滅のままにする', () => {
  const dir = home();
  const rows = [0, 1].map(COOLDOWN_ROW).concat(
    [0, 1, 2].map((i) => ({ t: `2026-09-09T10:2${i}:40.000Z`, provider: 'glm', out: 0, status: 'error' })));
  write(dir, 'executor-usage.jsonl', rows.map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.some((f) => f.id === 'provider_usage_limit'), false);
  const outage = findings.find((f) => f.id === 'lane_outage_unrepaired');
  assert.equal(outage.severity, 'high');
  assert.equal(outage.evidence[0], '3件すべて失敗');
  assert.ok(outage.evidence.includes('cooldown スキップ 2件'));
  assert.ok(outage.fixTask);
});

test('cooldown 行しか無い窓で未試行が3件未満なら finding を出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [0, 1].map(COOLDOWN_ROW).map(row).join(''));
  const ids = collectFindings({ home: dir, now: NOW }).map((f) => f.id);
  assert.equal(ids.includes('provider_cooldown_skipped'), false);
  assert.equal(ids.includes('lane_outage_unrepaired'), false);
});

test('低成果は実際に秒数を使ったバックエンドへ帰属する（chain の timeout 秒数を末尾へ押し付けない）', () => {
  const rows = [
    { provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash', secs: 6153, out: 0, status: 'timeout',
      chain: [
        { backend: 'gemini-cli', model: 'gemini-3.7-flash', secs: 4953, out: 0, outcome: 'timeout' },
        { backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', secs: 600, out: 0, outcome: 'timeout' }] },
    { provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash', secs: 1425, out: 98, status: 'ok',
      chain: [
        { backend: 'gemini-cli', model: 'gemini-3.7-flash', secs: 637, out: 1149, outcome: 'timeout' },
        { backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', secs: 187, out: 98, outcome: 'ok' }] },
  ];
  assert.equal(lowYieldBackends(rows).size, 0);
});

test('低成果の帰属先は実際に長時間だったバックエンドになる', () => {
  const slow = (secs) => ({ provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash', secs, out: 5,
    chain: [{ backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', secs, out: 5, outcome: 'ok' }] });
  const counts = lowYieldBackends([slow(1200), slow(1300), { provider: 'codex', model: 'gpt-5', secs: 5000, out: 0 }]);
  assert.equal(counts.get('deepseek-v4-flash'), 2);
  assert.equal(counts.size, 1);
});

test('chain を持たない旧形式の fallback 行は行そのままで判定する', () => {
  const counts = lowYieldBackends([{ provider: 'fallback', model: 'gemini-cli', secs: 1000, out: 50 }]);
  assert.equal(counts.get('gemini-cli'), 1);
});

test('低成果の chain 行だけでは fallback_low_yield を起票しない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', [
    { t: '2026-09-09T10:00:00Z', provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash', secs: 1425, out: 98,
      chain: [{ backend: 'gemini-cli', model: 'gemini-3.7-flash', secs: 637, out: 1149, outcome: 'timeout' },
        { backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', secs: 187, out: 98, outcome: 'ok' }] },
    { t: '2026-09-09T10:30:00Z', provider: 'fallback', model: 'cheap-code:deepseek/deepseek-v4-flash', secs: 953, out: 102,
      chain: [{ backend: 'gemini-cli', model: 'gemini-3.7-flash', secs: 846, out: 2289, outcome: 'timeout' },
        { backend: 'cheap-code:deepseek', model: 'deepseek-v4-flash', secs: 106, out: 102, outcome: 'ok' }] },
  ].map(row).join(''));
  const findings = collectFindings({ home: dir, now: NOW });
  assert.equal(findings.filter((f) => f.id === 'fallback_low_yield').length, 0);
});

test('#773 以降の timeout が上限を超えたら夜間に high で検出する', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({
    t: '2026-10-18T10:08:59Z', provider: 'fallback', status: 'timeout', secs: 1800,
    chain: [{ backend: 'gemini-cli', outcome: 'timeout', secs: 1500 }, { backend: 'cheap-code:deepseek', outcome: 'ok', secs: 300 }],
  }));
  const findings = collectFindings({ home: dir, now: new Date('2026-10-19T12:00:00Z'), codexUsedPercent: null });
  const finding = findings.find((f) => f.id === 'timeout_waste_exceeds_cap');
  assert.equal(finding?.severity, 'high');
  assert.deepEqual(finding.evidence, ['1件', '最大試行 1500秒', '上限 900秒', '超過: gemini-cli フォールバック 1500秒/予算900秒']);
});

test('#773 以降の timeout が上限内なら timeout_waste_exceeds_cap を出さない', () => {
  const dir = home();
  write(dir, 'executor-usage.jsonl', row({
    t: '2026-10-19T17:34:53Z', provider: 'codex', status: 'timeout', secs: 600.502, exitCode: 124,
  }));
  const findings = collectFindings({ home: dir, now: new Date('2026-10-19T20:00:00Z'), codexUsedPercent: null });
  assert.equal(findings.find((f) => f.id === 'timeout_waste_exceeds_cap'), undefined);
});

test('timeoutWasteSummary は上限内でも配備後の timeout を report に残す（再発時の効果判定用）', () => {
  const summary = timeoutWasteSummary([
    { t: '2026-10-18T10:08:59Z', provider: 'fallback', status: 'timeout', secs: 1800, chain: [{ backend: 'gemini-cli', outcome: 'timeout', secs: 900 }, { backend: 'cheap-code:deepseek', outcome: 'timeout', secs: 899 }] },
    { t: '2026-10-19T17:34:53Z', provider: 'codex', status: 'timeout', secs: 600.502, exitCode: 124 },
  ]);
  assert.equal(summary.verdict, 'waste-within-cap');
  assert.equal(summary.postDeployTimeoutRows, 2);
  assert.equal(summary.overCapRows, 0);
  assert.equal(summary.maxAttemptSecs, 900);
  assert.equal(summary.lastPostDeployTimeoutAt, '2026-10-19T17:34:53.000Z');
});
