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

// ── Demo seed for the local mock server (iOS simulator smoke tests) ──────
// The festival above, moved in time so that Friday 16:00 lands on `now`:
// Main Stage plays DJ O'Neil, The Tent its band, and every stage has a next
// show. Every show keeps its length and order; date/day are recomputed with
// the app's own rules (Europe/Amsterdam, festival day 07:00-07:00), so the
// result is right whatever the machine's time zone or the DST offset.
const AMS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
/** Instant -> Amsterdam wall clock { date: 'YYYY-MM-DD', time: 'HH:MM:SS' }. */
function amsWall(ms) {
  const p = Object.fromEntries(AMS_FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
const festivalDateOf = (ms) => amsWall(ms - 7 * 3600e3).date;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * festivalSeed(), shifted to `now` (ms), plus the login user `login`
 * ({id, email, password, name, role}). The company's plan runs a year from now.
 */
function demoSeed(now = Date.now(), login) {
  const seed = festivalSeed();
  const delta = Math.floor(now / 60000) * 60000 - ams(FESTIVAL.dates.d1, '16:00').getTime();
  const fest = seed.projects.find((p) => p.id === FESTIVAL.projectId);
  const dayDate = Object.fromEntries(fest.data.days.map((d) => [d.id, d.date]));
  const dayIds = {};
  for (const s of fest.data.shows) {
    const date = s.date || dayDate[s.day];   // legacy show: date comes from its day
    const start = ams(date, s.start).getTime();
    let end = ams(date, s.end).getTime();
    if (end <= start) end += 86400e3;
    const a = amsWall(start + delta);
    const b = amsWall(end + delta);
    const fd = festivalDateOf(start + delta);
    dayIds[fd] = `day-${fd}`;
    Object.assign(s, {
      day: dayIds[fd], date: a.date, start: a.time, end: b.time,
      startsAt: `${a.date}T${a.time}`, endsAt: `${b.date}T${b.time}`, endsNextDay: b.date !== a.date,
      artist: s.artist.replace(' (legacy)', ''),   // it has ISO times now
    });
  }
  const today = festivalDateOf(now);
  dayIds[today] = `day-${today}`;
  fest.data.days = Object.keys(dayIds).sort().map((d) => ({
    id: dayIds[d], name: WEEKDAYS[new Date(d + 'T12:00:00Z').getUTCDay()], date: d,
  }));
  fest.data.activeDay = dayIds[today];
  for (const notes of Object.values(fest.data.fohNotes || {})) {
    for (const n of notes) n.time = amsWall(ams(FESTIVAL.dates.d1, n.time).getTime() + delta).time.slice(0, 5);
  }
  const small = seed.projects.find((p) => p.id === FESTIVAL.smallProjectId);
  if (small) small.data.days[0].date = today;
  const co = seed.companies.find((c) => c.id === FESTIVAL.companyId);
  co.current_period_end = new Date(now + 365 * 86400e3).toISOString();
  co.last_paid_at = new Date(now - 30 * 86400e3).toISOString();
  if (login) {
    // The dashboard lists only projects its user created, so the login owns the festival.
    for (const p of seed.projects) p.created_by = login.id;
    seed.app_users.push({ id: login.id, name: login.name, email: login.email, role: login.role || 'company_admin', company_id: FESTIVAL.companyId, created_at: '2026-01-01T10:00:00+00:00' });
    seed.authUsers[login.email.toLowerCase()] = { id: login.id, email: login.email, password: login.password };
  }
  return seed;
}

// Artist lounge (tests/regression/artist-lounge.spec.js): five distinct
// 240x240 JPEG placeholder "artist photos" (gradient, stage light, silhouette;
// ~3.8 kB each), generated once with a canvas. Not part of festivalData():
// specs put them on shows through stSeed.mutate, so every other payload stays
// exactly as it was.
const LOUNGE_PHOTOS = [
  'data:image/jpeg;base64,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',
  'data:image/jpeg;base64,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',
  'data:image/jpeg;base64,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',
  'data:image/jpeg;base64,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',
  'data:image/jpeg;base64,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',
];

// A 290x64 transparent PNG festival wordmark (white type + a round mark) for
// the artist lounge header, generated with a canvas. Fictional festival.
const LOUNGE_LOGO = 'data:image/png;base64,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';

module.exports = { FESTIVAL, PHOTO_PNG, LOUNGE_PHOTOS, LOUNGE_LOGO, ams, show, festivalData, festivalSeed, demoSeed, amsWall };
