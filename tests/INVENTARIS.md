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
| Profiel: naam, wachtwoord | `renderProfilePage` 6404, `saveProfileName` 6451, `saveProfilePassword` 6465 | operator: *workspace sections* (alleen openen); operator: *workspace sections*; regression dialogs-forms: *password rule is shown and checked next to the field* |
| Workspace-instellingen, naam | `renderSettingsPage` 6365, `saveWorkspaceName` 6391 | operator: *workspace sections* (alleen openen); regression/logic: *workspace name read-only / editable* per rol; operator: *workspace sections*; regression dialogs-forms: *as operator › member management…* (alleen-lezen) |
| Leden uitnodigen / verwijderen | `openInviteMemberPrompt` 6478, `removeMember` 6498 → edge `invite-member`/`remove-member` | regression dialogs-forms: *invite: one form, inline checks, mocked invite-member…*; smoke dialogs: *remove member calls the mocked remove-member* |
| Abonnement: pagina, banner, portal | `renderSubscriptionPage` 6273, `renderSubscriptionBanner` 6575, `manageSubscription` 7344 → edge `portal-link` | operator: *workspace sections*; periode-weergave jaar/maand: gat (BOUWPLAN 1.5) |
| Planlimiet live stages | `_effectiveStageLimit` 5866, `checkStageLimit` 5889, `canCreateProject` 6605 | gat (trialing = 0 stages, besluitpunt B2) |

## 2. Projecten (dashboard)

|---|---|---|
| Laden companies/app_users/projects (REST, kolomlijst zonder `setup_token`) | `loadAPPRemote` 2434, `_restGet` 2365, `_restGetCompanies` 2423, `_isMissingColumn` 2394, `_mapCompany` 2398 | auth: *stored session boots…* (controleert `select` zonder setup_token), harness: *42703* |
| Lokale cache `st_app_v1` | `loadAPPCache` 2347, `saveAPP` 2488 | indirect |
| Dashboard / projectlijst | `renderDash` 6159, `showWsSection` 6255 | operator: *dashboard lists the workspace projects* |
| Project openen | `openProject` 6529, `openProjectOnce` 6137, `loadG` 2466 | operator: *open project shows the schedule…* |
| Project aanmaken / hernoemen / verwijderen | `createProject` 6662, `renameProject` 6561, `deleteProject` 6551, `_restWrite` 6540 | regression dialogs-forms: *rename project is a form dialog…*; smoke dialogs: *delete project from the dashboard*; aanmaken: gat |
| Opslaan (debounce, wipe-guard, PATCH) | `save` 2501, `_pushProject` 2512, `setSyncDot` 2340 | operator (alle save-tests), harness: *injected 500 on save…*; regression/logic + unit/sync-engine.test.js: plan-limiet PT402 (`_planError`, `_dropRefusedStages`) |
| Atomisch opslaan (`save_project`, versie, conflict → hermerge), terugval GET+PATCH | `_pushOnce`, `_saveViaRpc`, `_wipeIntended`, `_projRead`, `_srv` | regression/atomic-save: *version goes up by one per save*, *conflict, is merged…*, *two screens…*, *not newer… ignored*, *p_force*, *would_wipe*, *before the migration* (2×) |
| Soft delete, *Recently deleted*, versiegeschiedenis | `deleteProject`, `_loadDeleted`, `_renderDeleted`, `restoreDeletedProject`, `openProjectHistory`, `_forgetProject` | regression/atomic-save: *delete moves a project to Recently deleted…*, *soft-deleted projects are not loaded…*, *hard delete… before the migration*, *version history* (mock: `backend.enableProjectVersioning()` / `enableSoftDelete()`) |
| Realtime (postgres_changes projects + companies) | `setupRealtime` 2600 | operator: *realtime update from another device…* |

## 3. Dagen en podia

|---|---|---|
| Dagen beheren (naam, datum, toevoegen, verwijderen) | `openDayModal` 6078, `renderDayList` 6085, `renameDay` 6093, `setDayDate` 6098, `addDay` 6113, `delDay` 6126 | operator: *…management dialogs open*; regression dialogs-forms: *day management* (datumwijziging met effect, dag + shows verwijderen, lege naam); smoke dialogs: *delete day takes its shows* |
| Dag kiezen (gedeeld veld `activeDay`) | `setDay` 4211, `_dayPickerHTML` 4220, `_pickDay*` 4213-4216 | indirect |
| Podia beheren | `openStageModal` 5827, `renderStageList` 5835, `addStage` 5902, `delStage` 5916 | operator: *…management dialogs open*; smoke dialogs: *…delete stage keeps behaviour* |
| Podium kiezen (header) | `renderHeader` 4157 | indirect |

## 4. Planning en showeditor

|---|---|---|
| Planningslijst (kaarten) | `renderSched` 4023, `tickSched` 4098 | operator: *open project shows the schedule* |
| Showeditor openen / opslaan / nieuw | `openDrawer` 4637, `saveShow` 4809, `_readStartDate`/`_readEndDate` 4706/4717, `updDur` 4747 | operator: *show editor opens, edits and saves*, *new show via the editor*; regression/logic: *show editor on a device in …* (festivaltijd op Amsterdam/New York/Tokyo-toestel); regression dialogs-forms: *show editor* (veldfouten, seconden, automatische eindtijd, overlap, niet-opgeslagen wijzigingen) |
| Artiestfoto / logo in Storage (upload, base64-terugval, opruimen, achtergrondconversie) | `_uploadMedia`, `_deleteMedia`, `_dropMediaAfterSave`, `movePhotosToStorage`, `_photoUpload`/`_photoDiscard`, `previewPhoto`, `setTPPhoto`, `handleLogoUpload`; mock: `backend.storage` (`bucketMissing`) | regression/photo-storage: upload → URL in de blob + kleine save, bucket ontbreekt → base64, netwerkfout → base64 en later opnieuw, vervangen/weghalen/verwerpen verwijdert het object, gedeelde foto blijft, conversie (3 per run, idempotent, zelfde bytes), deellinks uploaden nooit, timerpaneel toont de URL, kapotte URL klapt in; booth: *photo from a Storage URL* (zelfde pixels als de base64-baseline) |
| Show verwijderen | `delShow` 4852 | regression dialogs-forms: *delete show names the show…*; smoke dialogs: *delete show* |
| Vlaggen geannuleerd / prioriteit / verborgen | `toggleDrFlag` 4625 | seed bevat alle drie; booth: *hidden-skipped* |
| Tijdmodel (ISO `startsAt`/`endsAt` + legacy), middernacht, 07:00-grens | `_showStartsAt` 2701, `_showEndsAt` 2709, `_showDurationSec` 2748, `getShows` (~2660), `adjM` | unit: *overnight show: ISO model and legacy model agree*, booth: *overnight* |
| Huidige / volgende show | `curShow` 2819, `nxtShow` 2834, `nextUpcomingAnyDay` 2848 | unit: *curShow / nxtShow*, booth: *next-day*, *idle* |
| Itemtype-badge | `itemTypeBadge` 5538 | indirect (seed heeft `type`) |

## 5. Live- en handmatige timer, tijdcorrecties

|---|---|---|
| Timerpaneel live | `renderTP` 3946, `renderTPLive` 3950, `setCD` 4009, `setNxt` 4017 | operator: *open project…* (artiest in `#tpanel`) |
| Handmatige timer (start/pauze/reset/vorige/volgende/nudge) | `M`, `mReset` 2872, `mPP` 2873, `mStop` 2874, `mPrev`/`mNext` 2875/2876, `nudge` 2877, `renderTPManual` 3986, `renderTbar` 2878 | operator: *manual timer mode toggles*; regression dialogs-forms: *manual mode: cards never reset…*; correcties tijdens pauze: gat (BOUWPLAN 1.4) |
| Modus live/handmatig | `setMode` 4855 | operator: *manual timer mode toggles* |
| Snelle correctie ±1/±5 min | `adjustLiveShow` 5606, `_writeShowTimes` 5590, `renderQuickAdjust` 5676 | operator: *cues, blackout and quick adjust…* (+5 min); regression dialogs-forms: *time correction* (annuleren, beide keuzes, voorvertoning) |

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
| Artiesten check-in (`?mode=checkin`) | `openCI` 7796, `renderCI` 7799, `ciToggleArrived` 7849 → RPC `set_show_arrived` | public: *check-in view marks an artist arrived through the RPC*; regression/views: *check-in …* (dubbele tik zichtbaar geblokkeerd, fout in de rij, geen verborgen shows); regression/checkin-stagemanager: rider (regeleinden, als tekst), zoeken, podiumfilter, gekozen dag blijft staan |
| Check-in in de app (navigatie: header, mobiele balk, Views-menu) | `openCI` (actief podium + dag), `_pickStageCI` (incl. *All stages*), zoeken `#ci-search`, toggle ≥ 56 px → save-queue | regression/checkin-stagemanager: *navigation …*, *check-in in the app …* (aankomst via PATCH, geen RPC; rider; 390/1440 zonder zijwaarts scrollen) |
| Stage manager (app + `?mode=stagemanager&sid=`) | `openSM`/`renderSM`/`tickSM`, `_smArrLevel` (amber ≤ 60 min, rood ≤ 15 min / gestart), aankomst via `ciToggleArrived`; deeldialoog-rij *Stage manager* (kan check-in wijzigen) | regression/checkin-stagemanager: nu/volgende + aftellers (page.clock), drempels 60/15, `set_show_arrived` op de link, rider + XSS, crew alleen in de app, lege staat, wake lock, 390/1440; regression/share-mode: zelfde DOM op gestripte feed |
| Kleedkamerscherm (`?mode=dressing&pid=&shid=`, root `#dres`) | `// ══ DRESSING ROOM`: `openDres`/`renderDres`/`tickDres`, `_dresState` (before/live/after/cancelled/missing/tba), `_dresCd`, `_dresMeta`, `_dresBg` (video → foto → donker), `_dresVideo` (`#dres-video`), `_dresImg` (`#dres-img`), `_safeVideoSrc`; `PUBLIC_SHID`; `_NAT_BAR` `['dres',0]` | regression/dressing-room: *states* (aftellen + "N days", omslag naar *On stage now* op de start, resterende settijd, bedankscherm met handtekening, show weg / verkeerde shid, geannuleerd, verborgen show blijft, project bestaat niet, niets aanklikbaar en linksboven 120×120 vrij), *background video* (muted/loop/playsinline/autoplay/preload, speelt in Chromium, `src` niet opnieuw gezet door ticks/polls maar wel bij een nieuwe `bgVideo`, kapotte video → foto, video/foto weg, na de show gepauzeerd + verborgen en foto gedimd, legacy-feed), `_safeVideoSrc` + onveilige opgeslagen waarden, *thank-you logo* (legacy- én per-modus-feed, witte plaat ongeacht branding, server zonder logo → alleen tekst, RPC: `logo`/`bgImage` alleen voor dressing), *layout* 1024×768 / 768×1024 / 390×844 × voor/tijdens/na; regression/share-mode: eigen `p_mode`, gestripte payload, zelfde DOM op beide feeds; mock: host `media.stagetimer.test` (`clip.webm`, `missing.mp4`, `slow.mp4`) |
| Publieke views laden + 1 s poll | `loadPublicView` 7964, `_rpc` 2305 → RPC `get_shared_project`, early fetch in `<head>` | public (alle), public: *stage view picks up operator changes through the 1 s poll*; regression/logic: *share link first load* (5xx/timeout → "Connecting…" + backoff; null → "Project not found.") |
| Deellink-data per modus (`p_mode`), terugvalketen, versiepoll | early fetch in `<head>`, `_fetchSharedProjectRaw` (2-arg → 1-arg → tabel, `_sharedProjectVia`), `_pvFetchChanged` (`get_shared_project_version`) | regression/share-mode: *every mode asks for its own p_mode*, *stripped payload*, *every view renders the same on the stripped feed*, *fallback chain* (ook 401/5xx: geen terugval), *version poll*, *field matrix in the SQL*; booth: elke publieke toestand op legacy- én gestripte feed |
| Gedeelde view-helpers (statuswoorden, datumlabel, lege staten, sync-pil) | `vwStatusKey`, `vwChip`, `vwDateLabel`, `vwDayLabel`, `vwEmptyKind`/`vwEmptyHTML`, `vwTickSync`, `vwSame` | regression/views: *empty states …*, *last sync …*, *status words …*, *timeline …*, *overview …*, *… keep their DOM across poll refreshes* |
| Mobiele timer-sheet, navigatie | `toggleMobTimer` 8151, `_syncMobNavActive` 4862 | booth in-app 390×844 (via mob-nav), verder gat |
| Wake lock / fullscreen | `_acquireWakeLock`, `_WAKE_VIEWS` (bs, sv, foh, tl, stov, wv, smv, dres), `_goFullscreen` | regression/views: *wake lock …* (FOH, Timeline, Overview, Wall, Backstage + re-acquire na visibilitychange); regression/dressing-room: *kiosk* (kleedkamerscherm + zoomslot); fullscreen: gat |

## 7. Cues en blackout

|---|---|---|
| Cue sturen / custom / wissen, status | `sendCue` 5741, `sendCustomCue` 5750, `clearCue` 5756, `_cueActive` 5761, `renderCueStatus` 5767 | operator: *cues, blackout…*; regression dialogs-forms: *target stage, active cue, duration and blackout are visible* |
| Cue-overlay op viewers | `_renderCueOverlay` 5786 | booth: *cue-wrapup*, public: *…1 s poll* |
| Blackout | `toggleBlackout` 5710, `renderBlackout` 5716 | operator: *cues, blackout…*, booth: *blackout* |
| Hoofdtick (250 ms) | `tick` 5808 | alle booth-tests (deterministisch via `page.clock`) |
| Bericht naar booth (sheet, 5A) | `openCrewMsg`, `cmSend`, `cmSendPreset`, `_cmRender`, `sendCue(…, {stageId})` | regression/phase5-crew: *390x844: presets, free text, stage, duration, clear and blackout…*, *1440: side panel…*, *free text is shown as text…* |
| Ontvangstbevestiging en aanwezigheid (5D) | `_pcSync`, `_pcStart`/`_pcStop`, `_pcOnAck`, `_pcOnPresence`, `_pcReceipt`, `_pcPresence`, `_pcRender` | regression/phase5-crew: *booth screen joins, acknowledges…*, *no ack within 3 s…*, *in-app Stage View… booth screen too*, *Realtime unavailable…*, *join refused…*, *anonymous broadcasts cannot…*, *project switch…*; booth-suite: Stage View pixel-gelijk |

## 8. Crew, statussen en push

|---|---|---|
| Crew per show + status (present/otw/unknown) | `fohCrewHTML` 4229, `setCrewStatus` 4242, `CREW_ROLES` (~4228) | seed bevat crew + statussen; klikken: gat |
| Crewselectie project (`memberIds`) | `openCrewModal` 7630, `renderCrewList` 7646, `toggleCrewMember` 7660 | regr: `test.fail` *crew selection is saved* (bug `saveProj`, BOUWPLAN 1.5) |
| Push (OneSignal) init / permissie / ingeplande pushes | `initOneSignalUser` 7671, `requestPushPermission` 7684, `scheduleProjectPushes` 7697, SDK alleen op stagetimer.nl | regression/logic: *crew pushes via send-push* (velden/festivaltijd, JWT, 404 → "Push is not configured yet"); versturen loopt via edge function `send-push`, niet meer direct naar OneSignal |

## 9. Notities, foto's, logo

|---|---|---|
| FOH-notities (tijd, kleur, tekst) | `openFohnModal` 4326, `saveFohnNote` 4344, `delFohnNote` 4351, `fohNotesHTML` 4256 | operator: *FOH screen* (notitie zichtbaar; seed bevat `<script>` in notitie) |
| FOH-cue-alerts (getimede notities: aankomend/bijna/nu/voorbij, aftellen, aria-live, scroll, optionele piep `st_foh_sound`) | `fohCueAtMs`, `fohCueState`, `fohCueCdText` (tijdmodule), `_fohCueTick`, `toggleFohSound`, `_fohBeep` | unit/foh-cue: tijd t.o.v. de show (normaal, over middernacht, 07:00-regel, legacy zonder datum, ongeldig), drempels; regression/foh-cue-alerts: statusovergangen + aftellen (1440/390, publiek), element blijft hetzelfde, aankondigingen, XSS, reduced motion, scroll-in-view (en niet tijdens scrollen), in-app + geluid |
| Show-notitie | veld `note` in `saveShow` | operator: *show editor…* |
| Kleedkamervelden in de showeditor (`show.bgVideo` = https-link, `show.bgImage` = foto) | `_drDresFill`, `_drVideoSync`, `clearBgVideo`, `previewBgImage`/`clearBgImage`/`_drBgSync`, `_photoUpload(d,'bg')`, `_imageFileOf`/`_readDataUrl` (gedeeld met `previewPhoto`), `_mediaInUse`/`movePhotosToStorage` kennen `bgImage`; link in de editor: `dresLinkOf` + `_shareRowHTML`; import: `video` per act | regression/dressing-room: *show editor* (link fout tijdens typen + blokkeert opslaan, opslaan als `bgVideo`, leegmaken = sleutel weg; foto → Storage-URL, artiestfoto onaangeroerd, weghalen verwijdert het object; geen afbeelding → dialoog; link alleen bij een bestaande show), *lineup import* (`video`, foute link = rij overgeslagen); unit/dressing-merge.test.js: 3-way merge per veld (zetten, leegmaken, van elders, beide kanten) |
| Rider per show (`show.rider = {drinks, tech}`, vrije tekst, max. 2000 tekens per veld) | `riderOf`/`hasRider`/`_riderSummary` (`// ══ RIDER`), drawer: `_drRiderErr`/`_drRiderCount`/`_drApplyRider` (alleen bewerkte velden), chip in `renderSched`, import: `_importRider` | regression/rider-data: opslaan/wijzigen/leegmaken (`{}`), veld van een collega blijft staan (merge + realtime), lengte inline + blokkeert opslaan, unsaved-guard, chip met tooltip (1280/390), XSS in chip/editor/importvoorbeeld, import (`drinks`/`tech`, `rider:{}`, plat formaat, fouten), deellinks: alleen checkin en stagemanager krijgen `rider`, legacy alles, `set_show_arrived` houdt hem; unit/rider-merge.test.js: 3-way merge per subveld; regression/share-mode: `keep_rider` = matrix, bekende modi = `SHARE_MODES`; regression/export: rider in de export |
| Artiestfoto (base64, compressie) | `previewPhoto` 4781, `_compressImage` 4764, `clearPhoto` 4803, `setTPPhoto` 4804 | seed bevat foto; verwijderen: gat (BOUWPLAN 1.5) |
| Projectlogo (co-branding) | `openProjectLogo` (dashboardrij + Project settings), `handleLogoUpload`, `removeProjectLogo`, `_setLogoBranding`, `refreshLogo`/`_vwLogo` (Backstage/FOH-header), `_safeLogoSrc`, `_logoWantsBackdrop` | regression/project-logo: upload vanuit de dashboardrij → Storage-URL + `branding`, bucket ontbreekt → base64, voorbeeld donker/wit, toggles Backstage/FOH/witte plaat (automatisch bij donkere inkt), Project settings, weghalen (object verwijderd), realtime, oud logo zonder `branding` blijft verborgen, geen afbeelding → geweigerd, 390 px zonder overlap, deellinks backstage/foh tonen het en stage niet, alleen backstage/foh krijgen `logo`, kijker kan niets wijzigen, XSS/vreemde URL's nooit getoond; regression/share-mode: `keep_logo` = matrix; unit/sync-engine.test.js: *logo on a project that is not open* (`_saveProjectById`) |

## 10. Import

|---|---|---|
| JSON-import dialoog | `openJSONModal` 5929, `doJSONImport` 5937 | operator: *import dialog opens* |
| Lineup importeren | `importLineup` 5969 | gat (BOUWPLAN 1.3: seconden, ontbrekende `end`, andere podia) |
| Rider in de lineup-import | `_importRider` in `_planLineupImport`, voorbeeld in `_renderImportPreview` | regression/rider-data: *import…* |
| Project exporteren (JSON, AVG art. 20) | `exportProjectJSON` (Project settings) | regression/export.spec.js: admin en operator, geen bedrijfs-/factuurvelden |
| Juridische concepten | `privacy.html`, `voorwaarden.html`, footer `index.html` | smoke/legal-pages.spec.js: 390 en 1440 px, offline, geen consolefouten |

## 11. Deellinks en losse timers

|---|---|---|
| Deeldialoog (alle URLs per podium) | `openShareModal`, `_shareRowHTML`, `copyLink`, `_shareDresHTML` (ingeklapte kleedkamerlinks per podium en dag) | operator: *share-link dialog lists every public URL*; regression/views: *share dialog …* (alleen-lezen/check-in per link, kopieerfout + fallback, 390 px); regression/dressing-room: *share dialog* (ingeklapt, per dag, geen geannuleerde, wel verborgen shows, alleen-lezen) |
| Losse timers (one-off) | `loadOT` 8216, `saveOTTimer` 8280, `delOT` 8291, `renderOTSection` 8240, `openOTV` 8298, `tickOTV` 8322, `isOTLive` 8236 | operator: *one-off timer can be created*; over middernacht: gat (BOUWPLAN 1.4) |

## 12. Platformbeheer (super_admin)

|---|---|---|
| Adminpagina, KPI's, companies, users | `openAdmin` 6735, `renderAdmin` 7043, `_renderKpis` 6946, `_subBadge` 6920 | admin: *admin page lists companies, users and vouchers* (incl. badge "Awaiting activation", geen setup_token) |
| Company toevoegen / bewerken / stage-override / verwijderen | `addCompany` 7182, `editCompany` 7192, `setStageOverride` 7205, `delCompany` 7221 | regression/logic: *delCompany uses admin_delete_company / without the RPC* (rest: gat); smoke dialogs: *platform admin: rename workspace…* (toevoegen / verwijderen: gat) |
| User toevoegen / rol / verwijderen | `addUser` 7246, `changeUserRole` 7305, `delUser` 7318 | regression/logic: *changeUserRole* (RPC, terugval alleen bij ontbrekende RPC, weigering) (rest: gat); smoke dialogs: *platform admin: …change role, remove user*; uitnodigen: regression dialogs-forms *invite* |
| Vouchers (Stripe promotiecodes via edge `manage-voucher`) | `loadVouchers` 6768, `createVoucher` 6871, `archiveVoucher` 6897, `activateVoucher` 6906 | admin (lijst via gemockte functie) |

## 13. Reviewbevindingen 13 oktober 2026 (`tests/regression/review-fixes.spec.js`)

| Bevinding | Code | Test |
|---|---|---|
| Verouderd object na een dialoog (realtime-update terwijl de dialoog open is) | `saveShow`, `setDayDate`, `delDay`, `selMCueUI`, `renameProject`, `editCompany`, `setStageOverride`, `changeUserRole`, `saveWorkspaceName`: na elke `await` opnieuw opzoeken op id | *saveShow: "Save anyway" after a remote update…*, *setDayDate: "Change date" after a remote update…* |
| Refetch tijdens een lopende refetch ging verloren | `_refetchProject` (`refetchAgain`) | *_refetchProject: a refetch requested while one is in flight…* |
| Laatste stage van een leeg project verwijderen werd door de wipe-guard geweigerd | `delStage`, dedup in `_applyLineupImport` (`_markIntentionalRemoval`) | *delStage: deleting the last stage of an empty project…* |
| PT402: nieuwe stage weg, shows bleven als wezen achter | `_dropRefusedStages` | *plan limit (PT402): a refused new stage takes its unsaved shows…* |
| Offline opstarten: herinloggen alleen op `online` | `_reauthUntilOnline` (timer 15/30/60 s, `visibilitychange`, `online`) | *offline boot: re-auth retries on a timer…* |
| 429/408 van de auth-server logde uit | `_authUnreachable` in `_authProbe`/`_authRefresh` | *429 / 408 from the auth server…*, *408 on the refresh after a rejected probe…* |
| XSS via ids uit de blob (`id="scd-…"`, `delFohnNote('…')`, losse timers, vouchers) | `renderSched`, `renderOTSection`, `renderVouchers`; `_normIds` in `loadG` | *operator list: no execution…*, *share link (FOH): no execution*, *voucher ids in inline handlers…* |
| `_restWrite` vroeg impliciet `RETURNING *` (42501 met kolomrechten op companies) | `_restWrite` (`select=id`); mock: `backend.hiddenColumns` | *workspace rename asks for select=id…*, *delete workspace (direct-write fallback)…* |

## 14. Native app (BOUWPLAN fase 6, `tests/regression/native-mode.spec.js`, `tests/regression/native-booth-mode.spec.js`)

Alle native takken hangen aan `IS_NATIVE` (`window.Capacitor.isNativePlatform()`). De specs zetten vóór het laden een nep-`window.Capacitor` (opnemende plugins `App`, `Haptics`, `Share`, `StatusBar`, `SplashScreen`, `KeepAwake`) en een nep-`window.plugins.OneSignal` neer (`goNative` in `tests/support/native-shell.js`); elke aanroep wordt via een binding in Node bewaard, ook vlak voor een navigatie. Elke native test heeft een web-tegenhanger zonder nep-Capacitor.

| Functie | Code | Test |
|---|---|---|
| Vlag en helpers | `IS_NATIVE`, `WEB_APP_URL`, `_nat`, `_natCall` (UTILS) | alle tests in de spec; web: *web: … no native calls* (`window.Capacitor` wordt niet eens gelezen) |
| Deellinks naar `https://stagetimer.nl/app?mode=…&pid=…[&sid=…]`; web ongewijzigd | `_shareBase` | *native: share links point at https://stagetimer.nl/app…*, *web: share links unchanged…* (ook regression/views en checkin-stagemanager) |
| iOS-deelmenu naast Kopiëren | `_shareRowHTML` (knop *Share* alleen met de Share-plugin), `shareLink`; `copyLink` ongewijzigd | *native: share links …, Share opens the iOS sheet, Copy still copies* |
| Wachtwoordherstel en Stripe-retour naar de webapp | `sendReset` (`redirect_to`), `manageSubscription` (`returnUrl`) | gat (alleen via code-review; de knop naar de portal is in native verborgen) |
| Geen aankoop-UI (Apple 3.1.1) | `renderSubscriptionPage` (geen prijzen, geen *Invite member*, geen *Manage billing in Stripe*), `renderSubscriptionBanner` (neutrale tekst, geen knop/link), `showLimitModal` (geen actieknop), `canCreateProject`, `checkStageLimit`, `_planText` (ook in `humanError`, `_dropRefusedStages`, `createProject`), beheerknop *Manage subscription*, `manageSubscription`/`openInviteMemberPrompt` doen niets | *native: no purchase UI …*, *web: purchase UI present as before*, *workspace without a subscription › … banner …* |
| Fullscreen-menu weg, geen "Add to Home Screen"-hint | `_setupFullscreen` (verwijdert `[data-fs]` + losse scheidingslijn), `openOTV` | *native: fullscreen menu items gone; web keeps them* (hint: gat) |
| KeepAwake i.p.v. `navigator.wakeLock` | `_acquireWakeLock`, `_releaseWakeLockIfIdle` (`_natAwake`) | *native: KeepAwake on FOH / Backstage open, allowSleep…* |
| Geen service worker | registratieblok onderaan (`!IS_NATIVE`) | *native: no service worker is registered; the web registers one as before* |
| OneSignal native (zelfde appId, external id = user id, prompt via de crewknop, logout, geen tags) | adapter `_natOneSignal` op `window._OS` (ONESIGNAL); `initOneSignalUser`, `requestPushPermission`, `updateCrewPermBtn`, `doLogout` ongewijzigd | *native: OneSignal through the native plugin…* (ook: geen web-SDK, geen prompt bij start, uitloggen herlaadt de gebundelde pagina) |
| Haptiek | `sendCue`, `clearCue`, `toggleBlackout` (LIGHT), `_pcOnAck` (SUCCESS bij de eerste bevestiging, nooit op Stage View of een deellink) | *native: haptics on cue, clear and blackout; success when a booth screen confirms* |
| Universal Links (`appUrlOpen`) | `_natOpenUrl`, blok `// ══ NATIVE APP` vóór INIT | *native: a Universal Link (appUrlOpen) to a share link opens that screen; other hosts are ignored* |
| Statusbalk volgt het scherm: lichte backoffice (`#dash`, `#admin`, lichte Wall) donkere tekst (`LIGHT`), de rest lichte tekst (`DARK`); het bovenste zichtbare scherm beslist, check elke 250 ms, plugin alleen bij een wijziging | `_natBarSync`, `_NAT_BAR` (NATIVE APP) | booth-mode: *native: status bar text follows the screen…*; native-mode: *native: share links …* (`DARK` dan `LIGHT` bij het dashboard) |
| Eerste start: keuze *Booth screen* / *Crew & control* (alleen native, alleen zonder rol; een al ingelogd toestel wordt stil `crew`); rol in `st_native_role_v1` | `<head>`-script (klasse `nat-choose`, vóór de eerste paint), `#nat-role`, `_natRoleGate` (INIT, na deellinks en auth-links), `natChooseRole`, `natRoleBack` | *native: first launch shows the chooser; Crew & control goes to the login form…*, *web: no chooser, the login form as before* |
| Boothscherm instellen: deellink (elke modus, met/zonder `https://`, `www.`, `/app.html`) of projectcode; projectfeed als deellink (anon key, `get_shared_project(p_id,'stage')`); stagekiezer (overgeslagen bij een stagelink met `sid` of één stage); daarna herlaadt de gebundelde pagina als `?mode=stage&pid&sid` (bestaand publiek pad, geen tweede Stage View) | `_natParseBoothCode`, `natBoothContinue`, `_natStagePicker`, `natBoothOpen`, `_fetchSharedProject(pid,ms,mode)` | *native: Booth with a stage share link…*, *…a project code (or another mode's link) shows the stage picker…*, *a project with one stage needs no picker* |
| Volgende start direct naar de stage (redirect in `<head>`, geen login-flits) | `<head>`-script, `_natRoleGate` | *native: Booth with a stage share link opens that Stage View; every next launch goes straight there* |
| Vriendelijke fouten bij instellen: geen link/code, onbekend project, geen netwerk (`_friendlyError`) | `natBoothContinue`, `_natErr` | *native: a bad code, an unknown project or no network give a friendly message…* |
| Offline koude start boothscherm: kopie van de laatste feed in `st_native_booth_cache_v1` (zonder `photo`/`logo`/grote `data:`-URI's, max. 1,5 MB), gebruikt als de feed bij het starten onbereikbaar is (vroege fetch max. 4 s, één directe poging); de bestaande 1 s-poll haalt daarna de live data. Web: geen kopie, zoals voorheen *Connecting…* | `loadPublicView`, `_pvAdopt`, `_natBoothKeep`, `_natBoothCachePut`, `_natBoothCacheGet` | *native: offline cold start shows the copied show, then follows the live feed again*, *web: a stage share link keeps no copy…* |
| Verborgen uitgang boothscherm: 3 s vasthouden linksboven (120×120 px; te kort, elders, slepen of tweede vinger telt niet) → `stDialog.choice` *Change stage* / *Switch to Crew & control* / *Cancel*; alleen listeners, geen element of stijl op `#sv` | `_natInstallBoothExit`, `_natBoothMenu` | *native: hidden exit (hold the top-left corner 3 s)…* (booth-pixeltests ongewijzigd) |
| Crew-toestel → boothscherm: menu-item (accountmenu + mobiel menu, `data-nat-only`) en kaart op *Account settings*; bevestigen, uitloggen, dan de booth-instelling | `natUseAsBooth`, `renderProfilePage` | *native: "Use this device as a booth screen" logs out…*, *web: no booth item in the menus or account page…* |
| Live Activity (vergrendelscherm + Dynamic Island, fase 6 stap 4): volgt de gekozen stage en het timerpaneel van dit toestel (live show, anders de volgende van vandaag; lopende handmatige timer telt af naar zijn eigen deadline, gepauzeerd/idle staat bevroren); de plugin alleen bij een ander beeld, nooit per tick; andere stage = nieuwe activity; einde bij uitloggen; tijden op de toestelklok (server-offset eruit) | blok `// ══ LIVE ACTIVITY (native)` (`_laState`, `_laPayload`, `_laSync` vanuit `tick`, `_laEnd` vanuit `doLogout`); plugin `StLiveActivity` in `native/ios/App/App/StLiveActivityPlugin.swift` | `regression/native-live-activity.spec.js` (nep-`StLiveActivity`): *follows the selected stage…*, *manual timer: the countdown target is the timer panel's own deadline…*, *Live Activities unavailable…*, *web (no Capacitor): nothing runs*, *share link (?mode=stage): the plugin is never called*. De Swift-kant (weergave, ActivityKit-fouten) alleen via de simulator (debugstart `-STLiveActivityDemo`) |
| Lokale nep-backend voor de iOS-simulator (echte HTTP + WebSocket op 127.0.0.1, dezelfde `MockBackend`; demo-seed rond "nu", testlogin in `tests/support/mock-server.seed.json`) | `tests/support/mock-server.js`, `MockBackend.handleRequest`, `demoSeed` in `seed.js`; `npm run mock:server` | smoke mock-server: *login, projects and realtime run through the local mock server* (app.html met `SUPA_URL` naar de server, echte CORS) |

## Bekende gaten in het vangnet
- `confirm()`/`prompt()`/`alert()` zijn vervangen door de stDialog-component (`form.st-dlg[role=dialog]`); tests klikken op de knoppen in de dialoog. Een native dialoog laat smoke *dialogs* en regression *dialogs-forms* falen. Nog zonder eigen test: company toevoegen/verwijderen, vouchers archiveren/activeren, project aanmaken-fouten.
- Echte Safari/iOS, pushmeldingen, e-mail, Stripe en de productiedatabase worden niet getest (BOUWPLAN "Expliciet niet getest").
- Realtime-stub: alleen `postgres_changes` (join/heartbeat/leave/push). Broadcast/presence worden niet gebruikt door de app en niet nagebootst.
