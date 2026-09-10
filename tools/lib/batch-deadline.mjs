export function batchDeadline(now = new Date(), value = process.env.ORGIAST_BATCH_DEADLINE || '06:30') {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`ORGIAST_BATCH_DEADLINE is invalid: ${value}`);
  const deadline = new Date(now);
  deadline.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return deadline;
}
