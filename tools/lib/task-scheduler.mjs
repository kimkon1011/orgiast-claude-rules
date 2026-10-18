import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platformName, homeDir } from './platform.mjs';

const taskName = name => {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) throw new Error('Invalid task name');
  return `orgiast-${name}`;
};
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
// Windows CommandLineToArgvW quoting (the command itself is a command line).
const winQuote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
const unitQuote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
const systemdAvailable = () => fs.existsSync('/run/systemd/system');
const unitDir = () => path.join(homeDir(), '.config', 'systemd', 'user');
function run(executable, args, input) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, input });
  if (result.error || result.status !== 0) throw result.error || new Error(`${executable}: ${result.stderr || result.stdout || result.status}`);
  return result.stdout;
}
function readCron() {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && /no crontab for/i.test(result.stderr)) return '';
  throw new Error(`crontab: ${result.stderr || result.status}`);
}
function cleanCron(text, name) {
  return text.split('\n').filter(line => !line.endsWith(` # ${name}`)).join('\n').replace(/\n*$/, '\n');
}
function validate(spec) {
  const name = taskName(spec.name);
  const { command, args = [], schedule = {} } = spec;
  if (typeof command !== 'string' || !command.trim() || /[\r\n\0]/.test(command)) throw new Error('Invalid command');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg))) throw new Error('args must be single-line strings');
  if (Object.keys(schedule).some(key => !['at', 'every', 'onLogon'].includes(key)) || Object.keys(schedule).length !== 1) throw new Error('Choose exactly one schedule: at, every, onLogon');
  let minutes;
  if ('at' in schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.at)) throw new Error('at must be HH:MM');
  if ('onLogon' in schedule && schedule.onLogon !== true) throw new Error('onLogon must be true');
  if ('every' in schedule) {
    const match = /^(\d+)(m|h)$/.exec(schedule.every);
    minutes = match && Number(match[1]) * (match[2] === 'h' ? 60 : 1);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1439) throw new Error('every must be 1m..1439m (or equivalent hours)');
  }
  return { name, command, args, schedule, minutes };
}

// Pure generation: no files, subprocesses or systemd detection. Pass platform explicitly
// for reproducible callers; register() supplies the platform override by default.
export function registrationPlan(spec, { platform = 'linux', backend = 'systemd' } = {}) {
  const { name, command, args, schedule, minutes } = validate(spec);
  if (platform === 'win32') {
    const line = [command, ...args.map(winQuote)].join(' ');
    const argv = ['/Create', '/TN', name, '/TR', line, '/F', '/RL', 'LIMITED', '/IT'];
    if (schedule.at) argv.push('/SC', 'DAILY', '/ST', schedule.at);
    else if (minutes) argv.push('/SC', 'MINUTE', '/MO', String(minutes));
    else argv.push('/SC', 'ONLOGON');
    return { name, argv, text: `schtasks ${argv.map(winQuote).join(' ')}\n` };
  }
  if (platform !== 'linux') throw new Error(`Unsupported scheduler platform: ${platform}`);
  const line = [command, ...args.map(shellQuote)].join(' ');
  if (backend === 'cron') {
    let timing = '@reboot';
    if (schedule.at) {
      const [hour, minute] = schedule.at.split(':').map(Number);
      timing = `${minute} ${hour} * * *`;
    } else if (minutes) {
      if (minutes < 60 && 60 % minutes === 0) timing = `*/${minutes} * * * *`;
      else if (minutes % 60 === 0 && 24 % (minutes / 60) === 0) timing = `0 */${minutes / 60} * * *`;
      else throw new Error('cron fallback requires an interval dividing an hour or a day');
    }
    // cron interprets % even inside shell quotes. Escape after shell quoting.
    const entry = `${timing} /bin/sh -lc ${shellQuote(line).replaceAll('%', '\\%')} # ${name}`;
    return { name, entry, text: `${entry}\n` };
  }
  if (backend !== 'systemd') throw new Error(`Unknown backend: ${backend}`);
  const service = `[Unit]\nDescription=${name}\n\n[Service]\nType=oneshot\nExecStart=/bin/sh -lc ${unitQuote(line)}\n`;
  // onLogon means user-manager startup; with lingering it can start at boot.
  const trigger = schedule.at ? `OnCalendar=*-*-* ${schedule.at}:00\nPersistent=true` : minutes ? `OnActiveSec=${minutes}min\nOnUnitActiveSec=${minutes}min` : 'OnActiveSec=1s';
  const timer = `[Unit]\nDescription=${name} timer\n\n[Timer]\n${trigger}\nUnit=${name}.service\n\n[Install]\nWantedBy=timers.target\n`;
  return { name, service, timer, text: `# ${name}.service\n${service}\n# ${name}.timer\n${timer}` };
}

export function register(spec, options = {}) {
  const dryRun = options.dryRun ?? spec.dryRun ?? false;
  const platform = platformName();
  const backend = options.backend ?? (dryRun || systemdAvailable() ? 'systemd' : 'cron');
  const plan = registrationPlan(spec, { platform, backend });
  if (dryRun) return plan.text;
  if (platform === 'win32') {
    run('schtasks', plan.argv);
    return run('schtasks', ['/Query', '/TN', plan.name]);
  }
  if (backend === 'cron') {
    run('crontab', ['-'], cleanCron(readCron(), plan.name) + plan.entry + '\n');
    return plan.text;
  }
  fs.mkdirSync(unitDir(), { recursive: true });
  for (const suffix of ['service', 'timer']) fs.writeFileSync(path.join(unitDir(), `${plan.name}.${suffix}`), plan[suffix]);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', `${plan.name}.timer`]);
  // Restart updates the schedule when overwriting an already running timer.
  run('systemctl', ['--user', 'restart', `${plan.name}.timer`]);
  run('loginctl', ['enable-linger', os.userInfo().username]);
  return plan.text;
}
export function unregister(name, { dryRun = false } = {}) {
  const task = taskName(name);
  const platform = platformName();
  if (platform === 'win32') {
    if (dryRun) return `schtasks /Delete /TN ${task} /F\n`;
    return run('schtasks', ['/Delete', '/TN', task, '/F']);
  }
  if (platform !== 'linux') throw new Error(`Unsupported scheduler platform: ${platform}`);
  if (dryRun) return `systemctl --user disable --now ${task}.timer\nRemove ${task}.service and ${task}.timer from ${unitDir()}\nsystemctl --user daemon-reload\nWithout systemd: remove crontab entry ending in # ${task}\n`;
  if (!systemdAvailable()) {
    run('crontab', ['-'], cleanCron(readCron(), task));
    return task;
  }
  run('systemctl', ['--user', 'disable', '--now', `${task}.timer`]);
  run('systemctl', ['--user', 'stop', `${task}.service`]);
  for (const suffix of ['service', 'timer']) fs.rmSync(path.join(unitDir(), `${task}.${suffix}`), { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  return task;
}
export function list() {
  if (platformName() === 'win32') return run('schtasks', ['/Query', '/FO', 'CSV', '/NH']).split(/\r?\n/).filter(line => /^"\\?orgiast-/.test(line)).join('\n');
  if (platformName() !== 'linux') throw new Error(`Unsupported scheduler platform: ${platformName()}`);
  if (systemdAvailable()) return run('systemctl', ['--user', 'list-timers', '--all', 'orgiast-*.timer', '--no-pager']);
  return readCron().split('\n').filter(line => / # orgiast-[\w-]+$/.test(line)).join('\n');
}
function cli(argv) {
  const sub = argv.shift();
  const spec = { schedule: {}, args: [] };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--on-logon') spec.schedule.onLogon = true;
    else if (arg === '--args') {
      while (i + 1 < argv.length && !['--dry-run', '--name', '--command', '--at', '--every', '--on-logon'].includes(argv[i + 1])) spec.args.push(argv[++i]);
    } else if (['--name', '--command', '--at', '--every'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--at' || arg === '--every') spec.schedule[arg.slice(2)] = value;
      else spec[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (sub === 'register') return register(spec, options);
  if (sub === 'unregister') return unregister(spec.name, options);
  if (sub === 'list') return list();
  throw new Error('Usage: task-scheduler.mjs register|unregister|list [options]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(cli(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
