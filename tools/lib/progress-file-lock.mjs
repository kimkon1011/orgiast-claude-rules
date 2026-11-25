import fs from 'node:fs';
import path from 'node:path';

export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let n = 0; n < 2; n++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!(pid > 0)) return null;
      try { process.kill(pid, 0); return null; }
      catch (error) { if (error.code !== 'ESRCH') return null; fs.unlinkSync(file); }
    }
  }
  return null;
}

