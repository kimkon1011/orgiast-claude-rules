import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function providerCooldownPath(file) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  return file || path.join(home, '.claude', 'provider-cooldown.json');
}

export function providerCooldownEnabled(file) {
  return file != null || !process.env.NODE_TEST_CONTEXT;
}

export function readProviderCooldowns(file) {
  if (!providerCooldownEnabled(file)) return {};
  try { return JSON.parse(fs.readFileSync(providerCooldownPath(file), 'utf8')); }
  catch { return {}; }
}

export function writeProviderCooldowns(cooldowns, file) {
  if (!providerCooldownEnabled(file)) return;
  const target = providerCooldownPath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(cooldowns, null, 2)}\n`);
}

export function activeProviderCooldown(provider, { cooldownFile, now = Date.now() } = {}) {
  const state = readProviderCooldowns(cooldownFile)?.[provider];
  return Number(state?.until) > now ? state : null;
}

export function setProviderCooldown(provider, state, { cooldownFile } = {}) {
  if (!providerCooldownEnabled(cooldownFile)) return;
  const cooldowns = readProviderCooldowns(cooldownFile);
  cooldowns[provider] = state;
  writeProviderCooldowns(cooldowns, cooldownFile);
}

export function nextUtcDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
