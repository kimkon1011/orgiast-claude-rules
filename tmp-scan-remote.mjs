import { execFileSync } from 'node:child_process';

const repos = [
  'aujust-gakkai-automation', 'rebooth-lp', 'kaden-call-app', 'assign-app',
  'checklist', 'warehouse-app', 'gakkai-final-check-gas', 'barcode-app',
  'gh-cli-probe-tmp', 'cafe-checklist-app', 'anniversary-mail', 'cr',
];

for (const r of repos) {
  let raw;
  try {
    raw = execFileSync('gh', ['api', `repos/cr568/${r}/contents/package.json`,
      '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.log(`${r} :: (no package.json)`);
    continue;
  }
  try {
    const p = JSON.parse(raw);
    const next = (p.dependencies && p.dependencies.next) || (p.devDependencies && p.devDependencies.next);
    const react = (p.dependencies && p.dependencies.react) || '';
    const rsc = Object.keys({ ...p.dependencies, ...p.devDependencies }).filter(k => k.startsWith('react-server-dom'));
    console.log(`${r} :: next=${next || '(none)'} react=${react} rsc=[${rsc.join(',')}]`);
  } catch { console.log(`${r} :: parse error`); }
}
