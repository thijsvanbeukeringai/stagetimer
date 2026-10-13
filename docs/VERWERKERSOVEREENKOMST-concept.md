# Verwerkersovereenkomst Stagetimer (CONCEPT)

> **CONCEPT — laat controleren door een jurist.** Dit is een skelet, geen geldende overeenkomst. Alles tussen [vierkante haken] moet nog worden ingevuld of geverifieerd. Dit bestand wordt niet gedeployed (`.vercelignore` sluit `docs/` uit). Overweeg het model van de Nederlandse ICT-branche (NL Digital) als basis.

## Partijen

1. **[naam klant]**, gevestigd aan [adres klant], KvK [KvK klant], hierna "Verwerkingsverantwoordelijke";
2. **TEAM FIFTEEN B.V.**, gevestigd aan [adres], KvK [KvK], btw [btw-nummer], contact [contact-email], hierna "Verwerker".

## Overwegingen

- Verwerkingsverantwoordelijke gebruikt Stagetimer, een online dienst voor de tijdplanning van live producties, op basis van [abonnement / event pass] van [datum] ("de Overeenkomst").
- Bij het leveren van de dienst verwerkt Verwerker persoonsgegevens in opdracht van Verwerkingsverantwoordelijke, zoals bedoeld in artikel 28 AVG.

## 1. Onderwerp, aard en doel

- **Onderwerp:** opslaan, synchroniseren en tonen van projectgegevens (lineup, crew, foto's, notities) in de dienst Stagetimer, inclusief deellinks en pushmeldingen.
- **Duur:** gelijk aan de looptijd van de Overeenkomst, plus de termijn uit artikel 9.
- Verwerker verwerkt de gegevens alleen op schriftelijke instructie van Verwerkingsverantwoordelijke en niet voor eigen doeleinden.

## 2. Categorieën betrokkenen en gegevens

| Betrokkenen | Gegevens |
|---|---|
| Gebruikers van de klant (teamleden, operators) | naam, e-mailadres, rol, gebruikers-id, push-aanmelding |
| Artiesten en optredenden | (artiest)naam, tijden, foto, check-in-status, notities |
| Crewleden | naam, toewijzing aan shows |
| Overig | [aanvullen: wat de klant zelf in notities invoert] |

Bijzondere persoonsgegevens: niet bedoeld. Verwerkingsverantwoordelijke voert deze niet in. [verifiëren]

## 3. Verplichtingen van Verwerker

- Geheimhouding: personen die toegang hebben, zijn tot geheimhouding verplicht.
- Passende technische en organisatorische maatregelen (art. 32 AVG): zie bijlage B.
- Medewerking aan verzoeken van betrokkenen (inzage, correctie, verwijdering, overdraagbaarheid). Projecten zijn door leden zelf te exporteren via *Project settings > Export project (JSON)*.
- Medewerking aan DPIA's en voorafgaande raadpleging, voor zover redelijk. [kosten]

## 4. Subverwerkers

Verwerkingsverantwoordelijke geeft algemene toestemming voor de subverwerkers in bijlage A. Verwerker meldt een nieuwe of vervangende subverwerker minimaal [termijn] vooraf; Verwerkingsverantwoordelijke kan binnen [termijn] gemotiveerd bezwaar maken. Verwerker legt subverwerkers ten minste dezelfde verplichtingen op.

## 5. Doorgifte buiten de EER

Alleen met een passende waarborg (art. 44-49 AVG): [verifiëren per subverwerker, bijv. EU-US Data Privacy Framework of modelcontractbepalingen].

## 6. Datalekken

Verwerker meldt een inbreuk in verband met persoonsgegevens zonder onredelijke vertraging en uiterlijk binnen [termijn, bijv. 48 uur] na ontdekking aan [contactpersoon klant], met de informatie uit art. 33 lid 3 AVG voor zover beschikbaar. Verwerkingsverantwoordelijke beslist over melding aan de Autoriteit Persoonsgegevens en betrokkenen.

## 7. Audit

Verwerkingsverantwoordelijke mag naleving laten controleren, [maximaal eens per jaar, op eigen kosten, met redelijke aankondiging]. Verwerker stelt de informatie beschikbaar die nodig is om naleving aan te tonen.

## 8. Aansprakelijkheid

[afstemmen op de aansprakelijkheidsbeperking in de algemene voorwaarden]

## 9. Einde

Na afloop van de Overeenkomst kan Verwerkingsverantwoordelijke de gegevens nog [termijn] exporteren. Daarna verwijdert Verwerker de persoonsgegevens, ook uit back-ups binnen [termijn], tenzij bewaren wettelijk verplicht is.

## 10. Slotbepalingen

Bij strijdigheid gaat deze verwerkersovereenkomst voor op de algemene voorwaarden, voor zover het de verwerking van persoonsgegevens betreft. Nederlands recht is van toepassing.

Ondertekening: [plaats, datum, namen, handtekeningen]

---

## Bijlage A: subverwerkers

| Subverwerker | Doel | Regio | Waarborg |
|---|---|---|---|
| Supabase | database, authenticatie, serverfuncties | [regio verifiëren] | [DPA / waarborg verifiëren] |
| Vercel | hosting website en app | [regio verifiëren] | [DPA / waarborg verifiëren] |
| Stripe | betalingen en facturen (betreft vooral de klant zelf) | [regio verifiëren] | [DPA / waarborg verifiëren] |
| Mailgun | transactionele e-mail (uitnodigingen, inloglinks) | [regio verifiëren] | [DPA / waarborg verifiëren] |
| OneSignal | pushmeldingen aan crew | [regio verifiëren] | [DPA / waarborg verifiëren] |

## Bijlage B: beveiligingsmaatregelen

- Versleutelde verbindingen (HTTPS).
- [toegangsbeheer: wie bij productiedata kan, met MFA]
- [back-ups en herstel, bijv. Supabase PITR]
- [logging en monitoring]
- [beleid rond deellinks: werken voor iedereen die de link heeft]
- [procedure datalekken]
