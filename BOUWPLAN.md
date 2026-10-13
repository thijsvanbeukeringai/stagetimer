# Bouwplan Stagetimer — verbeterronde oktober 2026

Dit plan voegt drie bronnen samen:

- de opdrachtbriefing van Thijs (UI, bediening, betrouwbaarheid);
- vijf audits door subagents: beveiliging, sync/betrouwbaarheid, architectuur, UX/performance en ops/business;
- de spoedkwestie rond `companies.setup_token`.

**Status: dit is een plan. Er is nog niets aan de code gewijzigd.** Elke fase begint pas na akkoord.

---

## 0. Uitgangspunten

### Werkmap
De werkmap is `/Users/thijs/Desktop/AI projecten/Stagetimer`.

`~/Documents/ChatGPT/Stagetimer` staat op dezelfde commit (`d184f72`), maar mist het nog niet gecommitte RLS-werk. Dat gaat om `app.html` (+253/−106), `vercel.json` en de map `supabase/migrations/`. Alle regelnummers hieronder verwijzen naar de Desktop-werkkopie. Ze verschuiven tijdens het werk, dus zoek op functienaam.

### Harde voorwaarden (uit de briefing, ongewijzigd)
- Alle bestaande functies blijven behouden.
- **Boothscreen / Stage View blijft visueel exact gelijk.** Dat geldt voor layout, lettergroottes, kleuren, animaties, klok, voortgangsbalk en weergavemodi. Fouten in de gegevensaanvoer en de timerberekening mogen wel hersteld worden.
- Bestaande projecten, shows, crew, foto's, notities, instellingen en deelbare links (`?mode=…&pid=…`) blijven werken.
- Geen nieuwe productfuncties, geen frameworkmigratie, geen volledige herschrijving.
- Bestaande niet-opgeslagen wijzigingen in de repo worden gerespecteerd. Het RLS-werk wordt eerst op een eigen branch gezet.
- **Geen productiedata wijzigen, niet deployen, geen echte uitnodigingen, meldingen of abonnementen.** Controles gebeuren met testdata en gesimuleerde serverreacties.
- Backendwijzigingen worden alleen voorbereid als migratie met een herstelstrategie. Thijs voert ze zelf uit.

### Afgeleide regels uit de audits
- Kleurenblind-veilige statussen, `prefers-reduced-motion` en zoom gelden **alleen buiten Stage View**.
- Vercel serveert de hele map statisch (`outputDirectory: "."`). Alles wat we toevoegen, zoals `tests/`, `package.json`, `supabase/` en dit `BOUWPLAN.md`, wordt dus **publiek** als het gecommit wordt. Daarom komt er eerst een `.vercelignore`.
- Elke fase landt op een eigen branch met kleine commits. Er gaat niets direct naar `main`.

---

## FASE S — SPOED: overname van accounts via `setup_token`

### Het probleem
1. `signup-checkout` maakt een company aan met een `setup_token`.
2. Na betaling stuurt Stripe de klant naar `/app?signup=success&cid=…&t=…`.
3. `completeSignup()` stuurt `{companyId, token, password}` naar `finalize-signup` en krijgt een sessie terug.
4. De app leest companies met `select=*` (`_restGet('companies')` in `loadAPPRemote`, plus `supa.from('companies').select('*')` op 4 andere plekken). De token wordt in de client gemapt als `setupToken` (rond regel 2399 en 2615). De client vertrouwt er dus op dat de database companies vrijgeeft.

### Waarom dit een overname-risico is
Als RLS uit staat (zie §S.1), kan iedereen met de publieke anon-key de `cid` en `setup_token` lezen van elke company die nog niet geactiveerd is. Daarmee kan een aanvaller `finalize-signup` aanroepen met een eigen wachtwoord:

- **Zonder e-mailverificatie** krijgt de aanvaller direct een sessie als eigenaar.
- **Met e-mailverificatie** is het bijna net zo erg. Klikt het slachtoffer de verificatielink aan, dan bestaat het account met het wachtwoord van de aanvaller. De aanvaller kan daarna inloggen.

### Tweede route (schrijven)
Als anon `companies` ook mag **updaten**, kan een aanvaller de `setup_token` van een wachtende company zelf op een bekende waarde zetten. Dat heeft hetzelfde gevolg. De fix moet dus ook schrijfrechten dichtzetten.

### S.1 Eerst vaststellen (Thijs voert uit; de classifier blokkeerde Claude terecht voor productie-reads)
Voer dit uit in de Supabase SQL-editor. Het is alleen-lezen:

```sql
-- Staat RLS aan op companies, en welke rechten hebben anon/authenticated?
select relname, relrowsecurity from pg_class where relname in ('companies','app_users','projects');
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema='public' and table_name='companies' and grantee in ('anon','authenticated');
-- Hoeveel companies hebben nu een openstaande token? (alleen een telling)
select count(*) from public.companies where setup_token is not null;
-- Exacte kolomlijst; nodig voor S.3
select column_name from information_schema.columns
 where table_schema='public' and table_name='companies' order by ordinal_position;
```

Of van buitenaf, met de anon-key uit `app.html` in `$ANON`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://bamjpsquhdzxvsymldpq.supabase.co/rest/v1/companies?select=id,setup_token&limit=0" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
# 200 = lek is live · 401/403 = afgesloten
```

**Als het lek live is, doe ook dit (Thijs):**
- Bekijk de logs van de edge function `finalize-signup` (Supabase → Edge Functions → Logs) op onverwachte aanroepen of IP's.
- Zet de companies met een openstaande token op een rij. Neem contact op met die klanten, of geef ze een nieuwe link.
- Download de broncode van de edge functions (`supabase functions download finalize-signup signup-checkout`). Zo kunnen we zien of de token na gebruik gewist wordt, of hij verloopt en hoe hij vergeleken wordt.
- Controleer in het dashboard of publieke Auth-signups uit kunnen. Dat kan alleen als `finalize-signup` gebruikers aanmaakt via de admin-API. Als publieke signups aan staan, kan iedereen een `authenticated`-rol krijgen.

### S.2 Clientfix in `app.html` (Claude)
- Vervang elke `select=*` / `select('*')` op `companies` door een expliciete kolomlijst **zonder** `setup_token`. Dat raakt `loadAPPRemote`, de realtime/refresh-route bij regel 2615, en de admin-loads rond regels 6488, 6716, 7266 en 7310.
- De admin-badge "Awaiting activation" en het filter `pending` (rond regel 6895) gaan de nieuwe kolom `setup_pending` gebruiken in plaats van `setupToken`.
- Doe hetzelfde in `festival-dashboard.html` als die nog companies leest. Een betere oplossing staat in §4.6: verwijderen.
- Test: gesimuleerde REST-antwoorden zonder `setup_token`. De admin-overzichten, plan-limieten en abonnementsweergave moeten gelijk blijven.

### S.3 Voorbereide migratie `supabase/migrations/<ts>_hotfix_setup_token.sql` (Claude schrijft, Thijs voert uit)
Volgorde:
1. Kolom toevoegen.
2. Client deployen.
3. Rechten intrekken.

Alleen in die volgorde breekt er niets.

```sql
-- Stap 1 (onschadelijk, kan meteen): afgeleide vlag die de token zelf niet prijsgeeft
alter table public.companies
  add column if not exists setup_pending boolean generated always as (setup_token is not null) stored;

-- Stap 2: client uit S.2 deployen en een paar minuten wachten. app.html is no-store, dus een reload haalt de nieuwe versie.

-- Stap 3: token onleesbaar en onbeschrijfbaar maken voor clients
revoke select, update on public.companies from anon, authenticated;
grant select (<alle kolommen uit S.1 behalve setup_token>) on public.companies to authenticated;
grant update (name, live_stages_override) on public.companies to authenticated;  -- de enige kolommen die de client bijwerkt
-- anon: geen rechten. Eerst controleren dat geen enkele publieke view companies leest (zie S.4).
```

- **Rollback:** `grant select, update on public.companies to anon, authenticated;`
- **Timing:** niet tijdens een live show. Tabbladen die nog een oude versie draaien, krijgen een fout bij `select=*` tot ze herladen worden.

### S.4 Controleren voor stap 3
- Leest een publieke share-view (`loadPublicView`) companies? Zo ja, dan krijgt anon een beperkte kolom-grant.
- Werkt de admin-flow `insert` op companies (rond regel 7076) nog?
- Lezen de edge functions met de service role? Die omzeilt grants, dus dat is verwacht.

### S.5 Structureel (na de spoedfix, als de functiecode in de repo staat)
- Verplaats tokens naar een aparte tabel zonder client-grants.
- Laat tokens verlopen (bijvoorbeeld 7 dagen) en maak ze eenmalig.
- Vergelijk tokens in constante tijd.
- Zet een rate-limit op `finalize-signup`.

### Nog een spoedpunt voor vandaag (Thijs)
De **OneSignal REST API-key** staat hardcoded in de code (`OS_REST_KEY`, regel 7643, sinds commit `71c4cda`). Iedereen kan daarmee pushmeldingen naar je crew sturen, zoals een nep-"Stage evacuated". Roteer die key in OneSignal. Na het roteren werkt push-versturen vanuit de client niet meer, tot §1.9 klaar is. Kies dus bewust het moment.

---

## FASE 1 — Gegevensbehoud, opslag, import en timerfouten

### 1.0 Vangnet vooraf (Claude)
- Zet het bestaande ongecommitte werk op een branch: `git switch -c rls-prep` en commit het. Daarna komt het verbeterwerk op `improve/fase-1`, afgetakt van die branch.
- Voeg `.vercelignore` toe voor `tests/`, `package.json`, `node_modules/`, `supabase/`, `*.md` en `.devserver.py`.
- Zet een testharnas op in `tests/`:
  - Playwright met een minimale `package.json` die alleen dev-dependencies bevat.
  - De app wordt geserveerd via `.devserver.py` of `python3 -m http.server`.
  - Supabase REST, RPC en edge functions worden gesimuleerd met `page.route`. Realtime wordt gestubd.
  - `supabase-js` wordt lokaal gemockt, zodat de tests offline draaien.
  - De tijd wordt bestuurd met `page.clock`.
- **Referentiescreenshots van het boothscreen** maken we vóór welke wijziging dan ook:
  - testproject met representatieve data;
  - vaste tijdstippen: vóór de show, midden in de show, laatste 5 minuten, laatste 30 seconden en overtime;
  - alle bestaande Stage View-modi;
  - de resoluties 1920×1080, 1280×720 en 390×844.
  - Deze screenshots zijn de baseline voor de pixelvergelijking (`toHaveScreenshot`, met tolerantie 0 waar dat kan).
- Inventariseer alle functies en schermen (briefing §1) en zet ze in `tests/INVENTARIS.md`. Elke functie krijgt minstens één smoke-test.

### 1.1 Opslaan: nooit meer stil dataverlies
| # | Probleem | Bron | Aanpak |
|---|---|---|---|
| a | Een realtime-bericht zonder `data` → `loadG()` bouwt een leeg project → de volgende save wist de lineup | audit sync C1; `setupRealtime` ~2565, `loadG` ~2430 | Payloads zonder `data.stages` negeren en het project opnieuw ophalen via REST. Daarnaast laat de wipe-guard nooit `stages:[]` over een niet-lege serverversie schrijven. |
| b | Een mislukte save wist de status "nog niet opgeslagen" | briefing; `_pushProject` ~2549 | `_pendingPush` blijft `true` tot de server de save bevestigt. Opnieuw proberen met backoff, ook bij `online` en `visibilitychange`. `beforeunload` blijft waarschuwen. |
| c | De wipe-guard draait een bewuste verwijdering terug en toont toch groen | briefing; guard ~2482–2512 | Bijhouden welke shows bewust zijn verwijderd (een lijst van id's per sessie), zodat een verwijdering te onderscheiden is van verouderde data. Grijpt de guard in, dan wordt de status "niet opgeslagen" met uitleg, nooit groen. |
| d | Twee saves kunnen tegelijk onderweg zijn en in de verkeerde volgorde aankomen. Een late echo kan nieuwere data overschrijven. | audit sync M4 | Eén save-queue die één save tegelijk verstuurt. Echo's van verouderde versies worden genegeerd. |
| e | `localStorage.setItem` gooit `QuotaExceededError` door base64-foto's, waarna de save afbreekt | audit sync C4 | Een try/catch rond de cache. De cache bevat geen foto's, alleen verwijzingen. De server-push mag nooit afhangen van de cache. |
| f | Gelijktijdig bewerken overschrijft het hele project ("last write wins") | briefing §10; audit C2 | Binnen de huidige architectuur: vlak vóór het versturen per show-id samenvoegen met de serverversie (die wordt al opgehaald voor de guard). Structureel, alleen voorbereid: een `version`-kolom met een `save_project(id, expected_version, data)`-RPC die bij een conflict een fout teruggeeft (migratie in §4.5). |
| g | Check-in schrijft het hele project terug | briefing §10 | Alleen het betreffende show-veld samenvoegen. De bestaande RPC `set_show_arrived` (in de RLS-migratie) wordt de enige schrijfroute. Dubbel klikken tijdens het opslaan wordt geblokkeerd. |
| h | Token-kopie `st_auth_v1` wordt niet ververst → **na ongeveer 1 uur falen alle saves** zodra het RLS-werk live staat | audit sync C3 + security M4; `_jwt()` ~2291 | `onAuthStateChange` (`TOKEN_REFRESHED`, `SIGNED_IN`) schrijft `saveAuthSession` bij. Bij een 401 één keer verversen en opnieuw proberen. **Dit blokkeert het deployen van het RLS-werk.** |
| i | Ingelogde schermen halen na wifi-uitval of slaapstand niets opnieuw op | audit sync H3 | Bij `online`, bij zichtbaar worden en bij een realtime-resubscribe het project opnieuw ophalen. Daarnaast een langzame polling als terugvaloptie. |
| j | Fouten bij kopiëren, hernoemen, opslaan en laden zijn onbegrijpelijk (`HTTP 4xx`, ruwe Supabase-meldingen) | briefing; UX-audit | Eén functie die fouten vertaalt naar begrijpelijke tekst. Getoond in een niet-blokkerende melding, niet via `alert()`. |

### 1.2 Gedeelde selecties
- **Probleem:** `activeStage`, `activeDay` en `timerMode` zitten in het gedeelde project. Bladert een operator naar Dag 3, dan springen andere operators en publieke monitors mee en tonen ze "geen show" tijdens een live set. Dit staat in de briefing en in sync-audit H1.
- **Aanpak:**
  - Persoonlijke schermselecties bewaren per apparaat (`localStorage`, per project).
  - Publieke views gebruiken altijd de festivaldag van vandaag, of de `sid` uit de URL.
  - De gedeelde velden blijven bestaan voor compatibiliteit, maar worden niet meer aangestuurd vanuit schermselecties.
  - `timerMode` uitzoeken: is dit bewust gedeeld? Zie 1.4.

### 1.3 Import
- Valideer de **volledige** import voordat er iets verandert, en toon een voorbeeld: wat wordt toegevoegd, wat vervangen en welke regels zijn ongeldig.
- Import voor één podium mag geen shows van andere podia op dezelfde dag verwijderen. Vervang alleen binnen (dag, podium).
- Tijden met seconden worden genormaliseerd: `20:00:30` blijft `20:00:30` en wordt niet `20:00:30:00`.
- Een regel zonder `end` laat de import niet meer crashen (`row.end.includes`, ~5981) maar geeft een validatiefout.
- Geïmporteerde shows krijgen een `startsAt`/`date` die consistent is met het ISO-model.
- De wipe-guard mag een bevestigde import niet stil terugdraaien terwijl er "Import successful!" staat.

### 1.4 Timer
| Probleem | Aanpak |
|---|---|
| Handmatig: +1 min tijdens pauze geeft soms +2. Pauzeren na een correctie laat de resterende tijd verspringen. | Het timerstatusobject (`M`, ~2844) omzetten naar één model van "deadline + gepauzeerd resterend". Dit is een pure functie met unit-tests. |
| De handmatige timer en Stage View tonen verschillende shows | Eerst uitzoeken wat bedoeld is. `M` wordt nu niet gesynchroniseerd (sync M3). De bestaande bedoelde werking wordt consequent toegepast via één functie die de "huidige show" bepaalt. |
| Geannuleerde shows kunnen als live worden gekozen (hoofdklok, Stage View) | Eén gedeelde filter in `curShow`/`nxtShow` en de terugvallogica. |
| Verborgen shows zijn zichtbaar in de publieke tijdlijn en via de terugval naar de eerstvolgende show in Stage View | Dezelfde gedeelde filter. |
| Een losse timer van 23:00 tot 01:00 geldt na middernacht niet meer als live | Losse timers krijgen hetzelfde model voor shows over middernacht als gewone shows. |
| Klokbronnen lopen uiteen: de Wall gebruikt servertijd (`_wvNow` ~5214), de andere views de apparaatklok. Tijden worden in de lokale tijdzone van het apparaat geparsed. | Overal één klokfunctie met de server-offset. Tijdzone vast op `Europe/Amsterdam` waar het model dat bedoelt. Dit valt onder "timerberekening" en mag dus ook voor Stage View. |
| De `tick` draait dubbel in publieke modus (8121 en 8632) | Eén interval. |
| Datum van een dag wijzigt terwijl shows expliciete datums of timestamps hebben | Uitzoeken en vastleggen. De gebruiker vooraf het effect tonen (zie 3.3). |
| Oude shows zonder datum | Blijven via de 07:00-grens werken. Krijgt regressietests. |

### 1.5 Losse fouten uit de briefing (zelf geverifieerd waar aangegeven)
- `toggleCrewMember` roept het niet-bestaande `saveProj()` aan (**geverifieerd**, regel 7638). Dit moet `save()` zijn, plus een test.
- Een verwijderde artiestenfoto komt terug, doordat de oude foto als terugvaloptie wordt gebruikt.
- Een apostrof (DJ O'Neil) breekt inline klikhandlers, waaronder + Note. Zie 1.6.
- Abonnement: de code detecteert `yearly`/`monthly`, maar de UI controleert op `year`, waardoor jaarbetaling als maand wordt getoond.
- `trialing` telt niet als actief bij de plan-limiet (`_effectiveStageLimit` ~5850, **geverifieerd**), dus trial-klanten krijgen 0 live stages. **Eerst bij Thijs navragen of dit bedoeld is.**
- Een mislukte wachtwoordreset-aanvraag toont toch een succesmelding.
- De herstelgegevens in de resetlink worden niet verwerkt. `detectSessionInUrl:false` en de `#set-pw`-modal wordt nooit geopend. Ook invites via e-mail zijn vermoedelijk kapot.
- De minimale wachtwoordlengte is 6 op de ene plek en 8 op de andere. Dit wordt overal 8.
- `doLogout` wacht `signOut()` niet af, dus het refresh-token blijft mogelijk geldig.
- Logo-upload is niet gecomprimeerd (~8153). Gebruik dezelfde compressie als bij artiestfoto's.

### 1.6 XSS en klikhandlers
- Het helperpad `escH` (~2261) consequent toepassen. Concrete plekken:
  - gebruikersnaam in de crewkiezer (~7630);
  - FOH-notitie `n.color` in een `style`-attribuut en `n.time` (~4233);
  - alle ~27 `onclick="fn('${id}')"` met id's of namen uit de data.
- Overstappen op `data-*`-attributen met event delegation. Dat lost tegelijk het O'Neil-probleem op.
- De Stage View-markup blijft byte-voor-byte gelijk, op attributen na die geen visueel effect hebben.

### 1.7 Publieke schermen (gegevensaanvoer)
- Elke publieke poll krijgt een guard die voorkomt dat een nieuw verzoek start terwijl het vorige nog loopt. Antwoorden die in de verkeerde volgorde binnenkomen, worden genegeerd.
- Publieke RPC's gebruiken altijd de anon-key en nooit een (verlopen) JWT van een eerder ingelogd apparaat. Een verlopen JWT laat het scherm nu bevriezen.
- Polls worden niet langer stil gegooid met `catch(e){}`. Er wordt een tijdstempel bijgehouden van de laatste geslaagde sync. Dat tijdstip is zichtbaar op de **bedieningsschermen**. Op Stage View verschijnt **geen** nieuw element.
- Realtime-abonnement filteren op het actieve project in plaats van de hele `projects`-tabel. Nu ontvangt elke client de wijzigingen van alle klanten zolang RLS uit staat.

**Tests fase 1:**
- handmatige timer: start, pauze, hervatten, reset en correcties;
- middernacht en de 07:00-grens;
- geannuleerde en verborgen shows;
- import met en zonder seconden, en zonder verlies van andere podia;
- foto verwijderen;
- apostroffen en `<script>` in alle vrije tekstvelden;
- opslagfouten: 500, timeout, 401 → verversen → opnieuw proberen;
- gelijktijdige wijzigingen: twee browsercontexts;
- realtime-payload zonder `data`;
- crewselectie;
- wachtwoordreset en de periodeweergave van het abonnement.

**Afsluiting fase 1:** de Stage View-pixelvergelijking is gelijk aan de baseline.

---

## FASE 2 — Bereikbaarheid op mobiel en tablet
- **390×844:** het timerpaneel neemt alle ruimte in, waardoor de planning 0 px hoog wordt. Oplossing: een compacte timer bovenaan, de planning altijd zichtbaar en aanvullende bediening inklapbaar.
- **768 en 1024 px:** de navigatie valt buiten beeld. Op tijd overschakelen naar een compacte navigatie.
- Aandacht voor:
  - een goede scrollstructuur zonder afgesneden inhoud;
  - safe areas, landschapstand, korte schermhoogte en het mobiele toetsenbord;
  - opslaan en sluiten blijven bereikbaar;
  - lange namen lopen netjes door.
- Overlappende tekst bij de One-off timers herstellen.
- Aanraakvlakken minimaal 44 px. Bewerk- en verwijderacties zijn niet meer alleen bij hover zichtbaar (`.scard-act` ~397 → `@media (hover:none)`).
- Projectbeheer, podia, dagen, crew, import en Overview blijven bereikbaar op mobiel.
- **Zoom:** `user-scalable=no, maximum-scale=1` (regel 5) eruit voor alle schermen behalve Stage View. Stage View zet dit zelf dynamisch, zodat het boothscreen gelijk blijft.
- **Wake lock:** werkt nu alleen op Backstage en Stage View. FOH, Wall, Overview en Timeline-monitors gaan op zwart. Uitbreiden naar die views is een betrouwbaarheidsfix en geen nieuwe functie. **→ besluitpunt B3.**

**Controle:** screenshots op 320, 390, 700, 720, 768, 1024 en 1440 px breed, op een korte hoogte (bijvoorbeeld 1024×600) en in landschap (844×390). Stage View blijft gelijk aan de baseline.

---

## FASE 3 — Navigatie, formulieren en leesbaarheid

### 3.1 Bedieningsscherm (briefing §3)
- Projectnaam, podium, dag en datum duidelijk zichtbaar, in dezelfde volgorde op desktop en mobiel: project → podium → dag → weergave.
- De actieve show, resterende tijd en booth krijgen de hoogste visuele prioriteit.
- Gegroepeerd in vier blokken: timerbediening, planningcorrecties, displaystanden en cues.
- Het menu met podia, dagen, crew en import heet **"Projectbeheer"**, los van platformbeheer.
- De opslagstatus is altijd zichtbaar, ook op mobiel: *Opgeslagen / Opslaan… / Niet opgeslagen*. Dit vervangt de stip met alleen kleur.

### 3.2 Visuele consistentie (§5), niet op Stage View
- Lichte beheeromgeving en donkere productieomgeving blijven.
- Eén schaal voor typografie, spacing, hoeken en knophoogtes, vastgelegd als CSS-tokens.
- Labels kleiner dan 11 px worden groter. Er zijn nu 88 declaraties tussen 8 en 10 px.
- Beter contrast. Ook afgelopen en verborgen shows blijven leesbaar.
- Eén iconenset. Emoji-knoppen krijgen een `aria-label`.
- Primaire, secundaire en gevaarlijke acties zijn herkenbaar. Actieve tabs zien er overal hetzelfde uit.
- Statussen niet alleen met kleur aangeven: tekst of icoon erbij, zoals "5 MIN" en "OVER +02:13". **Alleen op bedieningsschermen.**
- `prefers-reduced-motion` respecteren voor pulsen en knipperen, **behalve op Stage View**.

### 3.3 Planning en formulieren (§6)
- Leesvolgorde in de planning: tijd → artiest → booth → status → acties.
- Live, volgende, afgelopen, geannuleerd en verborgen zijn van elkaar te onderscheiden. De check-inindicator wordt begrijpelijk.
- Validatiefouten verschijnen bij het betreffende veld. Datum, tijd en seconden krijgen een label. Ongeldige waarden worden niet stil gecorrigeerd. Automatische aanpassingen van de eindtijd worden zichtbaar gemaakt.
- **Waarschuwing bij overlappende shows** op hetzelfde podium. Dit is validatie en geen nieuwe functie.
- Bij het wijzigen van een dagdatum vooraf tonen wat er met de shows gebeurt.
- Bij het sluiten van een formulier met niet-opgeslagen invoer: "Wijzigingen weggooien?"
- **Dag verwijderen:** shows blijven nu als wees achter en zijn onzichtbaar. Dat moet expliciet worden gemaakt: verplaatsen of mee verwijderen.

### 3.4 Tijdcorrecties en cues (§7)
- Duidelijke keuzes: **Alle volgende shows verschuiven / Alleen de volgende show laat opvangen / Annuleren**. Annuleren annuleert echt. De nieuwe tijden worden getoond voordat de wijziging wordt toegepast.
- Cues tonen duidelijk:
  - welk podium de cue ontvangt;
  - welke cue actief is;
  - hoe lang een tijdelijke cue nog zichtbaar blijft;
  - of blackout actief is.
- In handmatige modus is duidelijk welke actie een show selecteert en welke de timer reset. Geen onbedoelde resets meer door een tik op een kaart.

### 3.5 Weergaven (§8)
- Overal dezelfde namen, datums en statussen. Selectors staan op herkenbare plekken.
- Tijdlijn:
  - tijdschaal en podiumlabels blijven zichtbaar tijdens scrollen (sticky);
  - overlappende shows zijn leesbaar;
  - geannuleerde shows kloppen op mobiel.
- Overview laat zien wanneer podia verschillende dagen tonen.
- Duidelijke onderscheid tussen een lege planning, een afgelopen programma, een verkeerde dagselectie en een laadfout. Lege staten zijn nu bijna onzichtbaar (`rgba(255,255,255,.2)`).
- Deelscherm:
  - per link aangeven of hij alleen lezen is of check-in-wijzigingen mag opslaan;
  - bruikbaar op mobiel;
  - een mislukte kopieeractie wordt afgehandeld (`copyLink` heeft nu geen `.catch`).
- Crewstatussen worden begrijpelijk.

### 3.6 Account en beheer (§9)
- De ongeveer 100 `alert()`/`prompt()`/`confirm()`-dialogen worden één dialoogcomponent, met focus trap, Escape en focus die na sluiten terugkeert. Uitnodigen (nu twee `prompt()`s achter elkaar) en hernoemen krijgen echte formulieren. **Tests versturen geen echte uitnodigingen; edge functions worden gemockt.**
- Laad-, opslag-, succes- en foutstatussen overal tonen.
- De abonnementsweergave baseren op de echte velden (`plan_slug`, `pass_*`, periode). De betaalfunctionaliteit en commerciële voorwaarden blijven ongewijzigd.
- Accountinstellingen, workspacebeheer en platformbeheer worden gescheiden. Bestaande rollen worden gerespecteerd.
- Eén taal, en een consistente notatie voor datums en bedragen.

### 3.7 Toetsenbord en focus (§10)
- `:focus-visible` overal. Nu is de focus op veel inputs verwijderd met `outline:none`.
- Labels op formuliervelden.
- `role="dialog"`/`aria-modal`.
- `div onclick` vervangen door `button`.

---

## FASE 4 — Technische opschoning (binnen de bestaande architectuur)

### 4.1 Gedeelde logica
- **Een pure tijdmodule** (`js/time.js`, als native ES-module zonder build-stap): `t2s`, `adjM`, `_showStartsAt`/`_showEndsAt`, `curShow`/`nxtShow`, de import-parser en het timermodel. Met unit-tests: middernacht, zomer-/wintertijd, 07:00, het legacy model en het ISO-model.
- **Eén berekening van de podiumstatus** (`computeStageState`), die FOH, Backstage, Overview, Wall en de tijdlijn gebruiken. Stage View gebruikt hem ook voor de *gegevens*, terwijl de render-markup gelijk blijft. Dit haalt duplicatie weg uit `tickOV`, `tickWV`, `renderBS`, `renderSV` en de rest.
- Code alleen splitsen waar het aantoonbaar helpt (de briefing vraagt dat). Geen bundler.

### 4.2 Renderen
- Geen volledige `innerHTML`-herbouw meer bij elke poll. Alleen renderen bij een echte wijziging (signature-check, zoals de dagkiezer van de tijdlijn al doet).
- Focus, scrollpositie en open selects blijven behouden.
- De 8-secondenloop die alles opnieuw rendert (~8654) wordt herzien.
- `setTPPhoto` zet niet meer elke 250 ms dezelfde `img.src`.

### 4.3 Realtime en polling
- Overlap tussen realtime en polling opruimen.
- Publieke views pollen een kleine versie-indicator en halen pas het volledige project op als die verandert (vereist een RPC, voorbereid in §4.5).

### 4.4 Offline en service worker
- `sw.js` en `OneSignalSDKWorker.js` registreren allebei op scope `/`. Er kan er maar één tegelijk de pagina beheren, dus één van de twee valt weg. Oplossing: de OneSignal-worker importeren in `sw.js` via `importScripts`, of OneSignal een eigen scope geven.
- `supabase-js` lokaal neerzetten (gepinde versie) en in de cache van de service worker opnemen, zodat de app opstart zonder internet.
- Een "nieuwe versie"-melding op bedieningsschermen. Publieke monitors herladen automatisch alleen tussen shows.
- Lettertypen: Google Fonts lokaal hosten (dezelfde fonts, dus visueel gelijk; ook goed voor de AVG en offline gebruik). **→ besluitpunt B4.**

### 4.5 Voorbereide backendmigraties (niet uitvoeren, elk met rollback)
1. `hotfix_setup_token` (fase S).
2. Repareren van de RLS-migratie vóór die wordt toegepast:
   - `coalesce(caller_role,'')` in de guard-triggers. Nu omzeilt een rol `NULL` de check, waarna zo'n gebruiker zichzelf `super_admin` kan maken.
   - `role not null default 'operator'`.
   - Kolomrechten als allowlist (`grant update(name)`) in plaats van een denylist. Daarbij `seat_subscription_item_id` en `pass_slug` toevoegen aan de billing-velden.
   - Updates op companies alleen voor `company_admin`.
   - Een unieke index op `lower(email)`.
3. `get_shared_project` geeft alleen de velden terug die de betreffende modus nodig heeft. Bestaande `pid`-links blijven werken.
4. Een plan-limiet op databaseniveau: de insert-policy op projects controleert of de company een actieve, trialing of past_due status heeft of een actieve pass. Een trigger telt `data->'stages'` tegen de limiet.
5. Een `version`-kolom met de RPC `save_project` voor conflictdetectie (zie 1.1f).
6. Een `project_versions`-tabel, gevuld door een trigger (laatste N versies of 30 dagen), plus soft-delete (`deleted_at`) op projects.
7. Optioneel, later: foto's naar Supabase Storage met een fallback die base64 blijft lezen.

### 4.6 Opruimen
- `festival-dashboard.html` bevat oude code, een tweede kopie van de OneSignal-key en aanroepen van `create-auth-user`/`delete-auth-user`. Er wordt alleen naar geredirect. Verwijderen nadat is gecontroleerd dat niets er nog naar linkt. **→ besluitpunt B5.**
- De no-op's `applyLogo`/`refreshLogo` en de dode logo-uploadcode.
- 23 lege `catch`-blokken krijgen minstens een `console.warn` met context.
- `index.html`:
  - `crowd.jpg` (6,2 MB) comprimeren naar WebP of een geoptimaliseerde JPEG van ongeveer 200 KB;
  - het byte-identieke duplicaat `event.jpg` vervangen;
  - `og:`/`twitter:`-tags toevoegen;
  - `loading="lazy"` op de screenshots.
- `manifest.json`: een apart maskable-icoon.
- **OneSignal versturen** via een edge function (`send-push`) die de JWT en het lidmaatschap controleert. De code wordt voorbereid in `supabase/functions/`, het deployen doet Thijs. De client gebruikt hem pas na de deploy, met een vlag.

### 4.7 Documentatie
- README bijwerken: `app.html` is geen ~3600 regels meer, de modules, het testharnas, de beschrijving van de save-, sync- en auth-flow, en de deploy- en migratievolgorde.
- `docs/MIGRATIES.md` met de volgorde, rollback en timing voor elke voorbereide migratie.
- Een `AGENTS.md`/`CLAUDE.md` met de harde voorwaarden (boothscreen bevroren, geen push naar `main`, testcommando).

---

## Buiten de scope van deze ronde (advies, actie voor Thijs)
- **De backend in git zetten:** `supabase db pull` plus `supabase functions download` voor de 7 functies en de Stripe-webhook. Zonder die broncode kunnen we finalize-signup, invites en betalingen niet controleren.
- **Staging:** een tweede Supabase-project, Vercel-previews daarop laten wijzen, en een beveiligde `main`.
- **Monitoring:** Sentry of iets lichters, plus een uptime-check. Let op: dit voegt een nieuwe verwerker toe voor de AVG.
- **Juridisch:**
  - privacyverklaring, algemene voorwaarden en KvK-gegevens op `index.html`;
  - een verwerkersovereenkomst en een lijst van subverwerkers (Supabase, Vercel, Stripe, Mailgun, OneSignal);
  - toestemming vragen voor OneSignal;
  - account verwijderen en data exporteren (AVG art. 17 en 20).
- **Supabase PITR** aanzetten.
- **Share-links:** echte, intrekbare tokens van minstens 128 bits per modus. Dat is nieuwe functionaliteit, dus een besluit voor later.
- **Beveiligingsheaders:** CSP van report-only naar afdwingen. Kan pas als inline handlers weg zijn (fase 4). Ook `frame-ancestors 'none'` toevoegen.

---

## Besluitpunten voor Thijs, vóór de start
| # | Vraag | Voorstel |
|---|---|---|
| B1 | Werkmap: Desktop (met RLS-werk) of `~/Documents/ChatGPT`? | Desktop |
| B2 | Is `trialing` = 0 live stages bedoeld? | Waarschijnlijk een bug. Trial gelijk behandelen aan `active`. |
| B3 | Wake lock uitbreiden naar FOH, Wall, Overview en Timeline (is dit een fix of een nieuwe functie)? | Ja, als betrouwbaarheidsfix |
| B4 | Google Fonts lokaal hosten (visueel gelijk) | Ja |
| B5 | `festival-dashboard.html` verwijderen | Ja, na controle |
| B6 | Playwright als dev-tooling (`tests/` + `package.json`, uitgesloten van deploy) | Ja, nodig voor de regressiecontroles |
| B7 | Mag Claude de spoedfix-clientcode (S.2) meteen schrijven, nog vóór fase 1? | Ja. Thijs voert S.1 en S.3 zelf uit. |

## Volgorde in één oogopslag
1. **Vandaag, Thijs:** de S.1-check uitvoeren en de OneSignal-key roteren (op een rustig moment).
2. **Claude:** S.2-clientfix en de S.3-migratie voorbereiden. Daarna deployt Thijs en voert hij de migratie uit, in de volgorde kolom → client → rechten.
3. **Fase 1:** vangnet, gegevensbehoud en opslag (incl. 1.1h, de blokkade voor het RLS-werk), import, timer, XSS en publieke aanvoer.
4. **Fase 2:** mobiel en tablet.
5. **Fase 3:** navigatie, formulieren, leesbaarheid, account en beheer.
6. **Fase 4:** opruimen, de voorbereide migraties en de documentatie.

## Wat er aan het eind wordt opgeleverd
- Een overzicht van wat er is veranderd en waarom, en welke fouten zijn opgelost.
- Welke controles zijn gedaan, met de testuitvoer.
- Bewijs dat het boothscreen gelijk is gebleven: het resultaat van de pixelvergelijking met de baseline.
- De voorbereide migraties met hun uitvoeringsvolgorde.
- **Expliciet niet getest:** echte Safari en iOS, echte pushmeldingen, echte e-mail, echte Stripe-betalingen en de productiedatabase.
