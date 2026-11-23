export function isCollapsedWindowsPath(name) {
  return /^[A-Za-z]:/.test(name) && !/[\\/]/.test(name);
}

export function filterCollapsedWindowsPaths(names, { log = console.error } = {}) {
  return names.filter(name => {
    if (!isCollapsedWindowsPath(name)) return true;
    log(`skip collapsed path: ${name}`);
    return false;
  });
}
