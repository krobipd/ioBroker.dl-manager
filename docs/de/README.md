# ioBroker.dl-manager — Benutzerdokumentation

Der Adapter verbindet ioBroker mit deinen Download-Programmen. Jedes Programm, das du einträgst, wird ein Gerät, jeder
seiner Downloads ein Kanal mit eigenen Datenpunkten. Alles, was der Adapter zeigt, kommt vom Programm selbst; der
Adapter lädt nie selbst etwas herunter und bittet nie ein Programm, Dateien zu löschen.

## Unterstützte Programme

| Programm                       | Zugang                                                | Was du brauchst                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JDownloader 2 (lokal)          | lokale Schnittstelle, Port 3128                       | In JDownloader: Einstellungen → Erweiterte Einstellungen → `DeprecatedApiEnabled` an; läuft ioBroker auf einem anderen Rechner oder Container, zusätzlich `DeprecatedApiLocalhostOnly` aus                |
| JDownloader 2 (My.JDownloader) | die My.JDownloader-Cloud                              | deine My.JDownloader-E-Mail und dein Passwort — den JDownloader wählst du aus deinem Konto                                                                                                                |
| qBittorrent                    | Weboberfläche, Port 8080                              | Benutzer und Passwort der Weboberfläche oder einen API-Schlüssel (ab qBittorrent 5.2)                                                                                                                     |
| Transmission                   | RPC, Port 9091                                        | Benutzer und Passwort, falls gesetzt; der ioBroker-Rechner muss in `rpc-whitelist` erlaubt sein                                                                                                           |
| Deluge                         | Weboberfläche, Port 8112                              | das Passwort der Weboberfläche                                                                                                                                                                            |
| SABnzbd                        | API, Port 8080                                        | den API-Schlüssel (Config → General)                                                                                                                                                                      |
| NZBGet                         | API, Port 6789                                        | Steuer-Benutzer und Passwort                                                                                                                                                                              |
| aria2                          | JSON-RPC, Port 6800                                   | das RPC-Geheimnis (`--rpc-secret`)                                                                                                                                                                        |
| pyLoad                         | API, Port 8000                                        | einen API-Schlüssel (ab pyLoad 0.5.0b3.dev97) oder Benutzer und Passwort                                                                                                                                  |
| rqbit                          | HTTP-API, Port 3030                                   | Benutzer und Passwort nur, wenn rqbit mit `RQBIT_HTTP_BASIC_AUTH_USERPASS` läuft; rqbit antwortet nur auf 127.0.0.1, außer es startet mit `--http-api-listen-addr 0.0.0.0:3030` (das Docker-Image tut es) |
| rTorrent                       | XML-RPC über einen Webserver, Port 8080, Pfad `/RPC2` | die Adresse des Webservers vor rTorrent (nginx, lighttpd, das ruTorrent-Image) und seine HTTP-Anmeldung, falls er eine verlangt                                                                           |
| Tribler                        | REST-API, Port 20100                                  | den API-Schlüssel; einen festen Port (`CORE_API_PORT` oder `api.http_port` in Triblers `configuration.json`) und `api.http_host` 0.0.0.0, wenn ioBroker auf einem anderen Rechner läuft                   |
| Flood                          | REST-API, Port 3000                                   | den Benutzer, mit dem du dich bei Flood anmeldest — nicht die Anmeldung des Torrent-Programms dahinter; keinen, wenn Flood mit `--auth none` läuft                                                        |
| Vuze                           | Plugin Web Remote, Port 9091                          | Benutzer und Passwort des Plugins — wie installiert der Benutzer `vuze` und der Zugangscode des Pairings                                                                                                  |
| µTorrent                       | Weboberfläche, Port 8080 (µTorrent Server)            | Benutzer und Passwort des Web-Zugriffs (Einstellungen → Erweitert → Web-Zugriff); den ioBroker-Rechner in der Liste erlaubter IPs, falls es eine gibt                                                     |
| Hadouken                       | JSON-RPC, Port 7070, Pfad `/api`                      | Benutzer und Passwort aus `http.auth.basic` in `hadouken.json` — admin und admin, wenn keine gesetzt sind                                                                                                 |
| Download Station               | DSM-Web-API, Port 5000 (HTTPS 5001)                   | ein DSM-Konto mit dem Recht, Download Station zu nutzen, und ohne 2-Schritt-Verifizierung; nur ein Konto, das Download Station verwaltet, liest und setzt das Upload-Limit                                |
| NZBVortex                      | Network-API, HTTPS, Port 4321                         | Preferences → Remote → Web interface an und den API-Schlüssel; die Adresse von ioBroker in seiner IP-Whitelist, falls die an ist                                                                          |
| Freebox                        | Freebox-OS-API, HTTPS, `mafreebox.freebox.fr`         | nichts einzutippen: beim Speichern der Karte bittet der Adapter die Freebox um Zugang, und du bestätigst ihn am Display der Freebox — aus dem eigenen Netz der Freebox                                    |

**Zur lokalen JDownloader-Schnittstelle:** Sie hat kein Passwort. Wer im Netz den Port erreicht, kann JDownloaders
Einstellungen ändern oder ihn beenden. Nutze sie nur, wenn JDownloader auf dem ioBroker-Rechner oder im selben
Docker-Netz läuft; sonst nimm My.JDownloader.

**Zu NZBVortex:** Es spricht HTTPS mit einem eigenen, selbstsignierten Zertifikat, das der Adapter ungeprüft annimmt.
Ist SSL in NZBVortex abgeschaltet, schalte auch auf seiner Karte HTTPS ab.

**Zur Freebox:** Lass `mafreebox.freebox.fr` als Host stehen — der Adapter prüft das Zertifikat der Freebox gegen die
eigenen Stammzertifikate von Free, und es gilt für diesen Namen, nicht für die IP-Adresse der Box. Mit abgeschaltetem
HTTPS antwortet die Freebox auf Port 80. Der Zugang, den die Freebox gewährt, wird verschlüsselt gespeichert wie ein
Passwort. Fehlt der App _ioBroker dl-manager_ das Recht auf die Downloads, gewähre es in Freebox OS (Paramètres de la
Freebox › Gestion des accès › Applications) und schalte die Karte der Freebox aus und wieder ein. Hast du die App auf
der Freebox entfernt, hake im Dialog der Karte _Neu mit der Freebox koppeln_ an und bestätige noch einmal am Display.

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
ab, ohne sein Gerät zu löschen; Löschen entfernt das Gerät, nie eine Datei. Die Programme liegen in `programs.json` im
Datenordner der Instanz (`iobroker-data/dl-manager.0/`, Teil jeder ioBroker-Sicherung), nicht im Objektbaum; Passwörter
und API-Schlüssel sind mit dem Geheimnis der Installation verschlüsselt.

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

- **Downloads im Objektbaum:** _Alle_ (Vorgabe), _Ohne fertige_ oder _Nur unfertige (ohne fertige und seedende)_ —
  die letzte Stufe lässt auch weiterverteilte Torrents weg. Fehlgeschlagene Downloads bleiben immer, sie brauchen dich.
- **Höchstens so viele Downloads je Programm im Objektbaum:** Vorgabe 100, 0 = alle. Hat ein Programm mehr, behalten
  zuerst die laufenden ihren Kanal, dann fehlgeschlagene, pausierte und wartende, die in der Warteschlange,
  weiterverteilte und fertige — innerhalb jeder Gruppe die neuesten zuerst. Ein Download, der seinen Kanal verliert,
  bekommt ihn zurück, sobald wieder Platz ist.

Jeder Download legt bis zu 15 Objekte an, deren Werte sich bei jeder Abfrage ändern können. Mit 0 oder mehr als 200
Downloads je Programm werden es schnell Tausende; das belastet die ioBroker-Datenbank und macht den Objektbaum im Admin
langsam. Die Einstellungsseite zeigt dann eine Warnung, und das Log warnt einmal je Programm, wenn tatsächlich mehr als
200 Downloads im Objektbaum stehen.

## Ein neuer Link, während ein Programm pausiert ist

**Ein neuer Link setzt ein pausiertes Programm fort** (Vorgabe aus) entscheidet, was ein Link bewirkt, den du in `add`
eines Programms schreibst, während das Programm pausiert ist. Aus: Die Pause hält bei jedem Programm, und der Link
wartet, bis du das Programm fortsetzt; JDownloader, der bei jedem neuen Link von selbst startet, wird sofort wieder
angehalten. An: Das Hinzufügen setzt das Programm zuerst fort, alle seine Downloads laufen weiter.

## Einen Download entfernen

`remove` an einem Download nimmt ihn aus der Liste seines Programms. Ob das Programm dabei auch löscht, was es für den
Download geladen hat — bei einem fertigen Download die Dateien, bei einem abgebrochenen oder fehlgeschlagenen das bis
dahin Geladene —, entscheidet der Schalter **Beim Entfernen auch die Dateien löschen**, Vorgabe aus. Er steht auf der
Einstellungsseite für alle Programme; solange er dort aus ist, hat die Karte jedes Programms, das Dateien löschen kann,
denselben Schalter nur für dieses Programm, und solange er an ist, folgt ihm jede Karte. Die Datenpunkte des Downloads
gehören nicht dazu — die regeln die Einstellungen unter _Löschen von Datenpunkten_.

Ein Download, den sein Programm nicht so entfernen kann, wie der Schalter sagt, hat kein `remove` — er bekommt es
zurück, sobald das Entfernen wieder geht, etwa wenn er fertig ist oder der Schalter umgestellt wurde:

| Programm                | Was es nicht kann                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| aria2, pyLoad, rTorrent | Dateien löschen — ihre Karten haben keinen Schalter                                                       |
| SABnzbd                 | die Dateien eines fertigen Downloads löschen; einen Download entfernen, während es ihn nachbearbeitet     |
| NZBGet                  | die Dateien eines fertigen Downloads löschen; die Dateien eines fehlgeschlagenen oder gelöschten behalten |
| Download Station        | die Dateien eines fertigen Downloads löschen; behalten, was ein unfertiger geladen hat                    |

## Löschen von Datenpunkten

Stellt der Adapter einen Datenpunkt nicht mehr bereit — ein Download ist aus der Liste des Programms verschwunden oder
fällt aus den Baum-Einstellungen, eine Programm-Karte wurde gelöscht —, löscht er ihn. Zwei Einstellungen am Ende der
Einstellungsseite entscheiden, was mit einem Datenpunkt geschieht, den du aufzeichnest (history, sql, influxdb):

- **Datenpunkte mit Aufzeichnung löschen** (Vorgabe an): an, geht ein solcher Datenpunkt wie jeder andere. Aus, bleibt er
  samt Kanal und Gerät darüber stehen, und eine Zeile im Log nennt, wie viele Datenpunkte behalten wurden und welche
  Instanzen sie aufzeichnen — bitte manuell prüfen.
- **Auch die aufgezeichneten Daten löschen** (Vorgabe aus, nur sichtbar, solange die erste Einstellung an ist): jede
  aufzeichnende Instanz löscht zuerst die aufgezeichneten Daten des Datenpunkts. Ein Datenpunkt, dessen Daten eine Instanz
  nicht löscht, bleibt stehen.

Ein Gerät, das auf eine neue ID umzieht, ist keine Löschung: seine Datenpunkte ziehen mit Werten und Aufzeichnung mit.

## Aktualisierung von 0.2

Der erste Start von 0.3 zieht die Programme aus den Instanz-Einstellungen in den Programm-Speicher des Adapters um (die Instanz
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
