// In-memory filesystem shared by Gemini accounting tests. Never touches ~/.claude.
export function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const key = (file) => file instanceof URL ? file.href : String(file);
  const missing = () => Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
  return {
    files, writes,
    readFileSync(file) { if (!files.has(key(file))) throw missing(); return files.get(key(file)); },
    mkdirSync() {},
    appendFileSync(file, text) { writes.push(key(file)); files.set(key(file), (files.get(key(file)) || '') + text); },
    writeFileSync(file, text) { writes.push(key(file)); files.set(key(file), text); },
    renameSync(from, to) { if (!files.has(key(from))) throw missing(); files.set(key(to), files.get(key(from))); files.delete(key(from)); },
    unlinkSync(file) { if (!files.delete(key(file))) throw missing(); },
  };
}
