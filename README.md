# Stagetimer

Realtime productie-timing voor festivals en events. Eén applicatie met meerdere views - FOH, backstage, tijdlijn, overzicht en stage view - bovenop één gedeelde dataset die in Supabase leeft. Live op [stagetimer.nl](https://stagetimer.nl).

---

## Wat het doet

Stagetimer regelt het kloksysteem voor producties met meerdere podia en meerdere dagen. Je voert per podium per dag de lineup in (artiest, start, einde, crew, foto, notitie) en de applicatie laat dan voor elke rol een afgestemde view zien:

| View | Voor wie | Inhoud |
|---|---|---|
| **FOH** | Front-of-house / regie | Grote aftelklok van de actieve show, programma-strook, voortgangsbalk |
| **Backstage** | Crew achter het podium | Verticale kaartenlijst per show met countdown, crew, notities, foto |
| **Stage View** | Op podium / monitor | Minimalistisch fullscreen: artiest + resttijd, leesbaar vanaf afstand |
| **Tijdlijn** | Coördinatie | Horizontale Gantt-view over alle podia, met now-lijn en kleurcodes per booth |
| **Overzicht** | Productieleider / shared screen | Alle podia in één blik: live status, volgende artiest, aftelklokken |

Iedere view is ook beschikbaar als **publieke deelbare link** (read-only), zodat je een tablet bij FOH of een scherm in de greenroom kunt neerzetten zonder iemand hoeft in te loggen.

## Belangrijkste features

- **Multi-podium, multi-dag** - onbeperkt aantal stages en dagen per project
- **Festival-overnight grens van 07:00** - een show die om 01:30 begint hoort nog bij de avond ervoor
- **Realtime sync** - wijzigingen verschijnen binnen 1-2 seconden op alle verbonden schermen via Supabase Realtime
- **Prioriteit & cancellatie** - markeer headliner-shows met gele pulserende gloed in het overzicht; geannuleerde shows verdwijnen automatisch uit het zicht
- **Crew per show** - VJ, Light, Sound, SFX, Laser per show invullen
- **Lineup import** via JSON of plak-en-klaar formaat
- **Push-meldingen** voor crew (via OneSignal, alleen productie)
- **Mobiele weergave** - backstage werkt als full-screen mobile view voor crew op locatie
- **Live klok-modus en handmatige modus** - schakel tussen automatisch aftellen op basis van starttijd en handmatige controle
- **Onthouden van project keuze** - automatische redirect naar het laatst gebruikte project

## Tech stack

- **Frontend**: één HTML file (`app.html`, ~3600 regels) - geen build step, geen framework
- **Database & realtime**: [Supabase](https://supabase.com) (Postgres met JSONB voor project data)
- **Auth**: Supabase Auth met email/wachtwoord, persistSession via localStorage
- **Hosting**: [Vercel](https://vercel.com) (statische site, geen build)
- **Push**: OneSignal Web SDK (alleen op productie-domein)
- **Landing page**: `index.html` (apart, los van de app)

### Data model

Alles van één project leeft in één rij in de `projects` tabel, opgeslagen als JSONB in de `data` kolom:

```jsonc
{
  "stages":  [ { "id", "name", "emoji" } ],
  "days":    [ { "id", "name", "date" } ],
  "shows":   [ { "id", "stage", "day", "artist", "start", "end", "booth",
                 "genre", "note", "photo", "crew", "cancelled", "priority" } ],
  "activeStage": "...",
  "activeDay":  "...",
  "timerMode":  "live" | "manual",
  "fohNotes":   { ... }
}
```

Shows hebben geen eigen `date` - ze refereren via `day` naar een day-object, en alleen `day.date` bepaalt op welke kalenderdag de show daadwerkelijk gepland staat.

## Structuur

```
.
├── app.html                  # De volledige applicatie (alles inline)
├── index.html                # Marketing/landing page op /
├── vercel.json               # Routes: /app → /app.html
├── OneSignalSDKWorker.js     # Service worker voor push (alleen productie)
├── stagetimer-logo.png       # Logo
└── *.png / *.jpg             # Marketing assets
```

URL-structuur:
- `/` - landing page
- `/app` - de applicatie (rewrite naar `app.html`)
- `/app?mode=overview&pid=<projectId>` - publieke overview link
- `/app?mode=timeline&pid=<projectId>` - publieke tijdlijn link
- `/app?mode=backstage&pid=<projectId>` - publieke backstage link
- `/app?mode=stage&pid=<projectId>&sid=<stageId>` - publieke stage view link

## Lokaal draaien

Geen build step nodig. Open `app.html` rechtstreeks of serveer de map:

```bash
# Met Python
python3 -m http.server 8000

# Met Node
npx serve .
```

Daarna naar `http://localhost:8000/app.html`. Supabase werkt vanuit elke origin omdat de anon key in de file zit (`SUPA_URL` en `SUPA_KEY` bovenaan het script-blok).

## Deployen

Wijzigingen op de `main` branch worden automatisch door Vercel gedeployd. De `vercel.json` regelt de URL rewrite van `/app` naar `app.html`.

## Auth flow

Korte samenvatting van hoe sessies opgeslagen en hersteld worden:

1. Bij login slaat Supabase JS het token op in localStorage (`sb-<projectref>-auth-token`).
2. Daarnaast bewaren we een eigen backup op `st_auth_v1` met access + refresh token - vangnet als Supabase's eigen storage door wat dan ook gewist wordt.
3. Bij elke pagina-laad luistert `onAuthStateChange` naar `INITIAL_SESSION`. Met sessie → app start. Zonder sessie → eerst onze backup proberen, anders login modal.
4. Push naar Supabase (`save()`) is gedebounced op 300ms; bij snelle wijzigingen wordt alleen de meest recente staat verzonden. `beforeunload` waarschuwt als er nog niet-opgeslagen wijzigingen klaarstaan.

## Caveats

- Foto's worden client-side gecomprimeerd naar max 900px en JPEG 82% voordat ze in de JSONB rij belanden - anders zou een handvol phone-foto's al snel de Postgres row size laten exploderen.
- Het `data` veld in `projects` is één blob: zware multi-user concurrency is dus niet ideaal. Realtime + 300ms debounce zorgt voor "last write wins" - meestal goed genoeg voor productiewerk, niet voor 10 mensen die tegelijk bewerken.
- Public share-links zijn read-only én onbeperkt deelbaar - wie de URL heeft, heeft toegang. Gebruik ze niet voor projecten die echt vertrouwelijk zijn.
