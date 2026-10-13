# Status: verbeterronde 13 okt 2026 (afgerond in code)

De branch `improve/2026-10-13` bevat alle verbeteringen uit BOUWPLAN.md, de vervolgreviews en hun fixes.

**Niets is gepusht, gedeployd of op productie uitgevoerd.**

Achtergrond: zie `BOUWPLAN.md` (plan), `docs/MIGRATIES.md` (draaiboek), `CLAUDE.md` (werkregels) en `tests/INVENTARIS.md` (functies en tests).

## Laatste controle

- Volledige suite, Chromium en WebKit: **428 geslaagd**. Twee boothtests faalden alleen onder zware parallelle belasting (6 workers). Opnieuw gedraaid: 66/66 en 18/18.
- Boothscreen (Stage View) pixel-identiek aan de code van vóór deze ronde (`845eb0d`).
- Node-unittests: 48 geslaagd.

## Volgorde voor Thijs

1. **Vandaag nog:**
   - ~~`supabase/migrations/20261013080000_urgent_anon_write_lockdown.sql` uitvoeren~~ **Gedaan op 13-10.** De tabelrechten staan dicht. Nog na te gaan: de kolomcheck (0 rijen) en een rooktest in de live-app.
   - De OneSignal REST-key roteren.
2. De checks uit BOUWPLAN §S.1 uitvoeren. Daarna `supabase db pull` en `supabase functions download`, en dat committen.
3. `docs/MIGRATIES.md` stap voor stap volgen. Belangrijk:
   - Deploy de app van deze branch **vóór** `rls_enable`.
   - Verhoog `SW_VERSION` bij elke deploy.
   - Gebruik nooit `supabase db push`.
4. Nalopen op echte apparaten, want dat kon hier niet: iOS Safari, echte push, e-mail en Stripe.
5. Deploy `send-push`. Zonder die functie gaan er geen crew-pushmeldingen uit.

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
