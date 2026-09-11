export async function readStdinWithTimeout(ms = 4000) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  const timer = setTimeout(() => process.stdin.destroy(), ms);
  timer.unref();
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    // destroy()によるERR_STREAM_PREMATURE_CLOSEはtimeout時の正常な打ち切り。
  } finally {
    clearTimeout(timer);
  }
  return raw;
}
