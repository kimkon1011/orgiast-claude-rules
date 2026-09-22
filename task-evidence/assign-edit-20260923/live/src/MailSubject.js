function Mail_subjectLabel(caseName) {
  if (caseName === null || typeof caseName === 'undefined') return '';
  let label = String(caseName).split(/[\r\n]/)[0];
  label = label.split(' / ')[0];
  label = label.replace(/^[\s　]+|[\s　]+$/g, '').replace(/[\s　]+/g, ' ');
  if (label.length > 30) label = label.slice(0, 29) + '…';
  return label;
}

function Mail_externalSubject(caseId, caseName, purpose, tag) {
  const label = Mail_subjectLabel(caseName);
  return '[' + caseId + ']' + (tag ? '[' + tag + ']' : '') + ' ' + (label ? label + ' ' : '') + purpose;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Mail_subjectLabel: Mail_subjectLabel, Mail_externalSubject: Mail_externalSubject };
}
