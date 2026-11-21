import { laneDoctorProbe, runNativeWriteProbe } from './tools/lane-doctor.mjs';
import os from 'node:os';
const home = os.homedir();
const write = await runNativeWriteProbe({ home, timeoutMs: 90000 });
console.log('WRITE_PROBE', JSON.stringify({ code: write.code, text: String(write.text||'').slice(0,300), timedOut: write.timedOut }));
if (write.code !== 0) process.exit(1);
const health = await laneDoctorProbe({
  home,
  budgetMs: 60000,
  nativeWriteProbe: async () => ({ code: 0, text: 'WRITE_OK', nativeRepair: true }),
  providers: ['codex'],
  probeRetries: 0,
});
console.log('HEALTH_CODEX', JSON.stringify(health.lanes?.codex && { alive: health.lanes.codex.alive, reason: health.lanes.codex.reason, probeReason: health.lanes.codex.probeReason }));
process.exit(health.lanes?.codex?.alive ? 0 : 2);
