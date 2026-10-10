// Recipient is explicit: never infer it from a fixed personal account.
export function workspaceUrl(raw, account) {
  if (typeof account !== 'string' || !/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(account)) {
    throw new Error('--authuser <開く人のメール> を指定してください');
  }
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/^\/a\/[^/]+\//, '/');
  url.searchParams.set('authuser', account);
  return url.href;
}
