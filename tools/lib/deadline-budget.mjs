// A finite positive timeout only; process budgets may be shortened, never extended.
export function budgetMs(value, fallback, maximum = Infinity) {
  const parsed = Number(value);
  return Math.min(maximum, Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : fallback);
}

export function withAbort(signal, operation) {
  if (!signal) return Promise.resolve().then(operation);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
