// Per-mode field matrix of get_shared_project(p_id, p_mode): the JS twin of
// public._strip_project_data in supabase/migrations/20261013100000_share_link_rpcs.sql.
//
// One source for the mock backend (which serves the 2-arg variant with exactly
// these rules) and for the specs (tests/regression/share-mode.spec.js parses
// the matrix in the SQL header and checks it equals this one, so the SQL and
// the mock cannot drift apart silently).
//
// Only the fields below are ever stripped. Everything else in the blob
// (stages, days, shows with their times/flags/genre/booth/type/priority/
// arrived, bgVideo (video link), activeStage/activeDay, timerMode, svModes, cue, blackout, branding) reaches
// every mode: the shared time model, the cue/blackout overlays and the
// Stage View need it, and none of it is personal or large.
// 'stagemanager' (?mode=stagemanager&pid=..&sid=..): the stage manager's
// screen - running order, arrivals and riders for one stage.
// 'dressing' (?mode=dressing&pid=..&shid=..): one artist's dressing room
// screen - countdown over a background video / photo, thank-you with logo.
const SHARE_MODES = ['stage', 'backstage', 'foh', 'timeline', 'overview', 'wall', 'checkin', 'stagemanager', 'dressing'];

// field -> the modes that keep it. 'legacy' is the PHASE B narrowing of the
// 1-arg call (union of what any mode renders); unknown modes get none.
const SHARE_FIELD_MATRIX = {
  fohNotes: ['foh', 'legacy'],                  // renderFOH fohNotesHTML (timed cues are FOH-only, not on Backstage)
  'shows[].note': ['backstage', 'legacy'],      // renderBS notesBlock
  'shows[].crew': ['foh', 'legacy'],            // renderFOH fohCrewHTML (names + status)
  'shows[].photo': [],                          // operator timer panel / editor drawer only
  memberIds: [],                                // operator crew picker / push only
  logo: ['backstage', 'foh', 'dressing', 'legacy'],   // refreshLogo top-left (data.branding toggles); dressing thank-you
  'shows[].rider': ['checkin', 'stagemanager', 'legacy'],   // {drinks, tech}: artist hospitality + tech rider
  'shows[].bgImage': ['dressing', 'legacy'],    // dressing room background photo (may be base64: large)
};

const keeps = (field, mode) => SHARE_FIELD_MATRIX[field].includes(mode);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Same output as public._strip_project_data(p_data, p_mode). Never mutates `data`. */
function stripProjectData(data, mode) {
  if (!isObj(data)) return clone(data);
  const out = clone(data);
  if (!keeps('logo', mode)) delete out.logo;
  if ('memberIds' in out) out.memberIds = [];
  if (!keeps('fohNotes', mode) && 'fohNotes' in out) out.fohNotes = {};
  const drop = ['photo'];
  if (!keeps('shows[].note', mode)) drop.push('note');
  if (!keeps('shows[].crew', mode)) drop.push('crew');
  if (!keeps('shows[].rider', mode)) drop.push('rider');
  if (!keeps('shows[].bgImage', mode)) drop.push('bgImage');
  if (Array.isArray(out.shows)) {
    out.shows = out.shows.map((s) => {
      if (!isObj(s)) return s;
      for (const k of drop) delete s[k];
      return s;
    });
  }
  return out;
}

/** The p_mode the SQL actually strips for (unknown -> 'strict'). */
const sqlMode = (mode) => (SHARE_MODES.includes(mode) ? mode : 'strict');

module.exports = { SHARE_MODES, SHARE_FIELD_MATRIX, stripProjectData, sqlMode };
