export function isCollapsedWindowsPath(name) {
  return /^[A-Za-z][:\uF03A]/.test(name) && !/[\\/\uF05C]/.test(name);
}

export function filterCollapsedWindowsPaths(names, { log = console.error } = {}) {
  return names.filter(name => {
    if (!isCollapsedWindowsPath(name)) return true;
    log(`skip collapsed path: ${name}`);
    return false;
  });
}
