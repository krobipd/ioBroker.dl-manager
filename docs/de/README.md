# ioBroker.dl-manager — Benutzerdokumentation

Der Adapter verbindet ioBroker mit deinen Download-Programmen. Jedes Programm, das du einträgst, wird ein Gerät, jeder
seiner Downloads ein Kanal mit eigenen Datenpunkten. Alles, was der Adapter zeigt, kommt vom Programm selbst; der
Adapter lädt nie selbst etwas herunter und löscht nie Dateien.

## Unterstützte Programme

| Programm                       | Zugang                          | Was du brauchst                                                                                                                                                                            |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JDownloader 2 (lokal)          | lokale Schnittstelle, Port 3128 | In JDownloader: Einstellungen → Erweiterte Einstellungen → `DeprecatedApiEnabled` an; läuft ioBroker auf einem anderen Rechner oder Container, zusätzlich `DeprecatedApiLocalhostOnly` aus |
| JDownloader 2 (My.JDownloader) | die My.JDownloader-Cloud        | deine My.JDownloader-E-Mail und dein Passwort sowie den Gerätenamen aus My.JDownloader                                                                                                     |
| qBittorrent                    | Weboberfläche, Port 8080        | Benutzer und Passwort der Weboberfläche oder einen API-Schlüssel (ab qBittorrent 5.2)                                                                                                      |
| Transmission                   | RPC, Port 9091                  | Benutzer und Passwort, falls gesetzt; der ioBroker-Rechner muss in `rpc-whitelist` erlaubt sein                                                                                            |
| Deluge                         | Weboberfläche, Port 8112        | das Passwort der Weboberfläche                                                                                                                                                             |
| SABnzbd                        | API, Port 8080                  | den API-Schlüssel (Config → General)                                                                                                                                                       |
| NZBGet                         | API, Port 6789                  | Steuer-Benutzer und Passwort                                                                                                                                                               |
| aria2                          | JSON-RPC, Port 6800             | das RPC-Geheimnis (`--rpc-secret`)                                                                                                                                                         |
| pyLoad                         | API, Port 8000                  | einen API-Schlüssel (ab pyLoad 0.5.0b3.dev97) oder Benutzer und Passwort                                                                                                                   |

**Zur lokalen JDownloader-Schnittstelle:** Sie hat kein Passwort. Wer im Netz den Port erreicht, kann JDownloaders
Einstellungen ändern oder ihn beenden. Nutze sie nur, wenn JDownloader auf dem ioBroker-Rechner oder im selben
Docker-Netz läuft; sonst nimm My.JDownloader.

## Einrichtung

1. Adapter installieren und die Instanz-Einstellungen öffnen.
2. Je Programm eine Zeile anlegen: Programm wählen, eine kurze ID vergeben (Buchstaben, Ziffern und `-`, z. B. `nas`),
   Host, Port und die Zugangsdaten aus der Tabelle oben eintragen. Die ID wird Teil des Objektpfads — `qbittorrent-nas`.
3. **Verbindungen testen** drücken. Jedes Programm antwortet mit seiner Version oder mit dem Grund, warum es nicht
   erreichbar ist.
4. Speichern. Die Geräte erscheinen unter `dl-manager.0`.

## Was du im Objektbaum findest

- `info.*` — wie viele Programme eingerichtet und erreichbar sind.
- `summary.*` — über alle Programme: ob irgendein Download aktiv ist, die Gesamt-Geschwindigkeiten, ein Schalter, der
  alle Programme pausiert, der zuletzt fertige und der zuletzt fehlgeschlagene Download (mit Uhrzeit).
- `<programm>-<id>.*` — das Programm: erreichbar, Grund, Version, Geschwindigkeiten, Limits, freier Speicher,
  Pause-Schalter, ein Eingabefeld für neue Links, Zähler und der eigene zuletzt fertige / fehlgeschlagene Download.
- `<programm>-<id>.downloads.<download>.*` — ein Kanal je Download mit Status, Fortschritt, Größe, Geschwindigkeit,
  Restzeit, Fehler und den Aktionen, die das Programm anbietet (anhalten, entfernen, bei manchen Programmen neu prüfen,
  sofort starten oder erneut versuchen).

Der Status ist für jedes Programm dieselbe Liste: wartet, lädt, kommt nicht voran, angehalten, wird geprüft, wird
nachbearbeitet, wird weiterverteilt, fertig, fehlgeschlagen.

## Fertige Downloads

Ein fertiger Download bleibt im Objektbaum, solange das Programm ihn führt. Schalte **Fertige Downloads aus ioBroker
entfernen** ein, wenn du eine kurze Liste willst: Fertige Downloads verschwinden dann aus dem Objektbaum, das Programm
behält sie. Weiterverteilte und fehlgeschlagene bleiben. `remove` an einem Download nimmt ihn aus der Liste des
Programms; die Dateien bleiben immer erhalten.

## Mehr

- [Alle Datenpunkte, je Programm](datapoints.md)
- [Häufige Fragen](faq.md)

## Fehlermeldung

Die Fehlermeldung über Sentry ist ab Werk aktiv; was sie sendet und wie man sie abschaltet, steht im [Abschnitt Sentry der Haupt-README](../../README.md#sentry--error-reporting).
