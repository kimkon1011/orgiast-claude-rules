import cp from 'child_process';
import fs from 'fs';
import path from 'path';

function findTestFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const dirent of list) {
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      results = results.concat(findTestFiles(fullPath));
    } else if (dirent.isFile() && dirent.name.endsWith('.test.mjs')) {
      results.push(fullPath);
    }
  }
  return results;
}

const testFiles = findTestFiles('tools');
console.log('Test files count in tools:', testFiles.length);

// Also check node --test tools/
try {
  console.log('Running node --test tools/**/*.test.mjs or testFiles...');
  const res = cp.spawnSync('node.exe', ['--test', ...testFiles.slice(0, 10)], { encoding: 'utf8', timeout: 60000 });
  console.log('Sample run status:', res.status);
  console.log(res.stdout.split('\n').filter(l => l.includes('pass') || l.includes('fail') || l.includes('tests')).join('\n'));
} catch (e) {
  console.error(e);
}
