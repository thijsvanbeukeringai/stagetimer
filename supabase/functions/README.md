# Supabase edge functions

Deze map bevat alleen **broncode**. Niets hiervan is gedeployed. Deployen doet Thijs zelf.

De bestaande functies staan nog niet in git: `finalize-signup`, `signup-checkout`, `invite-member`, `remove-member`, `manage-voucher`, `portal-link`, `create-auth-user`, `delete-auth-user` en de Stripe-webhook. Haal ze eerst op en commit ze, zodat we ze kunnen controleren. Zie het einde van dit bestand.

## send-push

Verstuurt OneSignal-pushmeldingen vanaf de server. De OneSignal REST-key staat dan niet meer in `app.html` (BOUWPLAN §4.6 en het spoedpunt "OneSignal-key").

De functie controleert vier dingen:

1. Het user-JWT is geldig. De anon-key werkt niet.
2. De beller hoort bij de workspace van het project, of is `admin`/`super_admin`. Dat is dezelfde regel als de RLS-policies.
3. Elke ontvanger zit in de workspace van het project.
4. De limieten: maximaal 100 ontvangers, `en`-tekst verplicht, `send_after` maximaal 48 uur vooruit en 60 meldingen per minuut per gebruiker.

Daarnaast stuurt de functie een vaste `idempotency_key` mee. Opnieuw inplannen bij het heropenen van een project geeft daardoor geen dubbele meldingen.

**Vereist:** de migratie `20260819111158_rls_prep.sql`. De functie gebruikt `public.current_app_user()`.

### Deployen (Thijs)

1. **Roteer eerst de OneSignal REST-key** (OneSignal → Settings → Keys & IDs). De oude key staat in de git-historie en is dus publiek.
2. Zet de secrets:
   ```bash
   supabase secrets set --project-ref bamjpsquhdzxvsymldpq \
     ONESIGNAL_APP_ID=5778eb83-1c2c-4ffd-b085-4236b5bd0188 \
     ONESIGNAL_REST_KEY='<nieuwe key>' \
     ALLOWED_ORIGINS='https://stagetimer.nl,https://www.stagetimer.nl'
   ```
   `SUPABASE_URL`, `SUPABASE_ANON_KEY` en `SUPABASE_SERVICE_ROLE_KEY` levert Supabase zelf aan.
3. Deploy **met** JWT-verificatie. Gebruik dus geen `--no-verify-jwt`:
   ```bash
   supabase functions deploy send-push --project-ref bamjpsquhdzxvsymldpq
   ```
4. Test met een ingelogde sessie. In de browserconsole op stagetimer.nl, met een project open:
   ```js
   await fetch(SUPA_URL+'/functions/v1/send-push',{method:'POST',
     headers:{'Content-Type':'application/json',apikey:SUPA_KEY,Authorization:'Bearer '+_jwt()},
     body:JSON.stringify({project_id:APP.activeProjectId,include_external_user_ids:[CURRENT_USER.id],
       headings:{en:'Test'},contents:{en:'Test from send-push'}})}).then(r=>r.json())
   ```
   Verwacht `{ok:true,id:"…"}` en een melding op je eigen toestel. Controleer ook dat dezelfde aanroep met `Authorization: 'Bearer '+SUPA_KEY` (de anon-key) `401` geeft.
5. Pas daarna zet de app de vlag om (zie hieronder). Haal ook `OS_REST_KEY` uit `app.html`.

**Rollback:** `supabase functions delete send-push`, of zet de vlag in de app terug. Na het roteren van de key werkt het versturen vanuit de client niet meer, en dat is de bedoeling.

### App-wijziging (voor de app-agent)

In `scheduleProjectPushes()`:

- vervang de `fetch('https://onesignal.com/api/v1/notifications', …)` achter een vlag (bijvoorbeeld `const PUSH_VIA_EDGE=true`) door:
  ```js
  fetch(`${SUPA_URL}/functions/v1/send-push`,{method:'POST',
    headers:{'Content-Type':'application/json',apikey:SUPA_KEY,Authorization:`Bearer ${_jwt()}`},
    body:JSON.stringify({project_id:APP.activeProjectId,show_id:show.id,
      include_external_user_ids:memberIds,headings,contents,send_after})})
  ```
- verwijder `OS_REST_KEY`.

Let op een bestaande bug. `scheduleProjectPushes` filtert op `s.endTime` en `show.stageId`, maar opgeslagen shows hebben `end`, `endsAt` en `stage`. Daardoor wordt er nu waarschijnlijk **nooit** een melding ingepland. Repareer dit in dezelfde wijziging en gebruik `_showEndsAt(s)` voor het tijdstip.

### Lokaal getest

- `deno check` en `deno lint` geven geen fouten.
- Een smoke-test tegen gemockte Supabase- en OneSignal-endpoints:
  - een geldige aanroep geeft 200;
  - de anon-key geeft 401;
  - een ongeldig JWT geeft 401;
  - een project van een andere workspace geeft 403;
  - een ontvanger buiten de workspace geeft 403;
  - zonder `en`-tekst geeft 400;
  - een `send_after` van meer dan 48 uur vooruit geeft 400.
- **Niet getest:** de echte OneSignal-API. De functie gebruikt de huidige API: `api.onesignal.com/notifications`, `Authorization: Key …`, `include_aliases.external_id` en `target_channel`. Controleer bij stap 4 dat de melding echt aankomt.

## Bestaande functies in git zetten (Thijs, vóór verdere backendwijzigingen)

`supabase db pull` vergelijkt de migratiehistorie van productie met `supabase/migrations/`. Die map bevat nu migraties die nog niet zijn toegepast. Daardoor weigert de CLI, of stelt hij een `migration repair` voor. **Voer `migration repair` niet uit.** Doe de pull in een lege kopie en zet het resultaat als referentie in `supabase/schema/`:

```bash
supabase login
tmp=$(mktemp -d) && cd "$tmp" && supabase init && supabase link --project-ref bamjpsquhdzxvsymldpq
supabase db pull                       # → $tmp/supabase/migrations/<ts>_remote_schema.sql
mkdir -p "<repo>/supabase/schema" && cp supabase/migrations/*_remote_schema.sql "<repo>/supabase/schema/remote_schema.sql"
cd "<repo>"
supabase link --project-ref bamjpsquhdzxvsymldpq   # nodig voor functions download; raakt migraties niet
supabase functions download finalize-signup
supabase functions download signup-checkout
supabase functions download invite-member
supabase functions download remove-member
supabase functions download manage-voucher
supabase functions download portal-link
supabase functions download create-auth-user
supabase functions download delete-auth-user
supabase functions download <stripe-webhook-naam>   # zie Dashboard → Edge Functions
git add supabase && git commit -m "Backend source: schema + edge functions from production"
```

`supabase/` staat in `.vercelignore` en komt dus niet op de publieke site. Controleer vóór het committen dat er geen secrets hardcoded in de functies staan.
