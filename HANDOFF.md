# Status: verbeterronde 13 okt 2026 (afgerond in code)

De branch `improve/2026-10-13` bevat alle verbeteringen uit BOUWPLAN.md, de vervolgreviews en hun fixes.

**Niets is gepusht, gedeployd of op productie uitgevoerd.**

Achtergrond: zie `BOUWPLAN.md` (plan), `docs/MIGRATIES.md` (draaiboek), `CLAUDE.md` (werkregels) en `tests/INVENTARIS.md` (functies en tests).

## Laatste controle

- Volledige suite, Chromium en WebKit: **428 geslaagd**. Twee boothtests faalden alleen onder zware parallelle belasting (6 workers). Opnieuw gedraaid: 66/66 en 18/18.
- Boothscreen (Stage View) pixel-identiek aan de code van vóór deze ronde (`845eb0d`).
- Node-unittests: 48 geslaagd.

## Toegevoegd na de eerste afronding (13-10, middag)
Alles staat op dezelfde branch.
- **Fase 5A/5D:** paneel "Message booth" (ook op iPhone), ontvangstbevestiging ("Delivered to 2 of 2 · seen 22:41:05") en welke boothschermen online zijn. Loopt via Realtime broadcast/presence, zonder migratie.
- **Atomair opslaan** via `save_project`, en "Recently deleted" plus versiegeschiedenis met herstel. Dit gaat vanzelf aan zodra migraties 13 (versioning) en 14 (history) zijn uitgevoerd.
- **Share-links:** sturen `p_mode` mee (2-arg → 1-arg → tabel) en pollen goedkoop via een versie. Stage View is bewezen identiek met afgeslankte data.
- **Foto's en logo** gaan naar Supabase Storage na migratiestap 16, met terugvaloptie naar base64.
- **Export per project** (JSON) en een CI-workflow (`.github/workflows/tests.yml`).
- **Laatste volledige run:** 658 geslaagd, 0 gefaald (Chromium + WebKit).

**Daarna toegevoegd (13-10, middag), op verzoek van Thijs:**
- Knop "New stage" naast "New show".
- Fullscreen is een keuze per apparaat (accountmenu). Kiosk-share-links staan standaard aan.
- Projectlogo per project: uploaden vanaf de dashboard-rij, getoond op Backstage en FOH (aan/uit). Stagetimer.nl blijft zichtbaar.
- FOH-cues vallen op als ze naderen: amber ≤60 s, rood en pulserend ≤10 s, NOW, daarna Done. Optioneel geluid.
- Backstage toont geen FOH-cues meer.
- Rider per show (drankjes en technische eisen): editor, import en export. Via share-links alleen naar check-in en stage manager.
- Check-in-scherm in de app en een nieuw Stage manager-scherm (ook als share-link `mode=stagemanager`).
- Laatste volledige run: 842 geslaagd, 0 gefaald.

**Nog te bevestigen:**
- Mag de stage manager-link aankomsten wijzigen? Nu wel. Read-only maken is één regel (`_SHARE_RW`).
- Crew op de stage manager-share-link? Nu alleen in de app.

**Voorwaarden van de iPad-app (Stagetimer Booth), vóór deze migraties:**
- `rls_enable`
- share-link PHASE B
- stap 16 (foto's). Kan de iPad-app een https-URL in `show.photo` aan?

`SW_VERSION` staat op v30 en productie op v29, dus open schermen krijgen bij deploy de update-melding.

## Volgorde voor Thijs

1. **Vandaag nog:**
   - ~~`supabase/migrations/20261013080000_urgent_anon_write_lockdown.sql` uitvoeren~~ **Gedaan op 13-10.** De tabelrechten staan dicht en de kolomcheck gaf 0 rijen. Rooktest gedaan: inloggen en een project aanmaken werken.
   - De OneSignal REST-key roteren.
2. De checks uit BOUWPLAN §S.1 uitvoeren. Daarna `supabase db pull` en `supabase functions download`, en dat committen.
3. `docs/MIGRATIES.md` stap voor stap volgen. Belangrijk:
   - Deploy de app van deze branch **vóór** `rls_enable`.
   - Verhoog `SW_VERSION` bij elke deploy.
   - Gebruik nooit `supabase db push`.
4. Nalopen op echte apparaten, want dat kon hier niet: iOS Safari, echte push, e-mail en Stripe.
5. Deploy `send-push`. Zonder die functie gaan er geen crew-pushmeldingen uit.

## Juridische concepten (niet gepubliceerd)
- `privacy.html`, `voorwaarden.html` en `docs/VERWERKERSOVEREENKOMST-concept.md` staan klaar. Ze zijn gemarkeerd als CONCEPT en hebben lege plekken als `[KvK]` en `[adres]`.
- Ze zitten in `.vercelignore` en de links in de footer van index.html staan uitgecommentarieerd.
- Na het invullen en een juridische check: de pagina's uit `.vercelignore` halen, de footer-links aanzetten en in `tests/smoke/legal-pages.spec.js` `test.fixme` omzetten naar `test`.

## Open besluiten

- Podium verwijderen: moeten de shows mee? Nu blijven ze onzichtbaar in de data staan, en de dialoog zegt dat.
- Share-links in een iframe/embed toestaan? Nu mag dat alleen voor `?mode=`-pagina's.
- Uitloggen alleen op dit apparaat (zo is het nu) of overal?
- De tijdzone staat vast op Europe/Amsterdam. Akkoord?
- Op mobiel heet het tandwielmenu "Project settings". Daarin staan ook Views en Account, elk als eigen sectie. Eventueel hernoemen naar "Menu".

## Bekende beperkingen

- Tussen het ophalen en het opslaan zit een race van ongeveer 100 ms. Die verdwijnt pas als de app `save_project` (migratiestap 13) gebruikt.
- Share-links sturen nog geen `p_mode`. Phase B van de share-link-migratie daarom NIET uitvoeren (staat ook in het draaiboek).
- Foto's staan nog als base64 in het project. Verplaatsen naar Supabase Storage is voor later.
