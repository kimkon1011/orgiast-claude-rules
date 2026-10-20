/** Calendar arithmetic is UTC-based to avoid execution timezone/DST shifts. */
function _CaseApi_calendarDate(text, fallbackYear) {
  var value = String(text || '').normalize('NFKC').trim();
  var full = /^(\d{4})(?:年|[\/.-])(\d{1,2})(?:月|[\/.-])(\d{1,2})(?!\d)/.exec(value);
  var short = !full && /^(\d{1,2})(?:月|\/)(\d{1,2})(?!\d)/.exec(value);
  if (!full && (!short || !fallbackYear)) return null;
  var y = full ? Number(full[1]) : fallbackYear, m = Number(full ? full[2] : short[1]), d = Number(full ? full[3] : short[2]);
  var date = new Date(Date.UTC(y, m - 1, d));
  return y >= 2020 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

function CaseApi_constructionFields(c, overview, master) {
  function text(value) { return _CaseApi_formatDate(value); }
  var eventDates = text(master.eventDates) || overview.eventDate || [text(c.startDate), text(c.endDate)].filter(Boolean).join('〜');
  var eventSource = text(master.eventDates) ? 'master' : overview.eventDate ? 'overview' : eventDates ? 'caseListFallback' : '';
  var start = _CaseApi_calendarDate(text(c.startDate));
  var first = _CaseApi_calendarDate(eventDates, start && start.getUTCFullYear()) || start;
  var year = first && first.getUTCFullYear();
  function explicit(value) {
    var v = text(value);
    if (_CaseApi_calendarDate(v, year)) return v;
    /* A yearless but valid explicit day is useful even without an event year. */
    if (!year && /^\d{1,2}(?:月|\/)\d{1,2}(?!\d)/.test(v) && _CaseApi_calendarDate(v, 2024)) return v;
    return '';
  }
  var setup = explicit(master.setupDate) || explicit(overview.setupDate) || explicit(c.setupDate);
  var source = explicit(master.setupDate) ? 'master' : explicit(overview.setupDate) ? 'overview' : setup ? 'caseList' : '';
  var estimated = false;
  if (!setup && first) {
    var previous = new Date(first.getTime() - 86400000);
    setup = previous.toISOString().slice(0, 10).replace(/-/g, '/');
    source = 'eventStartMinusOneDay'; estimated = true;
  }
  var teardown = explicit(overview.teardownDate) || explicit(c.teardownDate);
  var teardownSource = explicit(overview.teardownDate) ? 'overview' : teardown ? 'caseList' : '';
  if (!teardown) {
    teardown = text(c.endDate) || _CaseApi_lastDate(eventDates, year ? new Date(year, 0, 1) : '');
    teardownSource = teardown ? 'eventEnd' : '';
  }
  var loadIn = explicit(overview.loadInDate) || explicit(c.loadInDate);
  return { setupDate: setup, setupDateSource: source, estimated: estimated,
    eventDates: eventDates, eventDatesSource: eventSource,
    loadInDate: loadIn || setup, loadInDateSource: loadIn ? (explicit(overview.loadInDate) ? 'overview' : 'caseList') : setup ? 'setupDateFallback' : '',
    teardownDate: teardown, teardownDateSource: teardownSource,
    producer: master.producer || c.producer || c.producerName || overview.producer || '' };
}

/** Same authenticated GET path, without network calls or writes. */
function _debug_caseApiPayload(caseId) {
  var result = _CaseApi_dispatch({ parameter: { caseId: caseId, token: _CaseApi_expectedToken() } });
  return JSON.parse(result.getContent());
}
