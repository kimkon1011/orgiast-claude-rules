import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvText } from './env-kv.mjs';
import { resolveReporterLabel } from './reporter-label.mjs';

test('他機のREPORTER_HOSTなら現在のhostnameへ自動修正する', () => {
  const result = resolveReporterLabel({
    envText: 'REPORTER_LABEL=other-pc\nREPORTER_HOST=other-pc\n',
    hostname: 'current-pc',
  });
  assert.equal(result.label, 'current-pc');
  assert.equal(result.reason, 'copied-from-other-host');
  assert.deepEqual(parseEnvText(result.nextEnvText), {
    REPORTER_LABEL: 'current-pc',
    REPORTER_HOST: 'current-pc',
  });
});

test('REPORTER_HOSTなしで既存ラベルがあれば採用してhostを追記する', () => {
  const result = resolveReporterLabel({ envText: 'REPORTER_LABEL=受付PC\n', hostname: 'current-pc' });
  assert.equal(result.label, '受付PC');
  assert.equal(result.reason, 'adopted');
  assert.equal(result.nextEnvText, 'REPORTER_LABEL=受付PC\nREPORTER_HOST=current-pc\n');
});

test('REPORTER_HOSTもREPORTER_LABELもなければhostnameをラベルにする', () => {
  const result = resolveReporterLabel({ envText: '', hostname: 'current-pc' });
  assert.equal(result.label, 'current-pc');
  assert.equal(result.reason, 'adopted');
  assert.equal(result.nextEnvText, 'REPORTER_HOST=current-pc');
});

test('REPORTER_HOSTが一致すれば文字列を一切書き換えない', () => {
  const envText = 'export REPORTER_HOST = "current-pc"\nREPORTER_LABEL=受付PC\n';
  const result = resolveReporterLabel({ envText, hostname: 'current-pc' });
  assert.equal(result.label, '受付PC');
  assert.equal(result.reason, 'ok');
  assert.strictEqual(result.nextEnvText, envText);
});

test('自動修正してもコメント行と他のキーを保持する', () => {
  const envText = '# cost reporter\nDISCORD_COST_WEBHOOK=https://example.invalid/dummy\nREPORTER_LABEL=old\nREPORTER_HOST=old-host\nOTHER_KEY=keep\n';
  const result = resolveReporterLabel({ envText, hostname: 'new-host' });
  assert.match(result.nextEnvText, /^# cost reporter$/m);
  assert.match(result.nextEnvText, /^DISCORD_COST_WEBHOOK=https:\/\/example\.invalid\/dummy$/m);
  assert.match(result.nextEnvText, /^OTHER_KEY=keep$/m);
  assert.equal(parseEnvText(result.nextEnvText).REPORTER_LABEL, 'new-host');
  assert.equal(parseEnvText(result.nextEnvText).REPORTER_HOST, 'new-host');
});
