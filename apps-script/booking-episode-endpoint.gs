/**
 * Booking → Episode ID  ·  Standalone Web App endpoint  (DROP-IN NEW FILE)
 * ========================================================================
 * Paste this as a NEW file in the "Dashboard: Production Project 2026"
 * Apps Script project. It does NOT modify any existing file, function,
 * or trigger — it only adds:
 *   • a doPost() Web App entry point
 *   • private helpers prefixed _bk_*  (no name collision)
 *   • a Script Property BOOKING_API_SECRET  (you set this)
 *
 * The ONE thing it shares with the existing script is the EP_SEQ_<project>_<type>
 * counter in ScriptProperties. This is intentional and required: it's what
 * keeps booking-created and hand-typed episodes in ONE continuous sequence
 * (the whole point of "ต้องตรง กับเลขเดิม"). The existing onEditEpisode
 * trigger keeps reading/writing the same counter exactly as before.
 *
 * SETUP — for the pilot copy of the Dashboard sheet (~5 min)
 * ----------------------------------------------------------
 *   1. Apps Script editor → File ➕ → "Script" → name it
 *      "booking-episode-endpoint" → paste THIS WHOLE FILE.
 *
 *   2. IMPORTANT (pilot copy only): from the editor's function dropdown
 *      pick "bookingSeedCounters" → ▶ Run. Apps Script will ask for
 *      permissions the first time — Allow.
 *      This scans the PD tabs and seeds the EP_SEQ_* counters so the
 *      next booking-generated episode picks up the correct NN. Without
 *      it the first booking would reuse "L01" because ScriptProperties
 *      do NOT copy with File → Make a Copy (only cell values copy).
 *      (Skip on ปุ๊ก's master sheet — the counter is already live there.)
 *
 *   3. Project Settings → Script Properties → Add:
 *        BOOKING_API_SECRET = <a long random string, e.g. `openssl rand -hex 32`>
 *
 *   4. Deploy → New deployment → type "Web app"
 *        Description    : Booking endpoint
 *        Execute as     : Me  (sheet owner)
 *        Who has access : Anyone
 *      → Deploy → copy the Web App URL.
 *
 *   5. Send the Web App URL + the secret back to narasit.
 *
 * REQUEST   POST, JSON body:
 *   {
 *     "secret":    "...",
 *     "projectId": "PP-26-008",
 *     "type":      "L",                       // L | S | A | T
 *     "count":     1,                         // optional, default 1, max 20
 *     "titles":    ["Interview ep 1", ""]    // optional; written to PD col 7 "EP."
 *   }
 *
 * RESPONSE  JSON:
 *   { "ok": true,  "episodeIds": ["PP-26-008-L04", "PP-26-008-L05"] }
 *   { "ok": false, "error": "..." }
 *
 * QUICK TEST (after deploying):
 *   curl -X POST <WEB_APP_URL> \
 *     -H 'Content-Type: application/json' \
 *     -d '{"secret":"<your secret>","projectId":"PP-26-001","type":"L","count":1}'
 */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // --- shared-secret auth ---
    var secret = PropertiesService.getScriptProperties().getProperty('BOOKING_API_SECRET');
    if (!secret || body.secret !== secret) {
      return _bk_json_({ ok: false, error: 'unauthorized' });
    }

    // --- validate input ---
    var projectId = String(body.projectId || '').trim();
    var type = String(body.type || '').trim().toUpperCase();
    var count = parseInt(body.count, 10);
    if (!count || count < 1) count = 1;
    var titles = Array.isArray(body.titles) ? body.titles : [];

    if (!/^PP-\d{2}-\d{3}$/.test(projectId)) {
      return _bk_json_({ ok: false, error: 'bad projectId (expect PP-YY-NNN)' });
    }
    if (['L', 'S', 'A', 'T'].indexOf(type) < 0) {
      return _bk_json_({ ok: false, error: 'bad type — expect L, S, A or T' });
    }
    if (count > 20) {
      return _bk_json_({ ok: false, error: 'count > 20 not allowed' });
    }

    // --- serialize so simultaneous requests never double-number ---
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    var episodeIds = [];
    try {
      for (var i = 0; i < count; i++) {
        episodeIds.push(_bk_generate_(projectId, type, String(titles[i] || '').trim()));
      }
    } finally {
      lock.releaseLock();
    }
    return _bk_json_({ ok: true, episodeIds: episodeIds });
  } catch (err) {
    return _bk_json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * Number ONE episode + create its PD-tab + Dir-tab rows. Called once per
 * desired episode by doPost; held inside doPost's lock for atomicity.
 * Reads the SAME EP_SEQ_<project>_<type> ScriptProperty the existing
 * onEditEpisode trigger uses, so the two flows share one continuous
 * sequence and can never collide.
 */
function _bk_generate_(projectId, type, title) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();

  // 1) next sequence — SHARED counter (intentional)
  var propKey = 'EP_SEQ_' + projectId + '_' + type;
  var nn = parseInt(props.getProperty(propKey) || '0', 10);
  if (!nn) nn = 1;
  var epId = projectId + '-' + type + _bk_pad2_(nn);
  props.setProperty(propKey, String(nn + 1));

  // 2) look up project's Name + Producer + Director from "All Projects"
  var info = _bk_lookupProject_(ss, projectId);
  if (!info) throw new Error('Project not found in "All Projects": ' + projectId);
  if (!info.producer) throw new Error('No Producer set for ' + projectId);

  // 3) append row to the producer's PD tab
  //    PD column layout (must match the existing onEditEpisode handler):
  //      1 Project ID · 2 Episode Type · 3 Episode ID · 4 Project Name
  //      5 Director   · 6 (Product Code, blank) · 7 EP. (title/description)
  var pdTabName = 'PD ' + info.producer;
  var pdSheet = ss.getSheetByName(pdTabName);
  if (!pdSheet) throw new Error('PD tab not found: "' + pdTabName + '"');
  var pdRow = Math.max(pdSheet.getLastRow() + 1, 2);
  pdSheet.getRange(pdRow, 1, 1, 7).setValues([[
    projectId, type, epId, info.projectName, info.director, '', title || ''
  ]]);

  // 4) mirror into the Director's tab (idempotent — skip if epId already there)
  if (info.director) {
    var dirTabName = 'Dir. ' + info.director;
    var dirSheet = ss.getSheetByName(dirTabName);
    if (dirSheet) {
      var dirLastRow = dirSheet.getLastRow();
      var dup = false;
      if (dirLastRow >= 3) {
        var existing = dirSheet.getRange(3, 1, dirLastRow - 2, 1).getValues();
        for (var i = 0; i < existing.length; i++) {
          if (String(existing[i][0] || '').trim() === epId) { dup = true; break; }
        }
      }
      if (!dup) {
        var dirRow = Math.max(dirLastRow + 1, 3);
        // Dir column layout (must match existing autoCreateDirRow_):
        //   1 EpID · 2 Type · 3 ProjectName · 4 Producer · 5 EP. · 6 Status
        dirSheet.getRange(dirRow, 1, 1, 6).setValues([[
          epId, type, info.projectName, info.producer, title || '', ''
        ]]);
      }
    }
  }

  return epId;
}

/**
 * Read "All Projects" and return {projectName, producer, director} for a
 * given Project ID. Returns null if not found.
 *   Columns A–G:  A ProjectID · B ProjectName · C Client · D Brief
 *                 E BriefDate · F Producer    · G Director
 */
function _bk_lookupProject_(ss, projectId) {
  var sheet = ss.getSheetByName('All Projects');
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0] || '').trim() === projectId) {
      return {
        projectName: String(data[i][1] || '').trim(),
        producer: String(data[i][5] || '').trim(),
        director: String(data[i][6] || '').trim(),
      };
    }
  }
  return null;
}

/**
 * Seed the EP_SEQ_<project>_<type> counters from existing Episode IDs in
 * the PD tabs. Required after File → Make a Copy, because ScriptProperties
 * do NOT copy with the spreadsheet (only cell values copy). Without
 * seeding, the next booking-generated episode would reuse "L01"/"S01" etc.
 *
 * Safe to re-run — the counter only moves forward. If the existing counter
 * is already ahead of what's in the PD tabs, it stays put.
 *
 * From the Apps Script editor: select "bookingSeedCounters" in the function
 * dropdown → ▶ Run.
 */
function bookingSeedCounters() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var PD_TABS = ['PD อ้อม', 'PD ไนซ์', 'PD ซัง'];
  var maxByKey = {};  // "<project>_<type>" → max NN seen
  var scanned = 0;

  for (var t = 0; t < PD_TABS.length; t++) {
    var sheet = ss.getSheetByName(PD_TABS[t]);
    if (!sheet) continue;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;
    var values = sheet.getRange(2, 3, lastRow - 1, 1).getValues(); // col 3 = Episode ID
    for (var i = 0; i < values.length; i++) {
      var m = String(values[i][0] || '').trim().match(/^(PP-\d{2}-\d{3})-([A-Z])(\d{2,})$/);
      if (!m) continue;
      scanned++;
      var key = m[1] + '_' + m[2];
      var nn = parseInt(m[3], 10);
      if (!maxByKey[key] || nn > maxByKey[key]) maxByKey[key] = nn;
    }
  }

  var keys = Object.keys(maxByKey);
  var updated = 0;
  for (var k = 0; k < keys.length; k++) {
    var propKey = 'EP_SEQ_' + keys[k];
    var nextVal = maxByKey[keys[k]] + 1; // next available
    var existing = parseInt(props.getProperty(propKey) || '0', 10);
    if (nextVal > existing) {
      props.setProperty(propKey, String(nextVal));
      updated++;
    }
  }

  var msg = 'Scanned ' + scanned + ' Episode IDs across ' + PD_TABS.length + ' PD tabs.\n' +
            'Updated ' + updated + ' / ' + keys.length + ' EP_SEQ_* counters.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (_) {}
  return msg;
}

function _bk_pad2_(n) {
  var s = String(n);
  return s.length < 2 ? ('0' + s) : s;
}

function _bk_json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
