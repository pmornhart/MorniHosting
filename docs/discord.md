# Discord-Benachrichtigungen – Schritt für Schritt

Danach schreibt dir dein Panel **privat per Discord-Direktnachricht**:

- 🙋 wenn sich jemand registriert hat (mit Knöpfen **Freigeben** / **Ablehnen**),
- 🖥️ wenn jemand einen Server anfragt (auch mit Knöpfen),
- ⚠️ wenn ein Server abstürzt,
- 🚀 deinen Leuten, wenn ihre Anfrage angenommen oder abgelehnt wurde.

Kein Discord-Server nötig, alles läuft über private Nachrichten. Das Panel braucht dafür auch keinen offenen Port.

---

## Teil 1 – Den Bot anlegen (einmal, nur du als Admin, ca. 3 Minuten)

1. Öffne <https://discord.com/developers/applications> und melde dich mit deinem Discord-Konto an.
2. Klick oben rechts auf **New Application**, gib als Namen `MorniHosting` ein, Haken setzen, **Create**.
3. Links auf **Installation**:
   - Bei **Installation Contexts** **User Install** und **Guild Install** anhaken.
   - Bei **Guild Install** als Scopes `bot` und `applications.commands` auswählen (Rechte: keine).
   - Bei **Install Link** „Discord Provided Link“ auswählen.
   - Unten **Save Changes**.
4. Links auf **Bot** → **Reset Token** → **Yes, do it!** → **Copy**. Das ist der Bot-Token. Gib ihn niemandem.
5. Im Panel: **Benachrichtigungen** (Menü links) → Karte **Discord-Bot** → Token einfügen → **Verbinden**.
   Steht dort **Online**, ist der Bot fertig.

## Teil 2 – Dein eigenes Discord verbinden (jede Person, ca. 1 Minute)

1. Im Panel: **Mein Konto** (unten links auf deinen Namen) → Karte **Benachrichtigungen** → **Discord verbinden**.
2. Klick **App hinzufügen**. Discord öffnet sich und fragt „Zu meinen Apps hinzufügen“ → **Autorisieren**.
3. Zurück im Panel: **Code anzeigen**. Du siehst z. B. `/verbinden 482913`.
4. In Discord: Tippe in **irgendeinen Chat** (einen Kanal auf einem beliebigen Server oder einen Chat mit einem Freund) `/verbinden`, wähle den Befehl von MorniHosting aus und gib den Code ein. Abschicken. Die Antwort siehst nur du.
5. Der Bot antwortet „✅ Verbunden“ und schreibt dir gleich danach privat „👋 Hallo von MorniHosting“. Damit ist der Chat mit ihm offen und steht bei deinen Direktnachrichten. Im Panel steht **Verbunden mit …**. Fertig!

### Keine Nachricht vom Bot? (wichtig)

Discord lässt einen Bot dir nur privat schreiben, wenn ihr **einen gemeinsamen Server** habt. Dann so:

1. Im Panel unter **Mein Konto → Benachrichtigungen** auf **Bot auf meinen Server holen** klicken (oder auf der Karte **Discord-Bot**).
2. Irgendeinen deiner Server auswählen, auch ein leerer eigener reicht. Auf **Autorisieren** klicken.
3. Zurück im Panel **Test-Nachricht senden**. Jetzt kommt sie privat bei dir an.

Der Bot schreibt auf dem Server selbst nichts, alles bleibt private Nachricht. Nach `/verbinden` sagt er dir übrigens direkt, ob er dir schreiben darf.

Unter **Mein Konto → Benachrichtigungen** kannst du jederzeit einstellen, **wie** (E-Mail, Discord) und **worüber** (Freigaben, Abstürze, Antworten auf Anfragen) du Bescheid bekommst.

---

## So läuft eine Freigabe

**Neue Registrierung:** Jemand registriert sich auf deiner Startseite und bestätigt die E-Mail-Adresse. Du bekommst eine Mail und eine Discord-DM. Ein Klick auf **Freigeben** genügt, die Person bekommt eine Mail „Du bist freigeschaltet“. Bei **Ablehnen** wird das Konto gelöscht, die Person bekommt Bescheid.
Den Schalter dafür findest du im **Admin-Bereich → E-Mail → Alle Einstellungen → „Neue Konten muss ich erst freigeben“** (ist von Anfang an an).

**Server-Anfrage:** Wer keine Server selbst erstellen darf, sieht im Menü **Server anfragen**. Die Bestellung geht dann als Anfrage an dich. Mit **Freigeben** (Discord, oder im Panel unter **Freigaben**) wird der Server sofort für die Person angelegt.

Du kannst im Panel oder in Discord entscheiden. Was zuerst kommt, zählt, der andere Weg zeigt dann „Schon erledigt“.

---

## Wenn etwas nicht klappt

| Problem                                  | Lösung                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Discord kennt diesen Bot-Token nicht“   | Im Developer Portal unter **Bot** noch einmal **Reset Token** und den neuen Token eintragen.                                                                                                                    |
| `/verbinden` taucht in Discord nicht auf | Discord einmal neu laden (Strg+R). Prüfe, dass bei **Installation** „User Install“ angehakt ist.                                                                                                                |
| „Code ungültig“                          | Der Code gilt 10 Minuten. Im Panel neuen Code holen.                                                                                                                                                            |
| Keine DMs                                | Bot auf einen gemeinsamen Server holen (siehe oben). Außerdem in Discord → Einstellungen → **Privatsphäre & Sicherheit** Direktnachrichten erlauben. Im Panel unter Mein Konto prüfen, ob „Per Discord“ an ist. |
| Freunde können die App nicht hinzufügen  | Im Developer Portal unter **Bot** muss **Public Bot** an sein.                                                                                                                                                  |
