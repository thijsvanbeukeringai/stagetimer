// Fake Capacitor shell for native-mode specs (BOUWPLAN FASE 6).
//
// The iOS app serves app.html from capacitor://localhost and injects
// window.Capacitor before page scripts run. goNative(page) injects a fake one
// (isNativePlatform() === true, recording plugins App, Haptics, Share,
// StatusBar, SplashScreen, KeepAwake) and a fake cordova OneSignal plugin.
// Every plugin call is recorded in Node through an exposed binding, so calls
// made just before a navigation (logout, deep link, a booth reload) are kept.
// The init script runs again on every navigation of the page.

/** Install the fake native shell. Returns the live list of recorded calls [{plugin, fn, arg}]. */
async function goNative(page) {
  const calls = [];
  await page.exposeBinding('__natRec', (_src, rec) => { calls.push(rec); });
  await page.addInitScript(() => {
    const rec = (plugin, fn, arg) => { try { window.__natRec({ plugin, fn, arg: arg === undefined ? null : JSON.parse(JSON.stringify(arg)) }); } catch (e) { /* binding gone during unload */ } };
    const mk = (plugin, fns) => Object.fromEntries(fns.map((fn) => [fn, (arg) => { rec(plugin, fn, arg); return Promise.resolve(); }]));
    window.__natListeners = {};
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        App: { addListener(ev, cb) { rec('App', 'addListener', ev); window.__natListeners[ev] = cb; return Promise.resolve({ remove() {} }); } },
        Haptics: mk('Haptics', ['impact', 'notification']),
        Share: mk('Share', ['share']),
        StatusBar: mk('StatusBar', ['setStyle']),
        SplashScreen: mk('SplashScreen', ['hide']),
        KeepAwake: mk('KeepAwake', ['keepAwake', 'allowSleep']),
      },
    };
    const os = (fn, arg) => rec('OneSignal', fn, arg);
    window.plugins = {
      OneSignal: {
        initialize: (id) => os('initialize', id),
        login: (id) => os('login', id),
        logout: () => os('logout'),
        User: { addTags: (t) => os('User.addTags', t) },
        Notifications: {
          requestPermission: (fallback) => { os('Notifications.requestPermission', fallback); return Promise.resolve(true); },
          getPermissionAsync: () => Promise.resolve(false),
          addEventListener: (ev) => os('Notifications.addEventListener', ev),
        },
      },
    };
  });
  return calls;
}

const callsOf = (calls, plugin, fn) => calls.filter((c) => c.plugin === plugin && (!fn || c.fn === fn));

/** The StatusBar styles set so far, in order ('DARK' = light text, 'LIGHT' = dark text). */
const barStyles = (calls) => callsOf(calls, 'StatusBar', 'setStyle').map((c) => c.arg && c.arg.style);

module.exports = { goNative, callsOf, barStyles };
