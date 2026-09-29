# ioBroker.dl-manager — Benutzerdokumentation

Der Adapter verbindet ioBroker mit deinen Download-Programmen. Jedes Programm, das du einträgst, wird ein Gerät, jeder
seiner Downloads ein Kanal mit eigenen Datenpunkten. Alles, was der Adapter zeigt, kommt vom Programm selbst; der
Adapter lädt nie selbst etwas herunter und löscht nie Dateien.

## Unterstützte Programme

| Programm                       | Zugang                          | Was du brauchst                                                                                                                                                                            |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JDownloader 2 (lokal)          | lokale Schnittstelle, Port 3128 | In JDownloader: Einstellungen → Erweiterte Einstellungen → `DeprecatedApiEnabled` an; läuft ioBroker auf einem anderen Rechner oder Container, zusätzlich `DeprecatedApiLocalhostOnly` aus |
| JDownloader 2 (My.JDownloader) | die My.JDownloader-Cloud        | deine My.JDownloader-E-Mail und dein Passwort — den JDownloader wählst du aus deinem Konto                                                                                                 |
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

1. Adapter installieren und die Instanz-Einstellungen öffnen. Die Programme sind Karten des Gerätemanagers; sie
   erscheinen, solange die Instanz läuft.
2. **+** drücken, Programm wählen. Sein Dialog fragt nur, was dieses Programm braucht: einen Namen, Adresse und Port
   (leer = der Standard des Programms) und seine Anmeldung. Bei JDownloader _Lokal im Netz_ oder _Über My.JDownloader_
   wählen; mit My.JDownloader meldest du dich an und wählst deinen JDownloader aus einer Liste.
3. Übernehmen. Das Programm erscheint sofort als Karte und als Gerät unter `dl-manager.0` — die Instanz startet nicht
   neu. Der Name ist nur die Beschriftung von Karte und Gerät. Die Objekt-ID vergibt der Adapter: das Programm und der
   Rechner, auf dem es läuft (`qbittorrent-nas`, `transmission-192-168-1-20`; bei `localhost` der Name des
   ioBroker-Hosts), bei My.JDownloader die letzten vier Zeichen der Kennung, die das Konto für diesen JDownloader führt
   (`jdownloader-7f11`). Ein zweites Programm auf demselben Rechner bekommt seinen Port, dann einen Zähler. Die ID ändert
   sich danach nie mehr — nicht bei neuem Namen, neuer Adresse oder einem Wechsel zwischen lokal und My.JDownloader —,
   damit Räume, Funktionen und Skripte weiter passen. Die Details der Karte zeigen sie.
4. Der Test-Knopf auf der Karte fragt das Programm einmal und zeigt seine Version oder den Grund, warum es nicht
   erreichbar ist.

Jedes Programm lässt sich beliebig oft hinzufügen. Ein zweiter Eintrag für dasselbe Programm — dieselbe Adresse oder
derselbe JDownloader eines My.JDownloader-Kontos — wird abgewiesen. Der Schalter auf einer Karte schaltet ein Programm
ab, ohne sein Gerät zu löschen; Löschen entfernt das Gerät, nie eine Datei. Passwörter und API-Schlüssel liegen mit dem
Geheimnis der Installation verschlüsselt im Objekt `dl-manager.0.programs` des Adapters.

## Was du im Objektbaum findest

- `info.*` — wie viele Programme eingerichtet und erreichbar sind.
- `summary.*` — über alle Programme: ob irgendein Download aktiv ist, die Gesamt-Geschwindigkeiten, ein Schalter, der
  alle Programme pausiert; `summary.last.*` der zuletzt fertige und der zuletzt fehlgeschlagene Download (mit Uhrzeit).
- `<programm>-<stück>.*` — das Programm: erreichbar, Grund, Version, Geschwindigkeiten, Limits, freier Speicher,
  Pause-Schalter, ein Eingabefeld für neue Links, Zähler; `last.*` der eigene zuletzt fertige / fehlgeschlagene
  Download.
- `<programm>-<stück>.downloads.<download>.*` — ein Kanal je Download mit Status, Fortschritt, Größe, Geschwindigkeit,
  Restzeit, Fehler und den Aktionen, die das Programm anbietet (anhalten, entfernen, bei manchen Programmen neu prüfen,
  sofort starten oder erneut versuchen).

Der Status ist für jedes Programm dieselbe Liste: wartet, lädt, kommt nicht voran, angehalten, wird geprüft, wird
nachbearbeitet, wird weiterverteilt, fertig, fehlgeschlagen.

## Welche Downloads im Objektbaum stehen

Zwei Einstellungen bestimmen, welche Downloads einen eigenen Kanal bekommen. Das Programm behält in jedem Fall alle
Downloads, und die Summen (`summary.*`, die Zähler des Programms und `last.finished`) zählen immer jeden Download.

- **Downloads im Objektbaum:** _Alle_ (Vorgabe), _Ohne fertige_ oder _Nur unfertige_ — die letzte Stufe lässt auch
  weiterverteilte Torrents weg. Fehlgeschlagene Downloads bleiben immer, sie brauchen dich.
- **Höchstens so viele Downloads je Programm:** Vorgabe 100, 0 = alle. Hat ein Programm mehr, behalten zuerst die
  laufenden ihren Kanal, dann fehlgeschlagene, pausierte und wartende, die in der Warteschlange, weiterverteilte und
  fertige — innerhalb jeder Gruppe die neuesten zuerst. Ein Download, der seinen Kanal verliert, bekommt ihn zurück,
  sobald wieder Platz ist.

Jeder Download legt bis zu 15 Objekte an, deren Werte sich bei jeder Abfrage ändern können. Mit 0 oder mehr als 200
Downloads je Programm werden es schnell Tausende; das belastet die ioBroker-Datenbank und macht den Objektbaum im Admin
langsam. Die Einstellungsseite zeigt dann eine Warnung, und das Log warnt einmal je Programm, wenn tatsächlich mehr als
200 Downloads im Objektbaum stehen.

`remove` an einem Download nimmt ihn aus der Liste des Programms; die Dateien bleiben immer erhalten.

## Aktualisierung von 0.2

Der erste Start von 0.3 zieht die Programme aus den Instanz-Einstellungen in `dl-manager.0.programs` um (die Instanz
startet einmal neu), verschlüsselt ihre Passwörter und gibt jedem Programm seine neue Objekt-ID. Jedes Gerät zieht mit
seinen Werten, Räumen, Funktionen und Aliasen um; eine Aufzeichnung behält ihren Verlauf unter der alten ID. Ein
My.JDownloader-Programm zieht um, sobald das Konto die Kennung seines JDownloaders genannt hat (erste erfolgreiche
Verbindung). Der zuletzt fertige und fehlgeschlagene Download ziehen in den Kanal `last`: `lastFinished` →
`last.finished`, `lastFinishedTime` → `last.finishedTime`, `lastFailed` → `last.failed`, `lastFailedTime` →
`last.failedTime` — unter jedem Programm und unter `summary`.

**Alte IDs in Skripten und VIS anpassen** — zum Beispiel `dl-manager.0.jdownloader-cloud` →
`dl-manager.0.jdownloader-7f11` und `dl-manager.0.summary.lastFinished` → `dl-manager.0.summary.last.finished`. Nicht
auf 0.2 zurückgehen: sie fände ihre Programme nicht mehr.

## Mehr

- [Alle Datenpunkte, je Programm](datapoints.md)
- [Häufige Fragen](faq.md)

## Fehlermeldung

Die Fehlermeldung über Sentry ist ab Werk aktiv; was sie sendet und wie man sie abschaltet, steht im [Abschnitt Sentry der Haupt-README](../../README.md#sentry--error-reporting).
