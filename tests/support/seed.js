// Seed factory: a representative festival for every spec.
//
// Everything is plain data in the exact shape app.html stores in
// projects.data (see saveShow / loadG / fohNotes / crew in app.html).
// Times are local Europe/Amsterdam wall-clock strings, which is how the app
// stores them (startsAt "2026-07-10T23:00:00", no offset). The Playwright
// config pins timezoneId to Europe/Amsterdam, so these parse identically in
// every run. July = CEST (+02:00); use ams() to build Date objects.
//
// Call festivalSeed() for a fresh deep copy; mutate freely in a spec.

const FESTIVAL = {
  companyId: 'co-fest',
  otherCompanyId: 'co-other',
  projectId: 'proj-fest',
  smallProjectId: 'proj-small',
  stages: { main: 'stg-main', tent: 'stg-tent', club: 'stg-club' },
  days: { d1: 'day-fri', d2: 'day-sat' },
  dates: { d1: '2026-07-10', d2: '2026-07-11' },
  users: {
    admin: { id: 'usr-admin', email: 'admin@zomerfeest.test', name: 'Anouk Admin', role: 'company_admin', company_id: 'co-fest', password: 'correct-horse-1' },
    operator: { id: 'usr-op', email: 'operator@zomerfeest.test', name: "Owen O'Perator", role: 'operator', company_id: 'co-fest', password: 'correct-horse-2' },
    super: { id: 'usr-super', email: 'super@stagetimer.test', name: 'Sam Super', role: 'super_admin', company_id: 'co-fest', password: 'correct-horse-3' },
    other: { id: 'usr-other', email: 'someone@other.test', name: 'Other Owner', role: 'company_admin', company_id: 'co-other', password: 'correct-horse-4' },
  },
};

// 1x1 PNG, the smallest valid base64 photo (photos are stored inline as data URLs).
const PHOTO_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** Amsterdam wall-clock -> Date. ams('2026-07-10', '16:29:45.400'). Summer only (+02:00). */
function ams(date, time) {
  const [hms, ms = '0'] = String(time).split('.');
  const t = hms.length === 5 ? hms + ':00' : hms;
  return new Date(`${date}T${t}.${ms.padEnd(3, '0')}+02:00`);
}

function addDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a show in the ISO model the current drawer writes (date/start/end +
 * startsAt/endsAt/endsNextDay). Pass legacy:true for an old show that only has
 * start/end and inherits its date from the day.
 */
function show(id, stage, day, date, start, end, artist, extra = {}) {
  const s = `${start.length === 5 ? start + ':00' : start}`;
  const e = `${end.length === 5 ? end + ':00' : end}`;
  const overnight = e <= s;
  const base = {
    id, stage, day, artist,
    start: s, end: e,
    genre: '', booth: '', type: '', note: '',
    crew: {}, photo: '',
    cancelled: false, priority: false, hidden: false,
  };
  if (!extra.legacy) {
    Object.assign(base, {
      date,
      startsAt: `${date}T${s}`,
      endsAt: `${overnight ? addDay(date) : date}T${e}`,
      endsNextDay: overnight,
    });
  }
  const { legacy, ...rest } = extra;
  return Object.assign(base, rest);
}

function festivalData() {
  const { stages: S, days: D, dates: T } = FESTIVAL;
  const shows = [
    // ── Main Stage, Friday
    show('m1', S.main, D.d1, T.d1, '14:00', '15:00', 'Opening Act', {
      genre: 'Indie', booth: 'A',
      crew: { vj: { name: 'Anna', status: 'present' }, sound: { name: 'Bas', status: '' } },
    }),
    show('m2', S.main, D.d1, T.d1, '15:30', '16:30', "DJ O'Neil", {
      genre: 'House', booth: 'B', note: "Bring O'Neil's USB backup", photo: PHOTO_PNG,
      rider: { drinks: '6x Club-Mate\nStill water, no ice', tech: '2x CDJ-3000 + DJM-900NXS2\nBooth monitor left' },
      crew: {
        vj: { name: 'Anna', status: 'present' },
        light: { name: 'Bram', status: 'otw' },
        sound: { name: "Chris O'Brien", status: 'unknown' },
      },
    }),
    show('m3', S.main, D.d1, T.d1, '17:00', '18:15', 'The <b>html</b> & "Quotes" Band', { genre: 'Rock', booth: 'A' }),
    show('m4', S.main, D.d1, T.d1, '19:00', '20:30', 'Headliner Priority', {
      genre: 'Pop', booth: 'A', priority: true, type: 'live',
      // Markup in a rider must stay text everywhere.
      rider: { drinks: 'Champagne <b>Brut</b> & "ice"\n<img src=x onerror="window.__xss=1">', tech: 'In-ear monitoring (4 mixes)\n<script>window.__xss=1</script>' },
    }),
    show('m5', S.main, D.d1, T.d1, '21:00', '22:30', 'Cancelled Act', { cancelled: true }),
    show('m6', S.main, D.d1, T.d1, '23:00', '01:30', 'Night Owl', { genre: 'Techno', booth: 'B', rider: { drinks: 'Espresso', tech: '' } }),
    // ── The Tent, Friday
    show('t1', S.tent, D.d1, T.d1, '15:00', '16:00', 'Hidden Guest', { hidden: true }),
    show('t2', S.tent, D.d1, T.d1, '16:00', '17:30', 'Tent Band (legacy)', { legacy: true, booth: 'A' }),
    show('t3', S.tent, D.d1, T.d1, '22:00', '00:30', 'Late Tent', {}),
    // ── Club Stage, Friday (incl. a show that starts after midnight but belongs to Friday night)
    show('c1', S.club, D.d1, T.d1, '20:00', '21:00', 'Club Opener', { type: 'live' }),
    show('c2', S.club, D.d1, T.d2, '00:30', '02:00', 'After Midnight', {}),
    // ── Saturday
    show('m7', S.main, D.d2, T.d2, '14:00', '15:30', 'Day Two Opener', {}),
    show('m8', S.main, D.d2, T.d2, '20:00', '21:30', 'Saturday Headliner', { priority: true }),
    show('t4', S.tent, D.d2, T.d2, '18:00', '19:00', 'Tent Saturday', {}),
    show('c3', S.club, D.d2, T.d2, '23:00', '01:30', 'Club Closing', {}),
  ];
  return {
    stages: [
      { id: S.main, name: 'Main Stage', emoji: '🎪' },
      { id: S.tent, name: 'The Tent', emoji: '⛺' },
      { id: S.club, name: 'Club Stage', emoji: '🪩' },
    ],
    days: [
      { id: D.d1, name: 'Vrijdag', date: T.d1 },
      { id: D.d2, name: 'Zaterdag', date: T.d2 },
    ],
    shows,
    fohNotes: {
      m2: [{ id: 'n1', text: "Extra monitor for DJ O'Neil", time: '15:45', color: '#ffe600' }],
      m4: [{ id: 'n2', text: '<script>window.__xss=1</script> pyro check', time: '19:10', color: '#22c55e' }],
    },
    activeStage: S.main,
    activeDay: D.d1,
    timerMode: 'live',
    memberIds: [FESTIVAL.users.operator.id],
    svModes: {},
    cue: null,
    blackout: false,
  };
}

function festivalSeed() {
  const U = FESTIVAL.users;
  const userRow = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, company_id: u.company_id, created_at: '2026-01-01T10:00:00+00:00' });
  return {
    companies: [
      {
        id: FESTIVAL.companyId, name: 'Zomerfeest Events BV',
        stripe_customer_id: 'cus_mock_fest', stripe_subscription_id: 'sub_mock_fest',
        subscription_status: 'active', subscription_tier: 'festival', project_limit: 0,
        current_period_end: '2026-12-31T00:00:00+00:00', trial_ends_at: null, last_paid_at: '2026-06-01T00:00:00+00:00',
        pending_name: null, pending_email: null, setup_token: null, setup_pending: false,
        extra_seats: 0, seat_subscription_item_id: null,
        plan_slug: 'festival', live_stages_limit: null, live_stages_override: null,
        pass_slug: null, pass_expires_at: null, created_at: '2026-01-01T10:00:00+00:00',
      },
      {
        id: FESTIVAL.otherCompanyId, name: 'Awaiting Activation BV',
        stripe_customer_id: 'cus_mock_other', stripe_subscription_id: null,
        subscription_status: 'incomplete', subscription_tier: null, project_limit: 0,
        current_period_end: null, trial_ends_at: null, last_paid_at: null,
        pending_name: 'Pending Person', pending_email: 'pending@other.test',
        // A secret the client must never request. Specs can assert it never leaves the mock.
        setup_token: 'SECRET-SETUP-TOKEN-do-not-leak', setup_pending: true,
        extra_seats: 0, seat_subscription_item_id: null,
        plan_slug: null, live_stages_limit: null, live_stages_override: null,
        pass_slug: null, pass_expires_at: null, created_at: '2026-02-01T10:00:00+00:00',
      },
    ],
    app_users: [userRow(U.admin), userRow(U.operator), userRow(U.super), userRow(U.other)],
    projects: [
      {
        id: FESTIVAL.projectId, name: 'Zomerfeest 2026', company_id: FESTIVAL.companyId,
        created_at: 1767261600000, created_by: U.admin.id, data: festivalData(),
      },
      {
        id: FESTIVAL.smallProjectId, name: 'Kleine Clubnacht', company_id: FESTIVAL.companyId,
        created_at: 1767348000000, created_by: U.admin.id,
        data: {
          stages: [{ id: 'stg-solo', name: 'Solo Stage', emoji: '🎤' }],
          days: [{ id: 'day-solo', name: 'Day 1', date: '2026-08-01' }],
          shows: [], fohNotes: {}, activeStage: 'stg-solo', activeDay: 'day-solo', timerMode: 'live', memberIds: [],
        },
      },
    ],
    // Auth users (password grant). Keyed by email.
    authUsers: Object.fromEntries(Object.values(U).map((u) => [u.email, { id: u.id, email: u.email, password: u.password }])),
  };
}

module.exports = { FESTIVAL, PHOTO_PNG, ams, show, festivalData, festivalSeed };
