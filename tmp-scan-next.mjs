import fs from 'node:fs';
for (const f of process.argv.slice(2)) {
  try {
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    const v = (p.dependencies && p.dependencies.next) || (p.devDependencies && p.devDependencies.next);
    console.log(`${f} :: next=${v || '(none)'} :: name=${p.name || '?'}`);
  } catch (e) {
    console.log(`${f} :: ERR ${e.message}`);
  }
}
