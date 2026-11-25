import { parseEnvText, upsertEnvValue } from './env-kv.mjs';

// 【不変条件】呼び出し側は全員 hostname に `os.hostname()` を渡すこと。
// 片方だけ Windows の COMPUTERNAME を渡すと、両者が互いを「他機からのコピー」と判定して
// 毎回 REPORTER_HOST / REPORTER_LABEL を書き換え合う（label が毎回変わりシート行が増殖する）。
export function resolveReporterLabel({ envText, hostname }) {
  const source = String(envText ?? '');
  const currentHostname = String(hostname ?? '');
  const env = parseEnvText(source);

  if (env.REPORTER_HOST && env.REPORTER_HOST !== currentHostname) {
    let nextEnvText = upsertEnvValue(source, 'REPORTER_HOST', currentHostname);
    nextEnvText = upsertEnvValue(nextEnvText, 'REPORTER_LABEL', currentHostname);
    return { label: currentHostname, nextEnvText, reason: 'copied-from-other-host' };
  }

  if (!env.REPORTER_HOST) {
    return {
      label: env.REPORTER_LABEL || currentHostname,
      nextEnvText: upsertEnvValue(source, 'REPORTER_HOST', currentHostname),
      reason: 'adopted',
    };
  }

  return { label: env.REPORTER_LABEL || currentHostname, nextEnvText: source, reason: 'ok' };
}
