# Discord-Benachrichtigungen – Schritt für Schritt

Danach schreibt dir dein Panel **privat per Discord-Direktnachricht**:

- 🙋 wenn sich jemand registriert hat (mit Knöpfen **Freigeben** / **Ablehnen**),
- 🖥️ wenn jemand einen Server anfragt (auch mit Knöpfen),
- ⚠️ wenn ein Server abstürzt,
- 🚀 deinen Leuten, wenn ihre Anfrage angenommen oder abgelehnt wurde.

Kein Discord-Server nötig, alles läuft über private Nachrichten. Das Panel braucht dafür auch keinen offenen Port.

---

🎬 **Erklärvideo (48 Sekunden):** [discord-erklaervideo.mp4](discord-erklaervideo.mp4)

## Teil 1 – Den Bot anlegen (einmal, nur du als Admin, 2 Minuten)

1. Öffne <https://discord.com/developers/applications>, klick **New Application**, Name `MorniHosting`, **Create**.
2. Links auf **Bot** → **Reset Token** → **Copy**. Das ist der Bot-Token. Gib ihn niemandem.
3. Im Panel: **Benachrichtigungen** → Karte **Discord-Bot** → Token einfügen → **Verbinden**.

Das war's. Profilbild, Beschreibung, Installations-Einstellungen und den Befehl `/verbinden` stellt das Panel selbst ein.

## Teil 2 – Dein Discord verbinden (jede Person, 1 Minute)

1. Im Panel: **Mein Konto → Benachrichtigungen** → **App hinzufügen** → in Discord **Autorisieren**.
2. In Discord in irgendeinen Chat `/verbinden` tippen, den Befehl aus der Liste wählen, Enter.
3. Auf **Jetzt verbinden** klicken. Das Panel öffnet sich, **Ja, verbinden** klicken. Fertig – der Bot schreibt dir „👋 Hallo von MorniHosting“.

Sagt das Panel, dass Discord die Nachricht nicht durchlässt: einmal **Bot auf meinen Server holen** klicken (irgendein Server von dir). Der Bot schreibt dort nichts, aber danach kommen die Nachrichten privat an.

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
