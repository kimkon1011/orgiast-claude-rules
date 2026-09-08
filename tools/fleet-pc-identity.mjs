const clean = (value) => String(value ?? '').trim();
const identityKey = (value) => clean(value).toLocaleLowerCase('ja');

export function pcMapEntries(pcMap = {}) {
  return Object.entries(pcMap).filter(([name, value]) => !name.startsWith('_') && value && typeof value === 'object');
}

export function pcMapNames(label, mapped = {}) {
  return [...new Set([label, mapped.sheetName, mapped.hostname, ...(Array.isArray(mapped.aliases) ? mapped.aliases : [])].map(clean).filter(Boolean))];
}

export function buildPcIdentityIndex(pcMap = {}) {
  const byName = new Map();
  for (const [label, mapped] of pcMapEntries(pcMap)) {
    const identity = { label, mapped, names: pcMapNames(label, mapped) };
    for (const name of identity.names) byName.set(identityKey(name), identity);
  }
  return { byName, find: (name) => byName.get(identityKey(name)) || null };
}

function manualName(row) { return clean(row?.pcName); }
function machineName(row) { return clean(row?.label); }
function isManual(row) { return Boolean(manualName(row)) && !machineName(row) && !clean(row?.hostname) && !clean(row?.reportedAt); }
function isMachine(row) { return Boolean(machineName(row) || clean(row?.hostname) || clean(row?.reportedAt)); }
function rowStaff(row) { return clean(row?.staff ?? row?.staffName ?? row?.person) || stem(manualName(row)); }

function stem(value) {
  return clean(value).normalize('NFKC').replace(/(?:ノートブックコンピュータ|macbook\s*air|macbook|パソコン|pc|ＰＣ)/giu, '').replace(/[\s._-]/g, '').toLocaleLowerCase('ja');
}

function latestRow(rows) {
  return [...rows].sort((a, b) => (Date.parse(b.reportedAt || '') || 0) - (Date.parse(a.reportedAt || '') || 0))[0] || {};
}

// 稼働状態(state)と「手書き行が無い」(manualRowMissing)は別軸。ここに1本化し、
// interaction-rollout と fleet-liveness の両方から使う(二重実装を作らない)。
// 以前は machine-only を state の最優先にしていたため、実際に報告中の PC が reporting に数えられず
// 本番台帳で「PC 20: reporting 1」と実態(4台稼働)を隠した(2026-09-08 実測)。
// parseTime は呼び手の時刻解釈をそのまま使う(rollout は JST 表記を UTC へ、liveness は timeOf)。
// ここで独自に解釈すると 3 日境界の判定が呼び手と食い違う。
export function fleetRowState(row, nowMs, { liveWithinMs = 3 * 24 * 60 * 60 * 1000, parseTime } = {}) {
  const raw = String(row?.reportedAt ?? '').trim();
  const at = typeof parseTime === 'function' ? parseTime(raw) : Date.parse(raw.replace(' ', 'T'));
  const hasAt = raw !== '' && at != null && Number.isFinite(at);
  const state = row?.installedAt && !row?._hasMachine ? 'installed-pending'
    : row?._hasMachine && hasAt && nowMs - at >= 0 && nowMs - at <= liveWithinMs ? 'reporting'
      : row?._hasMachine && hasAt ? 'stale'
        : 'never-reported';
  return { state, manualRowMissing: Boolean(row?._hasMachine && !row?._hasManual) };
}

export function emptyFleetStateCounts() {
  return { reporting: 0, 'installed-pending': 0, 'never-reported': 0, stale: 0, manualRowMissing: 0 };
}

export function reconcileFleetRows(rows, pcMap = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const identityIndex = buildPcIdentityIndex(pcMap);
  const manualCounts = new Map();
  for (const row of source.filter(isManual)) manualCounts.set(identityKey(manualName(row)), (manualCounts.get(identityKey(manualName(row))) || 0) + 1);
  const duplicateManualRows = source.filter((row) => isManual(row) && manualCounts.get(identityKey(manualName(row))) > 1);
  const usable = source.filter((row) => !duplicateManualRows.includes(row));
  const groups = new Map();
  const groupFor = (row) => {
    const names = [manualName(row), machineName(row), clean(row?.hostname)].filter(Boolean);
    const identity = names.map((name) => identityIndex.find(name)).find(Boolean);
    const id = identity ? `map:${identity.label}` : `row:${identityKey(machineName(row) || manualName(row) || clean(row?.hostname))}`;
    if (!groups.has(id)) groups.set(id, { identity, manualRows: [], machineRows: [] });
    return groups.get(id);
  };
  for (const row of usable) {
    const group = groupFor(row);
    if (isManual(row)) group.manualRows.push(row);
    if (isMachine(row)) group.machineRows.push(row);
  }
  const unmatchedManual = source.filter(isManual).filter((row) => !identityIndex.find(manualName(row)));
  const unmatchedMachine = usable.filter(isMachine).filter((row) => ![machineName(row), clean(row?.hostname)].some((name) => identityIndex.find(name)));
  const candidates = [];
  const seen = new Set();
  const addCandidate = (manual, machine, confidence, reason) => {
    const left = manualName(manual); const right = machineName(machine) || clean(machine?.hostname);
    const id = `${left}\0${right}\0${reason}`;
    if (!left || !right || seen.has(id)) return;
    seen.add(id); candidates.push({ manual: left, machine: right, confidence, reason });
  };
  for (const manual of unmatchedManual) for (const machine of unmatchedMachine) {
    const a = stem(manualName(manual)); const b = stem(machineName(machine));
    if (a && b && (a === b || a.includes(b) || b.includes(a))) addCandidate(manual, machine, 'low', `名字/語幹一致: ${a}`);
  }
  for (const manual of unmatchedManual) {
    const staff = rowStaff(manual);
    if (!staff) continue;
    for (const [label, mapped] of pcMapEntries(pcMap)) {
      if (clean(mapped.person) !== staff || clean(mapped.sheetName) === manualName(manual)) continue;
      const machine = source.find((row) => machineName(row) === label) || { label };
      addCandidate(manual, machine, 'medium', `スタッフ名 ${staff} と対応表 person が一致`);
    }
  }
  const reconciled = [...groups.values()].map((group) => {
    const manual = group.manualRows[0] || {};
    const machine = latestRow(group.machineRows);
    const mapped = group.identity?.mapped || {};
    return {
      ...manual, ...machine,
      pcName: manualName(manual) || manualName(machine) || clean(mapped.sheetName),
      label: machineName(machine) || clean(group.identity?.label),
      hostname: clean(machine.hostname) || clean(mapped.hostname),
      installedAt: clean(mapped.installedAt) || undefined,
      _hasManual: group.manualRows.length > 0,
      _hasMachine: group.machineRows.length > 0,
    };
  });
  return { rows: reconciled, duplicateManualRows, candidates };
}
