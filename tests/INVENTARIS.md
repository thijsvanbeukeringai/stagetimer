# Inventaris functies en schermen (BOUWPLAN §1.0)

Alle code staat in `app.html`. Regelnummers gelden voor commit `13cd2d0` en verschuiven tijdens het werk: zoek op functienaam.
"Test" verwijst naar specs onder `tests/`. Een *gat* betekent: nog geen eigen test, alleen indirect gedekt.

Legenda testbestanden:
- `booth` = `tests/booth/stage-view.spec.js` (pixelbaseline + stijl-fingerprint, uit 845eb0d)
- `auth` / `operator` / `public` / `admin` / `harness` = `tests/smoke/*.spec.js`
- `unit` = `tests/unit/time-model.spec.js`, `regr` = `tests/regression/known-bugs.spec.js`

## 1. Inloggen, sessie en account

| Functie | Code (≈regel) | Test |
|---|---|---|
| Vroege sessiedetectie (`html.no-session`), loader/login | inline script in `<head>` (~45), opstart-IIFE (~8595) | auth: *no stored session shows the login form* |
| Inloggen met wachtwoord (directe REST `/auth/v1/token`) | `doLogin` 8360, `_tryStartFromSession` 8345 | auth: *password login lands on the workspace dashboard*, *wrong password…* |
| Sessie herstellen (st_auth_v1 → `/auth/v1/user`, refresh) | `_authProbe` 8568, `_authRefresh` 8581, `restoreAuthSession` 2323, `saveAuthSession` 2319 | auth: *stored session boots…*, *expired access token is refreshed* |
| Gebruiker + rol laden | `loadCurrentUser` 7592, `updateRoleUI` 7622, `isAdmin`/`isSuperAdmin` 7589/7621 | auth, admin: *admin entry is hidden* |
| Uitloggen | `doLogout` 8427, `_showLogoutBtn` 8437 | auth: *logout clears the stored session* |
| Wachtwoord vergeten / reset-link | `showForgotPw` 8461, `sendReset` 8470 | auth: *forgot password sends a recover request* (falen-pad: gat, zie BOUWPLAN 1.5) |
| Nieuw wachtwoord instellen (`#set-pw`, invite) | `setNewPassword` 8479 | gat (modal wordt nooit geopend, BOUWPLAN 1.5) |
| Signup na betaling (`?signup=success&cid&t`) | `completeSignup` 7918 → edge `finalize-signup` | gat (mock aanwezig: `backend.setFunction('finalize-signup', …)`) |
| Profiel: naam, wachtwoord | `renderProfilePage` 6404, `saveProfileName` 6451, `saveProfilePassword` 6465 | operator: *workspace sections* (alleen openen) |
| Workspace-instellingen, naam | `renderSettingsPage` 6365, `saveWorkspaceName` 6391 | operator: *workspace sections* (alleen openen) |
| Leden uitnodigen / verwijderen | `openInviteMemberPrompt` 6478, `removeMember` 6498 → edge `invite-member`/`remove-member` | gat (edge functions gemockt, geen echte invites) |
| Abonnement: pagina, banner, portal | `renderSubscriptionPage` 6273, `renderSubscriptionBanner` 6575, `manageSubscription` 7344 → edge `portal-link` | operator: *workspace sections*; periode-weergave jaar/maand: gat (BOUWPLAN 1.5) |
| Planlimiet live stages | `_effectiveStageLimit` 5866, `checkStageLimit` 5889, `canCreateProject` 6605 | gat (trialing = 0 stages, besluitpunt B2) |

## 2. Projecten (dashboard)

| Functie | Code | Test |
|---|---|---|
| Laden companies/app_users/projects (REST, kolomlijst zonder `setup_token`) | `loadAPPRemote` 2434, `_restGet` 2365, `_restGetCompanies` 2423, `_isMissingColumn` 2394, `_mapCompany` 2398 | auth: *stored session boots…* (controleert `select` zonder setup_token), harness: *42703* |
| Lokale cache `st_app_v1` | `loadAPPCache` 2347, `saveAPP` 2488 | indirect |
| Dashboard / projectlijst | `renderDash` 6159, `showWsSection` 6255 | operator: *dashboard lists the workspace projects* |
| Project openen | `openProject` 6529, `openProjectOnce` 6137, `loadG` 2466 | operator: *open project shows the schedule…* |
| Project aanmaken / hernoemen / verwijderen | `createProject` 6662, `renameProject` 6561, `deleteProject` 6551, `_restWrite` 6540 | gat |
| Opslaan (debounce, wipe-guard, PATCH) | `save` 2501, `_pushProject` 2512, `setSyncDot` 2340 | operator (alle save-tests), harness: *injected 500 on save…* |
| Realtime (postgres_changes projects + companies) | `setupRealtime` 2600 | operator: *realtime update from another device…* |

## 3. Dagen en podia

| Functie | Code | Test |
|---|---|---|
| Dagen beheren (naam, datum, toevoegen, verwijderen) | `openDayModal` 6078, `renderDayList` 6085, `renameDay` 6093, `setDayDate` 6098, `addDay` 6113, `delDay` 6126 | operator: *crew, stage and day management dialogs open* |
| Dag kiezen (gedeeld veld `activeDay`) | `setDay` 4211, `_dayPickerHTML` 4220, `_pickDay*` 4213-4216 | indirect |
| Podia beheren | `openStageModal` 5827, `renderStageList` 5835, `addStage` 5902, `delStage` 5916 | operator: *…management dialogs open* |
| Podium kiezen (header) | `renderHeader` 4157 | indirect |

## 4. Planning en showeditor

| Functie | Code | Test |
|---|---|---|
| Planningslijst (kaarten) | `renderSched` 4023, `tickSched` 4098 | operator: *open project shows the schedule* |
| Showeditor openen / opslaan / nieuw | `openDrawer` 4637, `saveShow` 4809, `_readStartDate`/`_readEndDate` 4706/4717, `updDur` 4747 | operator: *show editor opens, edits and saves*, *new show via the editor* |
| Show verwijderen | `delShow` 4852 | gat |
| Vlaggen geannuleerd / prioriteit / verborgen | `toggleDrFlag` 4625 | seed bevat alle drie; booth: *hidden-skipped* |
| Tijdmodel (ISO `startsAt`/`endsAt` + legacy), middernacht, 07:00-grens | `_showStartsAt` 2701, `_showEndsAt` 2709, `_showDurationSec` 2748, `getShows` (~2660), `adjM` | unit: *overnight show: ISO model and legacy model agree*, booth: *overnight* |
| Huidige / volgende show | `curShow` 2819, `nxtShow` 2834, `nextUpcomingAnyDay` 2848 | unit: *curShow / nxtShow*, booth: *next-day*, *idle* |
| Itemtype-badge | `itemTypeBadge` 5538 | indirect (seed heeft `type`) |

## 5. Live- en handmatige timer, tijdcorrecties

| Functie | Code | Test |
|---|---|---|
| Timerpaneel live | `renderTP` 3946, `renderTPLive` 3950, `setCD` 4009, `setNxt` 4017 | operator: *open project…* (artiest in `#tpanel`) |
| Handmatige timer (start/pauze/reset/vorige/volgende/nudge) | `M`, `mReset` 2872, `mPP` 2873, `mStop` 2874, `mPrev`/`mNext` 2875/2876, `nudge` 2877, `renderTPManual` 3986, `renderTbar` 2878 | operator: *manual timer mode toggles*; correcties tijdens pauze: gat (BOUWPLAN 1.4) |
| Modus live/handmatig | `setMode` 4855 | operator: *manual timer mode toggles* |
| Snelle correctie ±1/±5 min | `adjustLiveShow` 5606, `_writeShowTimes` 5590, `renderQuickAdjust` 5676 | operator: *cues, blackout and quick adjust…* (+5 min) |

## 6. Schermen

| Scherm | Code | Test |
|---|---|---|
| FOH (in-app + `?mode=foh`) | `openFOH` 4872, `renderFOH` 4265, `tickFOH` 4964, `fohBoothBadge` 4250 | operator: *FOH screen*, public: *FOH view* |
| Backstage (in-app + `?mode=backstage`) | `openBS` 4874, `renderBS` 4358, `tickBS` 4473 | operator: *Backstage screen*, public: *backstage view* |
| **Stage View / boothscreen** (in-app + `?mode=stage`) | `openSV` 4876, `renderSV` 4513, `updateClock` 4951, CSS `#sv*` (~593-610, ~1281-1291) | **booth** (alle modi/tijden/viewports), operator: *Stage View (in-app)*, public: *stage view* |
| Stage View weergavemodi countdown / clock / countup / blank | `_svMode` 5550, `setSVMode` 5553, `renderDisplayModeBar` 5560 | booth (4 modi × 6 momenten × 3 viewports), operator: *…display modes* |
| Timeline (in-app + `?mode=timeline`) | `openTL` 7375, `renderTL` 7391, `tickTL` 7571 | operator: *Timeline screen*, public: *timeline view* |
| Overview (in-app + `?mode=overview`) | `openOV` 4997, `renderOV` 5024, `tickOV` 5064, `pickStageBestDay` 5007 | operator: *Overview screen*, public: *overview view* |
| Control Wall (`?mode=wall`) | `openWV` 5180, `renderWV` 5369, `tickWV` 5422, `wvSyncTime` 5217 (HEAD `/rest/v1/` voor servertijd), `_wvNow` 5240 | public: *control wall view* |
| Artiesten check-in (`?mode=checkin`) | `openCI`, `renderCI`, `ciToggleArrived` → RPC `set_show_arrived`, `_ciBusy`/`_ciErr` | public: *check-in view marks an artist arrived through the RPC*; regression/views: *check-in …* (dubbele tik zichtbaar geblokkeerd, fout in de rij, geen verborgen shows) |
| Publieke views laden + 1 s poll | `loadPublicView` 7964, `_rpc` 2305 → RPC `get_shared_project`, early fetch in `<head>` | public (alle), public: *stage view picks up operator changes through the 1 s poll* |
| Gedeelde view-helpers (statuswoorden, datumlabel, lege staten, sync-pil) | `vwStatusKey`, `vwChip`, `vwDateLabel`, `vwDayLabel`, `vwEmptyKind`/`vwEmptyHTML`, `vwTickSync`, `vwSame` | regression/views: *empty states …*, *last sync …*, *status words …*, *timeline …*, *overview …*, *… keep their DOM across poll refreshes* |
| Mobiele timer-sheet, navigatie | `toggleMobTimer` 8151, `_syncMobNavActive` 4862 | booth in-app 390×844 (via mob-nav), verder gat |
| Wake lock / fullscreen | `_acquireWakeLock`, `_WAKE_VIEWS` (bs, sv, foh, tl, stov, wv), `_goFullscreen` | regression/views: *wake lock …* (FOH, Timeline, Overview, Wall, Backstage + re-acquire na visibilitychange); fullscreen: gat |

## 7. Cues en blackout

| Functie | Code | Test |
|---|---|---|
| Cue sturen / custom / wissen, status | `sendCue` 5741, `sendCustomCue` 5750, `clearCue` 5756, `_cueActive` 5761, `renderCueStatus` 5767 | operator: *cues, blackout…* |
| Cue-overlay op viewers | `_renderCueOverlay` 5786 | booth: *cue-wrapup*, public: *…1 s poll* |
| Blackout | `toggleBlackout` 5710, `renderBlackout` 5716 | operator: *cues, blackout…*, booth: *blackout* |
| Hoofdtick (250 ms) | `tick` 5808 | alle booth-tests (deterministisch via `page.clock`) |

## 8. Crew, statussen en push

| Functie | Code | Test |
|---|---|---|
| Crew per show + status (present/otw/unknown) | `fohCrewHTML` 4229, `setCrewStatus` 4242, `CREW_ROLES` (~4228) | seed bevat crew + statussen; klikken: gat |
| Crewselectie project (`memberIds`) | `openCrewModal` 7630, `renderCrewList` 7646, `toggleCrewMember` 7660 | regr: `test.fail` *crew selection is saved* (bug `saveProj`, BOUWPLAN 1.5) |
| Push (OneSignal) init / permissie / ingeplande pushes | `initOneSignalUser` 7671, `requestPushPermission` 7684, `scheduleProjectPushes` 7697, SDK alleen op stagetimer.nl | gat; mock vangt `*.onesignal.com` op en registreert in `backend.onesignal` |

## 9. Notities, foto's, logo

| Functie | Code | Test |
|---|---|---|
| FOH-notities (tijd, kleur, tekst) | `openFohnModal` 4326, `saveFohnNote` 4344, `delFohnNote` 4351, `fohNotesHTML` 4256 | operator: *FOH screen* (notitie zichtbaar; seed bevat `<script>` in notitie) |
| Show-notitie | veld `note` in `saveShow` | operator: *show editor…* |
| Artiestfoto (base64, compressie) | `previewPhoto` 4781, `_compressImage` 4764, `clearPhoto` 4803, `setTPPhoto` 4804 | seed bevat foto; verwijderen: gat (BOUWPLAN 1.5) |
| Projectlogo | `handleLogoUpload` 8176, `removeProjectLogo` 8200, `applyLogo`/`refreshLogo` no-op | gat |

## 10. Import

| Functie | Code | Test |
|---|---|---|
| JSON-import dialoog | `openJSONModal` 5929, `doJSONImport` 5937 | operator: *import dialog opens* |
| Lineup importeren | `importLineup` 5969 | gat (BOUWPLAN 1.3: seconden, ontbrekende `end`, andere podia) |

## 11. Deellinks en losse timers

| Functie | Code | Test |
|---|---|---|
| Deeldialoog (alle URLs per podium) | `openShareModal`, `_shareRowHTML`, `copyLink` | operator: *share-link dialog lists every public URL*; regression/views: *share dialog …* (alleen-lezen/check-in per link, kopieerfout + fallback, 390 px) |
| Losse timers (one-off) | `loadOT` 8216, `saveOTTimer` 8280, `delOT` 8291, `renderOTSection` 8240, `openOTV` 8298, `tickOTV` 8322, `isOTLive` 8236 | operator: *one-off timer can be created*; over middernacht: gat (BOUWPLAN 1.4) |

## 12. Platformbeheer (super_admin)

| Functie | Code | Test |
|---|---|---|
| Adminpagina, KPI's, companies, users | `openAdmin` 6735, `renderAdmin` 7043, `_renderKpis` 6946, `_subBadge` 6920 | admin: *admin page lists companies, users and vouchers* (incl. badge "Awaiting activation", geen setup_token) |
| Company toevoegen / bewerken / stage-override / verwijderen | `addCompany` 7182, `editCompany` 7192, `setStageOverride` 7205, `delCompany` 7221 | gat |
| User toevoegen / rol / verwijderen | `addUser` 7246, `changeUserRole` 7305, `delUser` 7318 | gat |
| Vouchers (Stripe promotiecodes via edge `manage-voucher`) | `loadVouchers` 6768, `createVoucher` 6871, `archiveVoucher` 6897, `activateVoucher` 6906 | admin (lijst via gemockte functie) |

## Bekende gaten in het vangnet
- Geen tests voor verwijderen (show, dag, podium, project) en company/user-beheer: allemaal via `confirm()`/`prompt()`. Voeg `page.on('dialog', d => d.accept())` toe in de spec.
- Echte Safari/iOS, pushmeldingen, e-mail, Stripe en de productiedatabase worden niet getest (BOUWPLAN "Expliciet niet getest").
- Realtime-stub: alleen `postgres_changes` (join/heartbeat/leave/push). Broadcast/presence worden niet gebruikt door de app en niet nagebootst.
