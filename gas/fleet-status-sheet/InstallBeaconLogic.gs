// Pure validation and upsert planning; no GAS services required.
const INSTALL_BEACON_HEADERS_ = ['hostname', 'os', 'claudeAccount', 'serial', 'installer', 'firstSeenAt', 'lastSeenAt', 'count'];

function installBeaconValidate(payload, rawLength) {
  if (rawLength > 2048) return { ok: false, status: 413, error: 'too_large' };
  const rules = {
    hostname: { max: 64, pattern: /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u },
    os: { max: 64, pattern: /^[A-Za-z0-9._ -]+$/ },
    claudeAccount: { max: 128, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, optional: true },
    serial: { max: 20, pattern: /^[A-Za-z0-9]{5,20}$/, optional: true },
    installer: { max: 36, pattern: /^(sh|ps1)-[A-Za-z0-9._-]{1,32}$/ }
  };
  const value = {};
  for (const field of Object.keys(rules)) {
    const rule = rules[field];
    const input = payload[field] === undefined && rule.optional ? '' : payload[field];
    if (typeof input !== 'string' || input.length > rule.max ||
        !(rule.optional && input === '') && !rule.pattern.test(input)) {
      return { ok: false, status: 400, error: 'invalid_' + field };
    }
    value[field] = input;
  }
  return { ok: true, value: value };
}

function installBeaconPlan(rows, value, nowIso) {
  const index = rows.findIndex(function(row) { return row.hostname.toLowerCase() === value.hostname.toLowerCase(); });
  if (index < 0 && rows.length >= 500) return { ok: false, status: 429, error: 'full' };
  const prior = index < 0 ? null : rows[index];
  const row = Object.assign({}, value, {
    hostname: prior ? prior.hostname : value.hostname,
    firstSeenAt: prior ? prior.firstSeenAt : nowIso,
    lastSeenAt: nowIso,
    count: prior ? Number(prior.count) + 1 : 1
  });
  return { ok: true, action: prior ? 'updated' : 'created', index: prior ? index : rows.length, row: row };
}
