# Häufige Fragen

## Ein Programm bleibt bei `online` = falsch

`error` am Gerät des Programms sagt, warum. Ein Netzwerk-Text (abgewiesen, Zeitüberschreitung, keine Route) heißt, der
ioBroker-Rechner erreicht das Programm nicht: Host, Port, den HTTPS-Schalter und eine Firewall dazwischen prüfen. Mit
**Verbindungen testen** in den Einstellungen probierst du die Tabelle aus, bevor du speicherst. Manche Programme weisen
Anfragen ab, die sie nicht kennen:

- **SABnzbd** antwortet nur Hostnamen aus seiner `host_whitelist` — die IP-Adresse eintragen oder den Namen dort
  hinzufügen.
- **Transmission** antwortet nur Adressen aus seiner `rpc-whitelist` — den ioBroker-Rechner eintragen oder die Liste
  abschalten.
- **JDownloader (lokale Schnittstelle)** antwortet nur dem eigenen Rechner, solange `DeprecatedApiLocalhostOnly` an
  ist.

## „Login rejected" — und das Programm wird nicht mehr gefragt

Weist ein Programm die Anmeldung ab, schreibt der Adapter eine Warnung, zeigt eine ioBroker-Benachrichtigung und fragt
dieses Programm nicht mehr. qBittorrent und Transmission sperren eine Adresse nach mehreren Fehlversuchen; alle paar
Sekunden neu zu fragen würde den ioBroker-Rechner aussperren. Korrigiere die Zugangsdaten in den Einstellungen — das
Speichern startet die Instanz neu, und das Programm wird wieder gefragt.

## Lokale JDownloader-Schnittstelle oder My.JDownloader?

Die lokale Schnittstelle hat kein Passwort: Wer ihren Port erreicht, kann JDownloaders Einstellungen ändern oder ihn
beenden. Nutze sie nur, wenn JDownloader auf dem ioBroker-Rechner oder im selben Docker-Netz läuft. In jedem anderen
Fall wähle _JDownloader 2 (My.JDownloader)_ und trage deine My.JDownloader-E-Mail, dein Passwort und den Gerätenamen
ein. My.JDownloader wird höchstens alle 30 Sekunden gefragt, egal was das Abfrage-Intervall sagt.

## Wie oft werden die Programme gefragt?

Jedes Programm wird alle _Abfrage-Intervall_ Sekunden gefragt (Standard 10, von 2 Sekunden bis 1 Stunde). Was du
schreibst — eine Pause, ein Limit, ein neuer Link — geht sofort an das Programm, und es wird direkt danach neu gefragt.
aria2 meldet Änderungen zusätzlich von selbst, sobald sie passieren.

## Löscht `remove` meine Dateien?

Nein. `remove` nimmt den Download aus der Liste des Programms; die Dateien bleiben erhalten. Der Adapter löscht nie
Dateien.

## Ein fertiger Download bleibt im Objektbaum

Er bleibt, solange das Programm ihn führt. Schalte _Fertige Downloads aus ioBroker entfernen_ ein, wenn du nur die
laufenden sehen willst: Fertige Downloads verschwinden dann aus dem Objektbaum, das Programm behält sie.
Weiterverteilte und fehlgeschlagene Downloads bleiben immer — ein weiterverteilter Torrent überträgt noch, ein
fehlgeschlagener Download braucht dich.

## Ich will eine Nachricht, wenn ein Download fertig ist

Löse auf `summary.lastFinished` (oder auf `lastFinished` des Programms) mit **wurde aktualisiert** aus, nicht mit
**wurde geändert**: Zwei Downloads mit demselben Namen enden mit demselben Wert, und ein Auslöser auf „geändert“
verpasst den zweiten. `summary.lastFinishedTime` enthält die Uhrzeit. `summary.lastFailed` funktioniert genauso für
fehlgeschlagene Downloads.

## `paused` bei Transmission, aria2 oder einem älteren qBittorrent

Diese Programme haben keine Pause für das ganze Programm. Der Adapter hält die laufenden Downloads an, merkt sich genau
diese und startet genau diese wieder, wenn du `paused` auf falsch setzt. Ein Download, den du selbst angehalten hast,
bleibt angehalten. Startest du einen der angehaltenen Downloads im Programm selbst, endet die Pause des Adapters.

## Warum gibt es bei SABnzbd- und NZBGet-Downloads kein `speed`?

Beide Programme laden einen Auftrag nach dem anderen und melden Geschwindigkeit und Restzeit nur für das ganze
Programm. Du findest sie in `downloadSpeed` des Programms; der Adapter erfindet keinen Wert je Download.

## Zwei Server mit demselben Programm

Lege je Server eine Zeile mit eigener ID an — `qbittorrent-nas` und `qbittorrent-seedbox` sind zwei Geräte
nebeneinander.

## Ich habe die ID eines Programms geändert

Behält eine Zeile Programm und Adresse, bekommt aber eine neue ID, übernimmt der Adapter die Raum- und
Funktionszuordnungen des Geräts und seiner Datenpunkte auf das neue Gerät und entfernt das alte; die Downloads kommen
mit der nächsten Abfrage wieder. Eine gelöschte Zeile nimmt ihr Gerät mit. Eine ausgeschaltete Zeile behält ihr Gerät,
es wird als nicht erreichbar angezeigt.

## pyLoad meldet „too many requests“

pyLoad erlaubt 100 Anfragen pro Minute. Erhöhe das Abfrage-Intervall oder frage dasselbe pyLoad seltener aus anderen
Werkzeugen ab.
