export const STATUS_VALUES = Object.freeze(['new', 'contacted', 'accepted', 'cancelled']);

export const SERVICE_KEYS = Object.freeze([
  'booth_design',
  'equipment_rental',
  'furniture_rental',
  'interpretation',
  'interpreter_staffing',
  'catering',
  'shipping_storage',
  'marketing_printing',
  'other',
]);

export const BOOTH_OPTIONS = Object.freeze([
  'undecided',
  '6m2',
  '9m2',
  '12m2',
  '18m2',
  '24m2',
  '36m2',
  'other',
]);

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => (typeof v === 'string' ? v.trim() : '');

export function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return false;
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validEmail(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function validUrl(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return true;
  try {
    const url = s.startsWith('http://') || s.startsWith('https://') ? s : `https://${s}`;
    const parsed = new URL(url);
    return parsed.hostname.includes('.');
  } catch {
    return false;
  }
}

export function validateEntry(input) {
  const raw = record(input) ? input : {};
  const errors = [];

  const companyName = string(raw.companyName);
  if (!companyName) {
    errors.push({ field: 'companyName', messageKey: 'errors.required' });
  }

  const country = string(raw.country);
  if (!country) {
    errors.push({ field: 'country', messageKey: 'errors.required' });
  }

  const contactPerson = string(raw.contactPerson);
  if (!contactPerson) {
    errors.push({ field: 'contactPerson', messageKey: 'errors.required' });
  }

  const email = string(raw.email);
  if (!email) {
    errors.push({ field: 'email', messageKey: 'errors.required' });
  } else if (!validEmail(email)) {
    errors.push({ field: 'email', messageKey: 'errors.email' });
  }

  const website = string(raw.website);
  if (website && !validUrl(website)) {
    errors.push({ field: 'website', messageKey: 'errors.url' });
  }

  const exhibitionName = string(raw.exhibitionName);
  if (!exhibitionName) {
    errors.push({ field: 'exhibitionName', messageKey: 'errors.required' });
  }

  const boothSize = string(raw.boothSize);
  if (boothSize === 'other') {
    const boothSizeOther = string(raw.boothSizeOther);
    if (!boothSizeOther) {
      errors.push({ field: 'boothSizeOther', messageKey: 'errors.required' });
    }
  }

  const periodUndecided = Boolean(raw.periodUndecided);
  if (!periodUndecided) {
    const startDate = string(raw.startDate);
    const endDate = string(raw.endDate);

    if (startDate && !validDate(startDate)) {
      errors.push({ field: 'startDate', messageKey: 'errors.invalidDate' });
    }
    if (endDate && !validDate(endDate)) {
      errors.push({ field: 'endDate', messageKey: 'errors.invalidDate' });
    }
    if (startDate && endDate && validDate(startDate) && validDate(endDate) && endDate < startDate) {
      errors.push({ field: 'endDate', messageKey: 'errors.dateOrder' });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function normalizeEntry(input, fallbackId = '', fallbackNow = '') {
  const raw = record(input) ? input : {};

  let id = string(raw.id);
  if (!id) id = string(fallbackId);

  const companyName = string(raw.companyName);
  const companyNameJa = string(raw.companyNameJa);
  const country = string(raw.country);
  const website = string(raw.website);
  const contactPerson = string(raw.contactPerson);
  const email = string(raw.email);
  const phone = string(raw.phone);
  const exhibitionName = string(raw.exhibitionName);

  let boothSize = string(raw.boothSize);
  if (!BOOTH_OPTIONS.includes(boothSize)) {
    boothSize = 'undecided';
  }
  const boothSizeOther = boothSize === 'other' ? string(raw.boothSizeOther) : '';

  const periodUndecided = Boolean(raw.periodUndecided);
  const startDate = !periodUndecided && validDate(raw.startDate) ? string(raw.startDate) : '';
  const endDate = !periodUndecided && validDate(raw.endDate) ? string(raw.endDate) : '';

  let servicesNeeded = [];
  if (Array.isArray(raw.servicesNeeded)) {
    servicesNeeded = raw.servicesNeeded
      .map(string)
      .filter((s) => SERVICE_KEYS.includes(s));
    servicesNeeded = Array.from(new Set(servicesNeeded));
  }

  const message = string(raw.message);

  let status = string(raw.status);
  if (!STATUS_VALUES.includes(status)) {
    status = 'new';
  }

  let createdAt = string(raw.createdAt);
  if (!createdAt) {
    createdAt = string(fallbackNow);
  }

  return {
    id,
    companyName,
    companyNameJa,
    country,
    website,
    contactPerson,
    email,
    phone,
    exhibitionName,
    boothSize,
    boothSizeOther,
    periodUndecided,
    startDate,
    endDate,
    servicesNeeded,
    message,
    status,
    createdAt,
  };
}

export function createEmptyData() {
  return { version: 1, applications: [] };
}

export function sanitizeLoadedData(parsed) {
  const warnings = [];
  if (!record(parsed)) {
    warnings.push('Data is not a valid JSON object.');
    return { data: createEmptyData(), warnings };
  }

  if (parsed.version !== 1) {
    warnings.push(`Unsupported or missing schema version (${parsed.version}). Defaults applied.`);
  }

  if (!Array.isArray(parsed.applications)) {
    warnings.push('Applications field is missing or not an array. Resetting applications list.');
    return { data: createEmptyData(), warnings };
  }

  const reserved = new Set();
  const applications = [];

  for (let i = 0; i < parsed.applications.length; i++) {
    const item = parsed.applications[i];
    if (!record(item)) {
      warnings.push(`Item at index ${i} is not an object. Skipped.`);
      continue;
    }

    let id = string(item.id);
    if (!id || reserved.has(id)) {
      let counter = 1;
      const base = id || 'app';
      while (reserved.has(`${base}-${counter}`)) counter++;
      id = `${base}-${counter}`;
      warnings.push(`Duplicate or missing ID repaired at index ${i}: assigned '${id}'.`);
    }
    reserved.add(id);

    const normalized = normalizeEntry({ ...item, id }, id);
    applications.push(normalized);
  }

  return {
    data: {
      version: 1,
      applications,
    },
    warnings,
  };
}

export function parseData(jsonText) {
  try {
    if (typeof jsonText !== 'string') throw new TypeError('Expected string input');
    const parsed = JSON.parse(jsonText);
    return sanitizeLoadedData(parsed);
  } catch (err) {
    return {
      data: createEmptyData(),
      warnings: [`Failed to parse JSON text: ${err.message}`],
    };
  }
}

export function serializeData(data) {
  const sanitized = sanitizeLoadedData(data);
  return JSON.stringify(sanitized.data, null, 2);
}

export function entryStats(entries, referenceDate = new Date()) {
  const list = Array.isArray(entries) ? entries : [];
  const refTime = referenceDate instanceof Date ? referenceDate.getTime() : new Date(referenceDate).getTime();
  const validRef = Number.isFinite(refTime) ? refTime : Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  const stats = {
    total: list.length,
    new: 0,
    contacted: 0,
    accepted: 0,
    cancelled: 0,
    recentCount: 0,
  };

  for (const item of list) {
    const st = STATUS_VALUES.includes(item.status) ? item.status : 'new';
    stats[st]++;

    if (item.createdAt) {
      const createdTime = new Date(item.createdAt).getTime();
      if (Number.isFinite(createdTime) && validRef - createdTime <= sevenDaysMs && validRef >= createdTime) {
        stats.recentCount++;
      }
    }
  }

  return stats;
}

function escapeCsvField(val) {
  const str = val === null || val === undefined ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const headers = [
    'ID',
    'Company Name',
    'Company Name (JA)',
    'Country',
    'Website',
    'Contact Person',
    'Email',
    'Phone',
    'Exhibition Name',
    'Booth Size',
    'Booth Size (Other)',
    'Period Undecided',
    'Start Date',
    'End Date',
    'Services Needed',
    'Message',
    'Status',
    'Created At',
  ];

  const rows = [headers.map(escapeCsvField).join(',')];

  for (const raw of list) {
    const item = normalizeEntry(raw, raw.id);
    const row = [
      item.id,
      item.companyName,
      item.companyNameJa,
      item.country,
      item.website,
      item.contactPerson,
      item.email,
      item.phone,
      item.exhibitionName,
      item.boothSize,
      item.boothSizeOther,
      item.periodUndecided ? 'Yes' : 'No',
      item.startDate,
      item.endDate,
      item.servicesNeeded.join('; '),
      item.message,
      item.status,
      item.createdAt,
    ];
    rows.push(row.map(escapeCsvField).join(','));
  }

  return rows.join('\r\n');
}

export function toMarkdown(entries, lang = 'en') {
  const list = Array.isArray(entries) ? entries : [];
  const isJa = lang === 'ja';

  const title = isJa ? '# 展示会出展申込一覧' : '# Trade Show Exhibition Applications';
  if (list.length === 0) {
    return `${title}\n\n${isJa ? '（登録データなし）' : '(No applications registered)'}\n`;
  }

  const headers = isJa
    ? ['ID', '会社名', '国/地域', '担当者', 'Email', '展示会名', 'ブース規模', 'ステータス', '受付日時']
    : ['ID', 'Company Name', 'Country', 'Contact', 'Email', 'Exhibition', 'Booth Size', 'Status', 'Created At'];

  const tableHeader = `| ${headers.join(' | ')} |`;
  const tableDivider = `| ${headers.map(() => '---').join(' | ')} |`;

  function escapeMd(text) {
    return String(text)
      .replace(/\|/g, '\\|')
      .replace(/\r\n|\r|\n/g, '<br>');
  }

  const tableRows = list.map((raw) => {
    const item = normalizeEntry(raw, raw.id);
    const ref = item.id.slice(0, 8) || '-';
    const booth = item.boothSize === 'other' ? `Other (${item.boothSizeOther})` : item.boothSize;

    return `| ${[
      escapeMd(ref),
      escapeMd(item.companyName),
      escapeMd(item.country),
      escapeMd(item.contactPerson),
      escapeMd(item.email),
      escapeMd(item.exhibitionName),
      escapeMd(booth),
      escapeMd(item.status),
      escapeMd(item.createdAt.slice(0, 10) || '-'),
    ].join(' | ')} |`;
  });

  return `${title}\n\n${tableHeader}\n${tableDivider}\n${tableRows.join('\n')}\n`;
}
