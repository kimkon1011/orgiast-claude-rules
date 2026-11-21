#!/usr/bin/env node
import fs from 'node:fs';

// 1. Fix fleet-mail.mjs
let mail = fs.readFileSync('tools/fleet-mail.mjs', 'utf8');

const isFleetHubEnd = `export function isFleetHub(label, config) {
  return label === (config.FLEET_HUB || HUB_LABEL);
}`;

const isHubSenderFn = `export function isFleetHub(label, config) {
  return label === (config.FLEET_HUB || HUB_LABEL);
}

/**
 * 送信元ラベルが FLEET_HUB の PC からのものかを判定（別名対応）。
 * @param {string} from - 送信元ラベル（mail.from）
 * @param {object} config - fleet-sheet.env のパース結果（FLEET_HUB を含む）
 * @param {object} [pcMap] - fleet-pc-map.json の内容（別名解決に使用）
 * @returns {boolean}
 */
export function isHubSender(from, config, pcMap = {}) {
  if (!config.FLEET_HUB) return false;
  if (from === config.FLEET_HUB) return true;
  // FLEET_HUB が HUB_LABEL（kim-PC）の場合、pcMap の別名も許容（大小文字無視）
  if (config.FLEET_HUB === HUB_LABEL && pcMap && typeof pcMap === 'object') {
    const hubEntry = pcMap[HUB_LABEL];
    if (!hubEntry || typeof hubEntry !== 'object') return false;
    const hostname = String(hubEntry.hostname || '').toLowerCase();
    const aliases = (Array.isArray(hubEntry.aliases) ? hubEntry.aliases : []).map(a => String(a).toLowerCase());
    const fromLower = String(from).toLowerCase();
    return fromLower === hostname || aliases.includes(fromLower);
  }
  return false;
}`;

if (!mail.includes('export function isHubSender')) {
  mail = mail.replace(isFleetHubEnd, isHubSenderFn);
  fs.writeFileSync('tools/fleet-mail.mjs', mail, 'utf8');
  console.log('Added isHubSender to fleet-mail.mjs');
} else {
  console.log('isHubSender already in fleet-mail.mjs');
}

// Fix the not-hub check
const oldCheck = "!config.FLEET_HUB || mail.from !== config.FLEET_HUB ? 'not-hub'";
const newCheck = "!isHubSender(mail.from, config, fleetMembers) ? 'not-hub'";
if (mail.includes(oldCheck)) {
  mail = mail.replace(oldCheck, newCheck);
  fs.writeFileSync('tools/fleet-mail.mjs', mail, 'utf8');
  console.log('Fixed not-hub check in fleet-mail.mjs');
} else {
  console.log('not-hub check pattern not found (maybe already fixed)');
}

// 2. Fix fleet-task-runner.mjs
let runner = fs.readFileSync('tools/fleet-task-runner.mjs', 'utf8');

// Add isHubSender to imports
const importLine = "import { validId, classifyExecutionResult, sendExecutionFailure, parseExecMarkers, createClient, resolveFleetLabel, updateInbox, syncMailState, acquireLock, TERMINAL_STATUSES, isMissingClaudeError, missingClaudeMessage } from './fleet-mail.mjs';";
const newImport = "import { validId, classifyExecutionResult, sendExecutionFailure, parseExecMarkers, createClient, resolveFleetLabel, updateInbox, syncMailState, acquireLock, TERMINAL_STATUSES, isMissingClaudeError, missingClaudeMessage, isHubSender } from './fleet-mail.mjs';";
if (runner.includes(importLine) && !runner.includes('isHubSender')) {
  runner = runner.replace(importLine, newImport);
  console.log('Added isHubSender import to fleet-task-runner.mjs');
}

// Add pcMap loading after config
const configLine = "const config = parseEnvText(fs.readFileSync(path.join(dir, 'fleet-sheet.env'), 'utf8'));\n    request ??= createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN });\n    const label = resolveFleetLabel(home);";
const configWithPcMap = "const config = parseEnvText(fs.readFileSync(path.join(dir, 'fleet-sheet.env'), 'utf8'));\n    request ??= createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN });\n    const pcMap = JSON.parse(fs.readFileSync(new URL('../fleet-pc-map.json', import.meta.url), 'utf8'));\n    const label = resolveFleetLabel(home);";
if (runner.includes(configLine) && !runner.includes('pcMap = JSON.parse')) {
  runner = runner.replace(configLine, configWithPcMap);
  console.log('Added pcMap loading to fleet-task-runner.mjs');
}

// Fix the not-hub check in runner
const runnerOldCheck = "!config.FLEET_HUB || mail.from !== config.FLEET_HUB ? 'not-hub'";
const runnerNewCheck = "!isHubSender(mail.from, config, pcMap) ? 'not-hub'";
if (runner.includes(runnerOldCheck)) {
  runner = runner.replace(runnerOldCheck, runnerNewCheck);
  console.log('Fixed not-hub check in fleet-task-runner.mjs');
}

fs.writeFileSync('tools/fleet-task-runner.mjs', runner, 'utf8');

// 3. Fix test file
let testFile = fs.readFileSync('tools/fleet-mail-v2.test.mjs', 'utf8');

const importTestLine = "import { writeJson, windowsLockBusy, WRITE_JSON_RENAME_RETRIES } from './fleet-mail.mjs';";
const newTestImport = "import { writeJson, windowsLockBusy, WRITE_JSON_RENAME_RETRIES, isHubSender } from './fleet-mail.mjs';";
if (testFile.includes(importTestLine) && !testFile.includes('isHubSender')) {
  testFile = testFile.replace(importTestLine, newTestImport);
  console.log('Added isHubSender import to test file');
}

const testBlock = `const sendArgs = (f, to = sender, extra = []) => ['--send', '--to', to, '--kind', 'note', '--body-file', f.body, '--why', 'test', ...extra];

// ---- isHubSender tests ----
test('isHubSender は FLEET_HUB と完全一致するラベルを許容', () => {
  const config = { FLEET_HUB: 'kim-PC' };
  assert.equal(isHubSender('kim-PC', config, {}), true);
});

test('isHubSender は FLEET_HUB=kim-PC で 000KimPC を許容（pcMap の hostname）', () => {
  const config = { FLEET_HUB: 'kim-PC' };
  const pcMap = { 'kim-PC': { hostname: '000KIMPC', aliases: ['DESKTOP-2D0R4LI'] } };
  assert.equal(isHubSender('000KimPC', config, pcMap), true);
});

test('isHubSender は FLEET_HUB=kim-PC で 000KIMPC（大文字）を許容', () => {
  const config = { FLEET_HUB: 'kim-PC' };
  const pcMap = { 'kim-PC': { hostname: '000KIMPC', aliases: ['DESKTOP-2D0R4LI'] } };
  assert.equal(isHubSender('000KIMPC', config, pcMap), true);
});

test('isHubSender は FLEET_HUB=kim-PC で DESKTOP-2D0R4LI（aliases）を許容', () => {
  const config = { FLEET_HUB: 'kim-PC' };
  const pcMap = { 'kim-PC': { hostname: '000KIMPC', aliases: ['DESKTOP-2D0R4LI'] } };
  assert.equal(isHubSender('DESKTOP-2D0R4LI', config, pcMap), true);
});

test('isHubSender は FLEET_HUB=kim-PC で他PC（other-PC）を拒否', () => {
  const config = { FLEET_HUB: 'kim-PC' };
  const pcMap = { 'kim-PC': { hostname: '000KIMPC', aliases: ['DESKTOP-2D0R4LI'] } };
  assert.equal(isHubSender('other-PC', config, pcMap), false);
});

test('isHubSender は FLEET_HUB 未設定で false', () => {
  assert.equal(isHubSender('kim-PC', {}, {}), false);
  assert.equal(isHubSender('kim-PC', { FLEET_HUB: '' }, {}), false);
});

test('isHubSender は FLEET_HUB が kim-PC 以外なら完全一致のみ許容', () => {
  const config = { FLEET_HUB: 'nishi-PC' };
  const pcMap = { 'nishi-PC': { hostname: 'OTHERHOST' } };
  assert.equal(isHubSender('nishi-PC', config, pcMap), true);
  assert.equal(isHubSender('OTHERHOST', config, pcMap), false);
});

test('isHubSender は空 pcMap でも FLEET_HUB 完全一致は許容', () => {
  const config = { FLEET_HUB: 'kim-PC' };
  assert.equal(isHubSender('kim-PC', config, {}), true);
  assert.equal(isHubSender('000KimPC', config, {}), false);
});

test('isHubSender は実際の fleet-pc-map.json で 000KimPC を許容', () => {
  const config = { FLEET_HUB: 'kim-PC' };
  const realPcMap = JSON.parse(fs.readFileSync(new URL('../fleet-pc-map.json', import.meta.url), 'utf8'));
  assert.equal(isHubSender('000KimPC', config, realPcMap), true);
  assert.equal(isHubSender('000KIMPC', config, realPcMap), true);
  assert.equal(isHubSender('DESKTOP-2D0R4LI', config, realPcMap), true);
  assert.equal(isHubSender('other-PC', config, realPcMap), false);
});

test('writeJson writes JSON and removes its temporary file', t => {`;

const oldTestStart = `const sendArgs = (f, to = sender, extra = []) => ['--send', '--to', to, '--kind', 'note', '--body-file', f.body, '--why', 'test', ...extra];

test('writeJson writes JSON and removes its temporary file', t => {`;

if (testFile.includes(oldTestStart) && !testFile.includes('isHubSender は FLEET_HUB')) {
  testFile = testFile.replace(oldTestStart, testBlock);
  fs.writeFileSync('tools/fleet-mail-v2.test.mjs', testFile, 'utf8');
  console.log('Added isHubSender tests');
} else {
  console.log('isHubSender tests already present or pattern not found');
}

console.log('Done');