# E-Mail in 5 Minuten – Schritt für Schritt

Diese Anleitung nimmt dich an die Hand. Du brauchst nichts über Mailserver zu wissen.
Am Ende schickt dein Panel Mails (Willkommen, Registrierung, „Passwort vergessen“, Bestellungen, Absturz-Hinweise).

**Du brauchst:** ein Postfach, aus dem das Panel schreiben darf, und dessen Passwort.
Läuft dein Mailserver bei dir zu Hause (z. B. Stalwart), außerdem seine IP im Heimnetz.

---

## Schritt 1 – Ein Postfach fürs Panel anlegen

Das Panel braucht ein eigenes Postfach, z. B. `noreply@mornihosting.de`. Nimm nicht dein privates.

### Mit eigenem Stalwart (bei dir zu Hause)

1. Öffne die Stalwart-Verwaltung im Browser und melde dich als Admin an.
2. **Domain anlegen** (nur einmal nötig): links **Management → Directory → Domains** → **Create domain** → `mornihosting.de` eintragen → speichern.
3. **Postfach anlegen:** **Management → Directory → Accounts** → **Create account**
   - Name: `noreply`
   - E-Mail-Adresse: `noreply@mornihosting.de`
   - Passwort: ein langes, neues Passwort. **Schreib es dir kurz auf**, du brauchst es gleich.
   - Speichern.
4. **IP des Stalwart-Rechners notieren.** In der Fritzbox: **Heimnetz → Netzwerk** → den Rechner mit Stalwart suchen → die Zahl wie `192.168.178.116`.

### Mit einem Anbieter (INWX, IONOS, Gmail …)

Lege im Kundenmenü ein Postfach an (z. B. `noreply@deine-domain.de`) und merk dir das Passwort.
Bei **Gmail** brauchst du statt deines normalen Passworts ein **App-Passwort**:
Google-Konto → Sicherheit → 2-Schritt-Bestätigung → App-Passwörter.

---

## Schritt 2 – Im Panel eintragen (Schnellstart)

1. Öffne dein Panel und geh unten links auf **Admin-Bereich** → Reiter **E-Mail**.
2. Oben siehst du den grünen Kasten **„Schnellstart“**. Trag ein:
   - **E-Mail-Adresse:** `noreply@mornihosting.de`
   - **Passwort:** das aus Schritt 1
3. Läuft dein Mailserver zu Hause? Dann schalte **„Mein Mailserver steht bei mir zu Hause“** ein und trag die IP ein, z. B. `192.168.178.116`.
4. Klick auf **„Einrichten und Test-Mail senden“**. Das dauert bis zu 30 Sekunden.

Das Panel probiert jetzt selbst aus:

- **welcher Name** zum Zertifikat deines Mailservers passt (bei dir `mail.mornihosting.de`, weil das Zertifikat für `*.mornihosting.de` gilt),
- **welcher Port** antwortet (465 oder 587),
- **welche Verschlüsselung** passt (TLS oder STARTTLS).

Was klappt, wird gespeichert. Danach kommt eine Test-Mail an die Adresse aus **Mein Konto** (sonst an das Postfach selbst).

---

## Schritt 3 – Hat es geklappt?

Unter dem Knopf erscheint eine Liste mit Haken:

| Schritt                                 | Heißt                                                     |
| --------------------------------------- | --------------------------------------------------------- |
| ✅ Adresse gefunden (DNS)               | Der Mailserver ist auffindbar.                            |
| ✅ Verbindung zum Port                  | Er nimmt Verbindungen an.                                 |
| ✅ Verschlüsselung (TLS) und Zertifikat | Die Verbindung ist sicher, das Zertifikat ist echt.       |
| ✅ Anmeldung                            | Adresse und Passwort stimmen.                             |
| ✅ Mail verschickt                      | Fertig! Schau in dein Postfach (auch in den Spam-Ordner). |

**Alles grün?** Dann bist du fertig. Unter **„Alle Einstellungen selbst festlegen“** kannst du noch die Registrierung auf der Startseite oder Mails bei Server-Abstürzen einschalten.

---

## Wenn etwas rot ist

Beim ersten roten Kreuz steht, was los ist und was du tun kannst. Die häufigsten Fälle:

| Meldung                                     | Was du tust                                                                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anmeldung abgelehnt**                     | Das Passwort stimmt nicht. In Stalwart beim Postfach ein neues Passwort setzen und im Schnellstart noch einmal eintragen.                                                                    |
| **Mailserver nicht gefunden**               | Schalter „Mein Mailserver steht bei mir zu Hause“ einschalten und die IP eintragen.                                                                                                          |
| **Keine Antwort** oder **Port geschlossen** | Läuft der Mail-Rechner? Stimmt die IP? Bei Stalwart muss Port 465 (oder 587) an sein.                                                                                                        |
| **Zertifikat passt nicht**                  | Das Zertifikat deines Mailservers passt zu keinem Namen deiner Domain. In Stalwart unter **Settings → TLS** ein Zertifikat für `mail.mornihosting.de` (oder `*.mornihosting.de`) einrichten. |
| **Absender abgelehnt**                      | Stalwart erlaubt dem Postfach nicht, unter dieser Adresse zu senden. Absender und Postfach müssen dieselbe Adresse haben.                                                                    |

Klappt es immer noch nicht? Schick mir (Claude) einen Screenshot der roten Meldung.

---

## Damit Mails nicht im Spam landen (einmalig, empfohlen)

Mail-Anbieter wie Gmail prüfen, ob dein Mailserver für deine Domain schreiben darf. Dafür gibt es drei DNS-Einträge (SPF, DKIM, DMARC).

1. In Stalwart: **Management → Directory → Domains** → bei `mornihosting.de` auf **DNS records** klicken. Stalwart zeigt dir fertige Einträge.
2. Trag sie bei deinem Domain-Anbieter (INWX → Domain → DNS) genau so ein.

**Wichtig bei dir:** Der MX-Eintrag von `mornihosting.de` zeigt auf `mail.pmornhart.de`, aber dieser Name hat im Internet keine Adresse.
Fürs **Verschicken** aus dem Panel ist das egal. Wenn du auch Mails **empfangen** willst, braucht `mail.pmornhart.de` einen A-Eintrag auf deine öffentliche IP.

---

Profi-Einstellungen (Server, Port, Verschlüsselung von Hand) findest du im Panel unter **„Alle Einstellungen selbst festlegen“** und in [email.md](email.md).
