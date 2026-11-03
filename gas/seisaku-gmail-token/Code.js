const RELAY_SECRET = '__RELAY_SECRET__';
function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return json_({ok: true, service: 'seisaku-gmail-token', user: Session.getEffectiveUser().getEmail()});
}
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (_) { return json_({ok: false, error: 'unauthorized'}); }
  const secret = PropertiesService.getScriptProperties().getProperty('RELAY_SECRET') || RELAY_SECRET;
  if (!secret || secret === '__RELAY_SECRET__' || !body || body.secret !== secret) return json_({ok: false, error: 'unauthorized'});
  GmailApp.getAliases();
  return json_({ok: true, user: Session.getEffectiveUser().getEmail(), accessToken: ScriptApp.getOAuthToken(), expiresInSec: 3300});
}
