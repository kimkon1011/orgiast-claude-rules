// feedback-kit 1.0.0: generated integration (no credentials)
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.form === 'feedback') return FeedbackRelay_serveForm({app: "ブース制作アプリ", src: params.src || ''});
  var output = FeedbackKit_originalDoGet(e);
  if (!output || typeof output.append !== 'function' || typeof output.setTitle !== 'function') return output; // HtmlOutput だけに launcher を足す（TextOutput=JSON には足さない）
  var template = HtmlService.createTemplateFromFile('FeedbackKitLauncher');
  template.feedbackHtml = FeedbackRelay_serveForm({app: "ブース制作アプリ"}).getContent();
  output.append(template.evaluate().getContent());
  return output;
}
