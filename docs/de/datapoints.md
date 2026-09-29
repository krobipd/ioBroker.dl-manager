# Datenpunkte

Zugriff: **r** nur lesen, **w** nur schreiben (ein Befehl), **rw** zeigt den aktuellen Wert und ändert ihn, wenn du ihn
schreibst. Geschwindigkeiten in MB/s, Größen in GB, Zeiten als Zeitstempel in Millisekunden. Ein Datenpunkt entsteht nur,
wo das Programm den Wert liefert — ein `–` in den Tabellen heißt, das Programm hat diesen Wert nicht, und der Datenpunkt
fehlt bei ihm.

Programm-Spalten: **JD** JDownloader 2 (lokale Schnittstelle und My.JDownloader), **qBt** qBittorrent, **TR**
Transmission, **DE** Deluge, **SAB** SABnzbd, **NZB** NZBGet, **a2** aria2, **pyL** pyLoad.

## `info` — der Adapter

| Datenpunkt               | Typ     | Zugriff | Bedeutung                                                                                |
| ------------------------ | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `info.connection`        | boolean | r       | Mindestens ein Download-Programm hat auf die letzte Abfrage geantwortet.                 |
| `info.programsTotal`     | number  | r       | Anzahl der eingerichteten und eingeschalteten Download-Programme.                        |
| `info.programsOnline`    | number  | r       | Anzahl der Download-Programme, die auf die letzte Abfrage geantwortet haben.             |
| `info.programsAllOnline` | boolean | r       | Wahr, wenn jedes eingerichtete Download-Programm auf die letzte Abfrage geantwortet hat. |

## `summary` — über alle Programme

| Datenpunkt                  | Typ           | Zugriff | Bedeutung                                                                                               |
| --------------------------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `summary.downloading`       | boolean       | r       | Wahr, solange irgendein Download eines Programms lädt oder nachbearbeitet wird.                         |
| `summary.active`            | number        | r       | Downloads, die laden oder nachbearbeitet werden, über alle Programme.                                   |
| `summary.queued`            | number        | r       | Downloads, die in einer Warteschlange stehen, über alle Programme.                                      |
| `summary.downloadSpeed`     | number (MB/s) | r       | Download-Geschwindigkeit aller erreichbaren Programme zusammen.                                         |
| `summary.uploadSpeed`       | number (MB/s) | r       | Upload-Geschwindigkeit aller erreichbaren Torrent-Programme zusammen.                                   |
| `summary.pauseAll`          | boolean       | rw      | Wahr pausiert jedes erreichbare Programm, falsch setzt sie fort.                                        |
| `summary.last.finished`     | string        | r       | Name des zuletzt fertigen Downloads; bei jedem Abschluss geschrieben, auch wenn der Name gleich bleibt. |
| `summary.last.finishedTime` | number        | r       | Wann dieser Download fertig wurde.                                                                      |
| `summary.last.failed`       | string        | r       | Name des zuletzt fehlgeschlagenen Downloads.                                                            |
| `summary.last.failedTime`   | number        | r       | Wann dieser Download fehlschlug.                                                                        |

`summary.pauseAll` zeigt wahr, wenn jedes erreichbare Programm, das pausieren kann, pausiert ist.

## `<programm>-<stück>` — ein Programm

| Datenpunkt          | Typ           | Zugriff | JD  | qBt | TR  | DE  | SAB | NZB | a2  | pyL | Bedeutung                                                                                               |
| ------------------- | ------------- | ------- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | ------------------------------------------------------------------------------------------------------- |
| `online`            | boolean       | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Das Programm hat auf die letzte Abfrage geantwortet.                                                    |
| `error`             | string        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | `Unknown` vor der ersten Antwort, leer, solange alles in Ordnung ist, sonst die Meldung des Programms.  |
| `version`           | string        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Programmversion.                                                                                        |
| `downloading`       | boolean       | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Wahr, solange ein Download dieses Programms lädt oder nachbearbeitet wird.                              |
| `paused`            | boolean       | rw      |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Wahr pausiert das Programm, falsch setzt es fort.                                                       |
| `downloadSpeed`     | number (MB/s) | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Download-Geschwindigkeit.                                                                               |
| `uploadSpeed`       | number (MB/s) | r       |  –  |  ✓  |  ✓  |  ✓  |  –  |  –  |  ✓  |  –  | Upload-Geschwindigkeit.                                                                                 |
| `speedLimit`        | number (MB/s) | rw      |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Höchste Download-Geschwindigkeit des Programms; 0 heißt unbegrenzt.                                     |
| `uploadLimit`       | number (MB/s) | rw      |  –  |  ✓  |  ✓  |  ✓  |  –  |  –  |  ✓  |  –  | Höchste Upload-Geschwindigkeit des Programms; 0 heißt unbegrenzt.                                       |
| `altSpeed`          | boolean       | rw      |  –  |  ✓  |  ✓  |  –  |  –  |  –  |  –  |  –  | Schaltet die alternativen Geschwindigkeitsgrenzen des Programms ein oder aus.                           |
| `freeSpace`         | number (GB)   | r       |  –  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  –  |  ✓  | Freier Speicher im Download-Ordner des Programms.                                                       |
| `active`            | number        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Aktive Downloads.                                                                                       |
| `queued`            | number        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Wartende Downloads.                                                                                     |
| `total`             | number        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Downloads in der Liste des Programms.                                                                   |
| `add`               | string        | w       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Einen Link, Magnet-Link oder NZB-Link schreiben, um ihn diesem Programm hinzuzufügen.                   |
| `last.finished`     | string        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Name des zuletzt fertigen Downloads; bei jedem Abschluss geschrieben, auch wenn der Name gleich bleibt. |
| `last.finishedTime` | number        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Wann dieser Download fertig wurde.                                                                      |
| `last.failed`       | string        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Name des zuletzt fehlgeschlagenen Downloads.                                                            |
| `last.failedTime`   | number        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Wann dieser Download fehlschlug.                                                                        |

Transmission, aria2 und qBittorrent vor 5.3 haben keine Pause für das ganze Programm. Dort hält der Adapter die
laufenden Downloads an, merkt sich genau diese und startet genau diese beim Fortsetzen wieder — ein Download, den du
selbst angehalten hast, bleibt angehalten. Das Gemerkte übersteht einen Neustart des Adapters.

## `<programm>-<stück>.downloads.<download>` — ein Download

Ein Download ist, was du hinzugefügt hast: ein JDownloader- oder pyLoad-Paket, ein Torrent, ein NZB-Auftrag, ein
aria2-Download.

| Datenpunkt    | Typ           | Zugriff | JD  | qBt | TR  | DE  | SAB | NZB | a2  | pyL | Bedeutung                                                                           |
| ------------- | ------------- | ------- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | ----------------------------------------------------------------------------------- |
| `status`      | string        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Einer der Status-Werte unten.                                                       |
| `progress`    | number (%)    | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Fortschritt.                                                                        |
| `size`        | number (GB)   | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Größe.                                                                              |
| `downloaded`  | number (GB)   | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Heruntergeladen.                                                                    |
| `speed`       | number (MB/s) | r       |  ✓  |  ✓  |  ✓  |  ✓  |  –  |  –  |  ✓  |  ✓  | Geschwindigkeit.                                                                    |
| `uploadSpeed` | number (MB/s) | r       |  –  |  ✓  |  ✓  |  ✓  |  –  |  –  |  ✓  |  –  | Upload-Geschwindigkeit.                                                             |
| `ratio`       | number        | r       |  –  |  ✓  |  ✓  |  ✓  |  –  |  –  |  ✓  |  –  | Hochgeladene Menge geteilt durch heruntergeladene Menge.                            |
| `eta`         | number (s)    | r       |  ✓  |  ✓  |  ✓  |  ✓  |  –  |  –  |  ✓  |  ✓  | Sekunden, bis der Download fertig ist; leer, wenn das Programm es nicht sagen kann. |
| `added`       | number        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  –  |  –  |  –  | Wann der Download hinzugefügt wurde.                                                |
| `finished`    | number        | r       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  –  |  –  | Wann der Download fertig wurde.                                                     |
| `category`    | string        | r       |  –  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  –  |  –  | Die Kategorie oder das Label, das du dem Download im Programm gegeben hast.         |
| `error`       | string        | r       |  ✓  |  –  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Fehlermeldung des Programms; leer, solange alles in Ordnung ist.                    |
| `paused`      | boolean       | rw      |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  –  | Wahr hält diesen Download an, falsch setzt ihn fort.                                |
| `remove`      | boolean       | w       |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  |  ✓  | Entfernt den Download aus der Liste des Programms; die Dateien bleiben erhalten.    |

SABnzbd und NZBGet melden Geschwindigkeit und Restzeit nur für das ganze Programm, nicht je Download.

### Extras einzelner Programme

| Datenpunkt   | Programm    | Art      | Bedeutung                                                          |
| ------------ | ----------- | -------- | ------------------------------------------------------------------ |
| `recheck`    | qBittorrent | Knopf    | Prüft die heruntergeladenen Daten erneut.                          |
| `forceStart` | qBittorrent | Schalter | Startet den Download sofort, ohne auf die Warteschlange zu achten. |
| `retry`      | SABnzbd     | Knopf    | Startet einen fehlgeschlagenen Download erneut.                    |
| `retry`      | NZBGet      | Knopf    | Startet einen fehlgeschlagenen Download erneut.                    |

## Status-Werte

Der Wert von `status` ist für jedes Programm dieselbe Liste; der Objektbaum zeigt die Bezeichnung in deiner Sprache.

| Wert             | Bezeichnung         | Bedeutung                                                                                                                                 |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`         | Wartet              | Steht in der Warteschlange des Programms.                                                                                                 |
| `downloading`    | Lädt                | Lädt.                                                                                                                                     |
| `waiting`        | Kommt nicht voran   | Soll laden, kommt aber nicht voran — Wartezeit oder Captcha beim Hoster, ein Torrent ohne Gegenstellen, eine NZB, die sich noch verteilt. |
| `paused`         | Angehalten          | Angehalten, von dir oder vom Programm.                                                                                                    |
| `checking`       | Wird geprüft        | Das Programm prüft oder bereitet die Daten vor — Torrent-Prüfung, Metadaten, Speicher reservieren, Hash-Prüfung.                          |
| `postprocessing` | Wird nachbearbeitet | Geladen; das Programm repariert, entpackt oder verschiebt ihn.                                                                            |
| `seeding`        | Wird weiterverteilt | Fertig und wird an andere weitergegeben (Torrents).                                                                                       |
| `completed`      | Fertig              | Fertig.                                                                                                                                   |
| `failed`         | Fehlgeschlagen      | Das Programm hat aufgegeben — der Grund steht in `error`, wo das Programm einen nennt.                                                    |

`summary.downloading`, `downloading` des Programms und die Zähler `active` zählen `downloading` und `postprocessing`.
