/**
 * One-time setup: creates Survey A and Survey B (same questions as the
 * original forms plus hidden-purpose `uh` / `variant` fields), sends their
 * responses to this spreadsheet, and writes the survey URL and prefill entry
 * ids to the "setup" tab. Run once from the editor: ▶ Run → setupForms.
 * Running it again does nothing (the created form ids are remembered).
 */

const SURVEY_DESCRIPTION =
  'Thanks for completing the optional assessment! We’d love your feedback as we decide ' +
  'whether it should count toward a Certificate of Completion for this course.';

const SURVEY_QUESTIONS = [
  { scale: ['Too easy', 'Too hard'], title: 'How would you rate the difficulty of the assessment?' },
  { scale: ['Too short', 'Too long'], title: 'How would you rate the length of the assessment?' },
  { scale: ['Not at all', 'Very confident'], title: 'How confident are you that passing this assessment shows you’ve mastered the material?' },
  { scale: ['Very unlikely', 'Very likely'], title: 'How likely would you be to subscribe to a PRO membership to earn a Certificate of Completion if this assessment was offered?' },
  { paragraph: true, title: 'What would make this assessment more valuable to you?' },
];

const AUTO_FIELD_HELP = 'Filled in automatically. Please do not change.';

function setupForms() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FORMS_CREATED')) {
    Logger.log('Forms already created; see the "setup" tab.');
    return;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = [['variant', 'survey_url', 'uh_entry', 'variant_entry', 'form_edit_url', 'form_id']];

  ['A', 'B'].forEach(function (variant) {
    const form = FormApp.create('Assessment Survey ' + variant);
    form.setDescription(SURVEY_DESCRIPTION);
    try { form.setRequireLogin(false); } catch (e) { Logger.log('setRequireLogin: ' + e); }
    form.setCollectEmail(false);

    SURVEY_QUESTIONS.forEach(function (q) {
      if (q.paragraph) {
        form.addParagraphTextItem().setTitle(q.title);
      } else {
        form.addScaleItem().setTitle(q.title).setBounds(1, 5).setLabels(q.scale[0], q.scale[1]);
      }
    });
    const uh = form.addTextItem().setTitle('uh').setHelpText(AUTO_FIELD_HELP);
    const vr = form.addTextItem().setTitle('variant').setHelpText(AUTO_FIELD_HELP);

    form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
    form.setAcceptingResponses(true);
    try { form.setPublished(true); } catch (e) { Logger.log('setPublished: ' + e); }

    const prefilled = form.createResponse()
      .withItemResponse(uh.createResponse('UH'))
      .withItemResponse(vr.createResponse('VAR'))
      .toPrefilledUrl();
    const uhEntry = (prefilled.match(/(entry\.\d+)=UH/) || [])[1] || '';
    const varEntry = (prefilled.match(/(entry\.\d+)=VAR/) || [])[1] || '';

    rows.push([variant, form.getPublishedUrl(), uhEntry, varEntry, form.getEditUrl(), form.getId()]);
  });

  let sh = ss.getSheetByName('setup');
  if (!sh) sh = ss.insertSheet('setup');
  sh.clear();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  props.setProperty('FORMS_CREATED', '1');
  Logger.log(JSON.stringify(rows));
}
