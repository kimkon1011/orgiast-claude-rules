// Recurring session crons outlive their turn, so they count for 7 days unless deleted.
const CRON_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The result text names the job; fall back to the tool_use id when the wording changes.
function cronJobId(content, fallback) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return text.match(/Scheduled\s+recurring\s+job\s*[:#]?\s*<?([\w-]+)>?/i)?.[1] || fallback;
}

// Replay only real conversation rows; API request blobs and sidechains are not calls.
export function sessionWakeupEvidence(raw, now = Date.now()) {
  const calls = new Map();
  const tasks = new Map();
  // job id -> { at: expiry, toolId }; pendingCrons holds CronCreate calls awaiting their result.
  const crons = new Map();
  const pendingCrons = new Map();
  let wakeup;
  for (const line of String(raw || '').split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain || !['assistant', 'user'].includes(entry.type)) continue;
    const content = entry.message?.content;
    const parts = Array.isArray(content) ? content : [];
    if (entry.type === 'assistant') for (const tool of parts) {
      if (tool?.type !== 'tool_use') continue;
      if (tool.name === 'TaskStop') tasks.delete(tool.input?.task_id);
      if (tool.name === 'ScheduleWakeup') {
        wakeup = { id: tool.id, at: NaN };
        const delay = tool.input?.delaySeconds;
        if (tool.input?.stop !== true && Number.isFinite(delay) && entry.timestamp) {
          wakeup.at = Date.parse(entry.timestamp) + delay * 1000;
        }
      }
      if (tool.name === 'Monitor' || (tool.name === 'Bash' && tool.input?.run_in_background === true)) {
        if (tool.id) tasks.set(tool.id, tool.id);
      }
      // One-shot crons are not periodic checks, so only recurring ones count.
      if (tool.name === 'CronCreate' && tool.input?.recurring !== false) {
        const created = Date.parse(entry.timestamp || '');
        if (tool.id && Number.isFinite(created)) pendingCrons.set(tool.id, created + CRON_TTL_MS);
      }
      if (tool.name === 'CronDelete') {
        const deleted = tool.input?.id ?? tool.input?.job_id ?? tool.input?.jobId ?? tool.input?.name;
        if (deleted) {
          for (const [id, cron] of crons) if (id === deleted || cron.toolId === deleted) crons.delete(id);
          pendingCrons.delete(deleted);
        }
      }
      if (tool.id) calls.set(tool.id, tool);
    }
    if (entry.type !== 'user') continue;
    for (const result of parts) {
      if (result?.type !== 'tool_result') continue;
      const tool = calls.get(result.tool_use_id);
      if (!tool) continue;
      if (result.is_error) {
        tasks.delete(tool.id);
        pendingCrons.delete(tool.id);
        if (wakeup?.id === tool.id) wakeup.at = NaN;
        continue;
      }
      if (pendingCrons.has(tool.id)) {
        const at = pendingCrons.get(tool.id);
        pendingCrons.delete(tool.id);
        crons.set(cronJobId(result.content, tool.id), { at, toolId: tool.id });
      }
      const data = entry.toolUseResult;
      if (wakeup?.id === tool.id && tool.input?.stop !== true && Number.isFinite(data?.scheduledFor)) wakeup.at = data.scheduledFor;
      const taskId = data?.taskId || data?.task_id || data?.backgroundTaskId
        || String(result.content || '').match(/(?:task[_ ]?id|background(?: task)? id)[:= ]+([\w-]+)/i)?.[1];
      if (tasks.has(tool.id) && taskId) {
        tasks.delete(tool.id);
        tasks.set(taskId, tool.id);
      }
    }
    const text = typeof content === 'string' ? content : parts.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
    for (const notification of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
      const id = notification[0].match(/<task-id>([^<]+)<\/task-id>/)?.[1];
      const status = notification[0].match(/<status>([^<]+)<\/status>/)?.[1];
      if (id && /^(completed|stopped|failed)$/.test(status)) tasks.delete(id);
    }
  }
  const cron = [...crons.values()].some(entry => Number.isFinite(entry.at) && entry.at > now);
  return { scheduled: Number.isFinite(wakeup?.at) && wakeup.at > now, background: tasks.size > 0, cron };
}
