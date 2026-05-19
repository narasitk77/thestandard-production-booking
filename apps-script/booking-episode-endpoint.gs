/**
 * Booking → Episode ID  ·  Web App endpoint
 * =========================================
 * DRAFT for ปุ๊ก — paste into the "Dashboard: Production Project 2026"
 * Apps Script project (Extensions → Apps Script), then deploy as a Web App.
 *
 * WHY
 * ---
 * The Production Booking app cannot make the `onEditEpisode` trigger fire —
 * onEdit triggers only run on edits typed in the Sheet UI, never on Sheets
 * API writes. So the app cannot create episodes by writing rows directly.
 *
 * This endpoint lets the booking app ASK the Sheet for an Episode ID. The
 * Sheet's Apps Script stays the SINGLE owner of numbering (the EP_SEQ_*
 * ScriptProperties counter), so booking-created and hand-typed episodes share
 * one continuous sequence — they can never collide.
 *
 * SETUP (ปุ๊ก)
 * -----------
 *  1. Paste this file into the Dashboard sheet's Apps Script project.
 *     (If a doPost() already exists, merge this logic into it.)
 *  2. Project Settings → Script Properties → add:
 *        BOOKING_API_SECRET = <a long random string>
 *  3. Deploy → New deployment → "Web app"
 *        Execute as      : Me (sheet owner)
 *        Who has access  : Anyone
 *  4. Send the Web App URL + the secret to the booking app team (narasit).
 *
 * REQUEST   POST, JSON body:
 *   { "secret": "...", "projectId": "PP-26-008", "type": "L" }
 * RESPONSE  JSON:
 *   { "ok": true,  "episodeId": "PP-26-008-L04" }
 *   { "ok": false, "error": "..." }
 *
 * Reuses helpers already defined in this project:
 *   PROP_EP_SEQ_PREFIX, padLeft_, TYPE_OPTIONS,
 *   autoCreateDirRow_, lookupProjectProducer_, lookupProjectNameById_
 */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // --- shared-secret auth ---
    var secret = PropertiesService.getScriptProperties().getProperty('BOOKING_API_SECRET');
    if (!secret || body.secret !== secret) {
      return _bookingJson_({ ok: false, error: 'unauthorized' });
    }

    // --- validate input ---
    var projectId = String(body.projectId || '').trim();
    var type = String(body.type || '').trim().toUpperCase();
    if (!/^PP-\d{2}-\d{3}$/.test(projectId)) {
      return _bookingJson_({ ok: false, error: 'bad projectId' });
    }
    if (TYPE_OPTIONS.indexOf(type) < 0) {
      return _bookingJson_({ ok: false, error: 'bad type — expect one of ' + TYPE_OPTIONS.join('/') });
    }

    // --- generate under a lock so concurrent bookings never double-number ---
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    var episodeId;
    try {
      episodeId = _generateBookingEpisode_(projectId, type);
    } finally {
      lock.releaseLock();
    }
    return _bookingJson_({ ok: true, episodeId: episodeId });
  } catch (err) {
    return _bookingJson_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * Same numbering + row-creation as the onEditEpisode trigger, but callable
 * over HTTP. Appends the episode to the project's PD tab and mirrors it into
 * the Director tab via the existing autoCreateDirRow_ helper.
 */
function _generateBookingEpisode_(projectId, type) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) next sequence — the SAME counter the onEditEpisode trigger uses
  var props = PropertiesService.getScriptProperties();
  var propKey = PROP_EP_SEQ_PREFIX + projectId + '_' + type;
  var nn = parseInt(props.getProperty(propKey) || '0', 10);
  if (!nn) nn = 1;
  var epId = projectId + '-' + type + padLeft_(nn, 2);
  props.setProperty(propKey, String(nn + 1));

  // 2) locate the project's Producer + their PD tab
  var producer = lookupProjectProducer_(ss, projectId) || '';
  var pdTabName = 'PD ' + producer;
  var pdSheet = ss.getSheetByName(pdTabName);
  if (!pdSheet) throw new Error('PD tab not found: "' + pdTabName + '"');

  // 3) append the episode row to the PD tab
  //    PD columns: 1 Project ID · 2 Episode Type · 3 Episode ID · 4 Project Name
  //    NOTE for ปุ๊ก: confirm these column numbers match the live PD layout.
  var row = Math.max(pdSheet.getLastRow() + 1, 2);
  pdSheet.getRange(row, 1).setValue(projectId);
  pdSheet.getRange(row, 2).setValue(type);
  pdSheet.getRange(row, 3).setValue(epId);
  pdSheet.getRange(row, 4).setValue(lookupProjectNameById_(ss, projectId) || '');

  // 4) mirror into the Director tab (existing helper handles Director lookup)
  try {
    autoCreateDirRow_(ss, pdSheet, row, projectId, type, epId);
  } catch (dirErr) {
    Logger.log('autoCreateDirRow_ (booking endpoint): ' + dirErr);
  }

  return epId;
}

function _bookingJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
