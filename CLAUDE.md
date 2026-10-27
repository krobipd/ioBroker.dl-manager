# CLAUDE.md — ioBroker.dl-manager

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Download Manager** — ein Adapter, eine Instanz, acht Download-Programme (JDownloader 2 lokal und über
My.JDownloader, qBittorrent, Transmission, Deluge, SABnzbd, NZBGet, aria2, pyLoad). Je Programm ein Gerät, je Download ein
Kanal mit Einzel-Datenpunkten, Summen für Blockly.

- **Version:** `io-package.json` ist die Wahrheit; interne Geschichte samt Belegen in `.claude/dev-history.md` (lokal).
- **GitHub:** https://github.com/krobipd/ioBroker.dl-manager
- **npm:** https://www.npmjs.com/package/iobroker.dl-manager
- **Runtime-Deps:** `@iobroker/adapter-core` und `@iobroker/dm-utils` (Gerätemanager-Karten); fetch, WebSocket, node:crypto aus Node ≥ 22

## Architektur

```
src/main.ts                      → Lebenszyklus: I18n (erste Anweisung) → Speicher-Objekt von 0.3.x in die Datei (einmal) →
                                   Programme aus `native.programs` in den Speicher (einmal) → native-/common-Schlüssel
                                   migrieren → Objekt- und Wertespeicher laden → Manifest-Objekte auffrischen → settleDevices
                                   (Umzug fortsetzen, IDs vergeben, last-Umzug) → Gerätemanager bauen → subscribeStates("*")
                                   → ProgramManager.start; updateRows (frisch lesen, ändern, speichern, apply — ein Schritt in
                                   `Serial`), learnDeviceId (My.JD-Id), onStateChange, onUnload → stop().finally(cb);
                                   ein Stopp mitten im Start (`unloading`) startet kein Programm mehr und wartet ohne Manager
                                   auf den Start (`starting`), damit nach dem Rückruf nichts mehr schreibt; `ProgramManager.stop`
                                   hält jeden Runner sofort an (eine laufende Änderung, z. B. der Umzug nach einer gelernten
                                   My.JD-Id, kann länger dauern als `stopTimeout`) und stoppt danach, was die Änderung noch baute
src/lib/device-management.ts     → DlDeviceManagement (dm-utils): Karten je Zeile, Details (Objekt-ID), Hinzufügen
                                   (Programmwahl → Dialog → bei My.JDownloader Instanzwahl), Bearbeiten, Löschen, Test, Ein/Aus;
                                   jede Änderung über `DmHost.updateRows` auf den Zeilen von jetzt, kein Neustart
src/lib/dm-forms.ts              → rein: Dialog-Schemas, Zeile ↔ Dialogdaten, Duplikat-Ausdruck
src/lib/core/store.ts            → ProgramStore: `programs.json` im Datenordner der Instanz (`common.dataFolder`, im Backup),
                                   Passwort/API-Schlüssel mit `encrypt()`, unveränderter Klartext behält seinen Chiffretext,
                                   kein leerer Speicher, unlesbares JSON oder eine Datei ohne Programmliste hält den Start an; `adopt` übernimmt das Objekt von 0.3.x
src/lib/core/device-id.ts        → Geräte-ID `<programm>-<stück>` (deviceIdFor, hostPiece, settleIds), ID_SCHEME = 3, RESERVED_IDS
src/lib/core/move.ts             → moveObjects: Objekte + native, Werte mit ack/ts/lc/q, custom + aliasId, Aliase, EIN
                                   moveAllWithEnums, Kinder zuerst gelöscht, Journal `native.movingTo`, Marke idScheme
src/lib/core/model.ts            → STATUSES, ACTIVE, ProgramDriver-Vertrag (poll/command/close, subscribe?, test?, minIntervalMs?)
src/lib/core/datapoints.ts       → Fähigkeit → Datenpunkt (Programm- und Download-Ebene), einzige Datenpunkt-Tabelle
src/lib/core/config.ts           → Zeilen → ProgramRow {id, scheme, enabled, cfg, problem, entry?}, legacyId (ID bis 0.2.0),
                                   addressOf, programKey / sameProgram (Duplikat), Abfrage-Intervall 10 s–1 h
src/lib/core/manager.ts          → ProgramManager: Runner je Programm, apply (Zeilen live: neu/weg/geändert/umgezogen),
                                   Summen (eine Warteschlange, nie zwei gleichzeitig), Nutzer-Schreibweiche
src/lib/core/connection-test.ts  → testProgram: der Test-Knopf einer Karte (eine Zeile, ein Treiber, einmal gefragt)
src/lib/core/serial.ts           → Serial: Aufgaben nacheinander (Zeilenänderungen, Summen)
src/lib/core/devices.ts          → readDevices (nur Geräte mit Programmtyp, keine reservierte Wurzel), Offline-Stempel
src/lib/core/visibility.ts       → rein: welche Downloads einen Kanal bekommen (treeScope, Rang, Obergrenze)
src/lib/core/runner.ts           → Abfrage-Schleife je Programm, Anmelde-Sperre, pollNow nach jedem Befehl, Backoff nach Fehlschlägen;
                                   der Stopp hält den laufenden Abgleich nach dem aktuellen Download an (`tree.halt`) —
                                   ein erster Abgleich vieler Kanäle dauert sonst länger als `stopTimeout`
src/lib/core/login-hint.ts       → rein: was die Anmelde-Warnung je Anmeldeart sagt (Ursache, wenn die Karte keine Anmeldung trägt)
src/lib/core/log-lines.ts        → rein: Sammelzeile des Starts (startLine), info-Zeile nach einem Nutzerbefehl (commandLine)
src/lib/core/tree.ts             → ProgramTree: Gerät/Kanäle/Datenpunkte gegen den Schnappschuss abgleichen, itemKey
src/lib/core/transitions.ts      → rein: welche Downloads seit der letzten Abfrage fertig/fehlgeschlagen sind (erste Abfrage: last.finishedTime)
src/lib/known-objects.ts         → Flotten-Master (byte-gleich): KnownObjects, eigener Baum einmal gelesen, Objekte nur bei
                                   Unterschied schreiben (coveredBy, mergedWith wie js-controller)
src/lib/core/states.ts           → KnownStates: EIN Wertespeicher, jeder Zustand im Speicher verglichen; get (Karte, Baum),
                                   forget (fremder Schreibvorgang), remove (gelöschtes Objekt)
src/lib/core/summary.ts          → info.* und summary.* aus allen Programmen
src/lib/core/commands.ts         → routeState: Datenpunkt-Id → pauseAll / Befehl an Programm / ignorieren
src/lib/core/http.ts             → HttpClient: Timeout über Adapter-Timer, Cookies, keine Weiterleitungen, multipart,
                                   502/503/504 = nicht erreichbar, 429 = bis `retry-after` keine Anfrage
src/lib/core/answer.ts           → rein: Listen und Kennungen einer Programmantwort prüfen, sonst ProtocolError (ganz abgelehnt)
src/lib/core/emulated-pause.ts   → nachgebildete Programm-Pause (PauseStore im native des paused-Objekts)
src/lib/core/{errors,ids,units,redact,version,status}.ts → Fehlerklassen, Kennungen, Einheiten + Lesehelfer der Antworten,
                                   Geheimnisse, Programmversion (neu gelesen nach jedem Fehlschlag), unbekannter Status → queued
src/lib/programs/catalog.ts      → die EINZIGE Programmliste: Typ, Name, Familie, Standard-Port/-Pfad, Anmeldeart → needsOf,
                                   baseUrl; liest der Kern, jeder Client, die Duplikatprüfung und die Dialoge
src/lib/programs/registry.ts     → Katalog + Treiber (DRIVERS) → PROGRAMS, findProgram
src/lib/programs/<typ>/          → client.ts (Transport + Anmeldung), map.ts (Rohantwort → Modell, Status-Tabelle),
                                   driver.ts (Fähigkeiten, Extras, Befehle)
src/lib/{enum-carry,known-objects,err-text,native-key-migration}.ts → Kopien aus .consistency-master (byte-gleich)
src/lib/{actionable-problems,device-icons,i18n}.ts → Flotten-Muster
src/lib/api-limits.{json,ts}     → Limits jeder Gegenstelle (lokale Programme: pyLoads 100/min je Host; My.JDownloader: eigener
                                   Deckel); liegt in src/, im Paket über `files`; die pyLoad-429-Meldung liest ihre Zahl daraus
admin/jsonConfig.json, admin/icons/*.svg → Einstellungsseite (Gerätemanager + Allgemein + Spenden), Piktogramme je Familie
```

## Design-Entscheidungen

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen in `.claude/dev-history.md`._

1. **Ein Adapter, eine Instanz, alle Programme** — mehrere Gegenstellen sind Geräte in derselben Instanz.
2. **Jeder Download ist ein eigener Kanal** — keine JSON-Liste, Nutzer bauen mit Blockly.
3. **Ein Download ist die Einheit, die der Nutzer hinzugefügt hat** — JD-/pyLoad-Paket, Torrent, NZB-Auftrag, oberste aria2-GID.
4. **Eine Statusliste für alle Programme** — queued, downloading, waiting, paused, checking, postprocessing, seeding, completed, failed.
5. **Ein unbekannter Rohstatus wird `queued`** — mit Debug-Zeile samt Rohwert; der Vertragstest verlangt beides.
6. **Datenpunkte nur, wo das Programm sie liefert** — Fähigkeiten je Treiber entscheiden, keine Platzhalter.
7. **Welche Downloads einen Kanal bekommen, entscheiden zwei Einstellungen je Instanz** — `treeScope` (`all` / `withoutCompleted` / `unfinished`, `failed` bleibt immer) und `maxDownloads` je Programm (0–1000, 0 = alle, Vorgabe 100; Rang laufend → fehlgeschlagen → pausiert/wartend → Warteschlange → seedend → fertig, je Rang die neuesten zuerst); Summen zählen immer alles, über 200 warnen Einstellungsseite und Log.
8. **Nach einem Anmeldefehler wird das Programm nicht mehr gefragt** — bis zur nächsten Konfigurationsänderung (IP-Sperren).
9. **Passwort und API-Schlüssel liegen mit `encrypt()` verschlüsselt im Programm-Speicher (`store.ts`)** — ein unveränderter Klartext behält seinen Chiffretext, eine Zeile ohne `encrypted` (bis 0.2.0) hält sie wie eingetippt; nie `encryptedNative`-Punkt-Schlüssel (Prüfbot W1093/W1103).
10. **Dateien löscht der Adapter nie** — `remove` nimmt einen Download nur aus der Liste des Programms.
11. **JDownloader über My.JDownloader ist ein eigener Programmtyp** (`jdownloader-cloud`) mit demselben Treiber und zweitem Transport, höchstens alle 30 s, ohne Push.
12. **Fehlt dem Programm eine Programm-Pause, wird sie nachgebildet** (Transmission, aria2, qBittorrent < 5.3) — nur Laufende anhalten, genau diese fortsetzen (dazu, was der Adapter während der Pause angehalten hinzufügt), Stand übersteht den Neustart.
13. **Ein Gerät zieht nur über `move.ts` um (Werte, Aufzeichnung mit `aliasId`, Räume/Funktionen, Aliase, Kinder zuerst gelöscht, Journal an der alten Wurzel)** — eine gelöschte Zeile nimmt ihr Gerät mit, eine ausgeschaltete behält es offline.
14. **Die Programme richtet der Gerätemanager ein (dm-utils, Karten wie yamaha) und sie liegen in `programs.json` im Datenordner der Instanz (`common.dataFolder`, Teil jeder ioBroker-Sicherung), nie im Instanzobjekt und nicht im Objektbaum** — jede Kartenänderung wird gespeichert und live übernommen (`ProgramManager.apply`), die Instanz startet nicht neu und die Einstellungsseite kann keine Programmliste zurückschreiben; je Programm ein Dialog nur mit dessen Feldern aus `catalog.ts`; Radio-Beschriftungen sind einfache Zeichenketten (`tText`), weil json-configs Radio-Zweig `label` roh rendert.
15. **Beliebig viele Einträge je Programm, doppelt ist dasselbe Programm** — gleiche Adresse (Host, tatsächlicher Port und Pfad, ohne Schema) oder gleiches My.JDownloader-Konto samt Instanz; der Dialog weist es ab, der Adapter fragt die zweite Zeile nicht (`same program as <id>`).
16. **Die Geräte-ID vergibt der Adapter einmal beim Hinzufügen nach dem Schema yamaha/govee/homeconnect: `<programm>-<stück>` ohne Zugangsweg** — My.JDownloader die letzten 4 Zeichen der Konto-Id (belegt → ganze Id → Zähler), lokal der Rechner aus der Adresse (belegt → Port → Zähler, `localhost` = ioBroker-Host); gespeichert in der Zeile, nie neu berechnet, Marke `native.idScheme = 3`; der Name ist nur Anzeigename, ein ID-Feld gibt es nicht; die Karte zeigt die ID in den Details.
17. **Ein Wertespeicher (`KnownStates`)** — jeder Zustand im Speicher verglichen und auch dort gelesen (Karte, Baum), nie einzeln aus der Datenbank; ein fremder Schreibvorgang (ack:false) und ein gelöschtes Objekt lassen ihn vergessen; abonniert wird vor dem Start.
18. **Eine Karte warnt nur bei einem echten Fehler** — eine Zeile, die nicht laufen kann, mit ihrem Problem (ihr `error` sagt `Unknown`), sonst mit dem Text des Programms; `Unknown` und leer zeichnen kein Warndreieck (dm-gui zeigt jeden Text).
19. **Ein Gerätemanager-Dialog sperrt OK über `applyDisabledRule` aus allen Feldprüfungen (`applyRuleOf`)** — `validatorNoSaveOnError` und `validatorErrorText` wirken dort nicht; eine belegte Adresse erklärt ein Warnkasten im Dialog; kein Feld-Ausdruck enthält das Wort `return` (json-config läuft ihn sonst ohne eigenes `return`), eingebettete Werte gehen durch `literal()`.
20. **Eine Karte zeigt, sie steuert nichts** — kein `controls`-Schalter (krobi: die Admin braucht keine Steuerung); der Datenpunkt `paused` bleibt.
21. **Die vier „zuletzt“-Werte stehen im Kanal `last`** (`last.finished`, `last.finishedTime`, `last.failed`, `last.failedTime`) unter jedem Programm und unter `summary`; bis 0.2.0 flach, der Start zieht sie einmal um.
22. **My.JDownloader wird über die gespeicherte Konto-Id verbunden, der Name ist nur Rückfall für eine Zeile ohne Id** — eine Zeile aus 0.2.0 behält ihre alte ID (`idPending`), bis die erste Verbindung die Id nennt, dann zieht das Gerät live um.
23. **Eine Kartenänderung meldet ihr Ergebnis genau einmal auf info, der Start eine Sammelzeile, sonst ist ein Ausfall ein Zustand (debug)** — antwortet (Produkt + Version), nicht erreichbar, ausgeschaltet oder gelöscht (mit Datenpunktzahl); dieselbe Warnung höchstens einmal je Stunde und Programm, auch über eine gute Abfrage hinweg; die Anmelde-Warnung nennt, was die Karte trägt (`login-hint.ts`); was der Baum aus dem Objektbaum nimmt, steht nur nach dem Start auf info; die Aufzeichnung kommt in keiner Zeile vor.
24. **Programmzeilen ändern sich nur über `updateRows`** — frisch lesen, ändern, speichern und übernehmen in einem Schritt nacheinander; ein Dialog, dessen Karte sich inzwischen geändert hat oder weg ist, speichert nichts und sagt es.
25. **HTTP 502, 503 und 504 heißen „nicht erreichbar“** — ein Reverse-Proxy vor einem Programm, das nicht läuft; 500 entscheidet jeder Client selbst (JDownloader meldet damit eigene Fehler).
26. **Ein neuer Link in einem pausierten Programm: die Instanz-Einstellung `addResumes` entscheidet, für alle Programme gleich (krobi 2026-10-22 22:24 zu K8: „… besser in der admin …, wo der user dieses verhalten einstellen kann“)** — Vorgabe aus: die Pause hält, der Link wartet; JDownloader startet bei jedem Link in der Downloadliste von selbst (`LinkgrabberAutoStartEnabled`, ab Werk an, per API nicht abschaltbar, auch `moveToDownloadlist`; gemessen 2026-10-01), deshalb hält ihn sein Treiber sofort wieder an, wie er war (stop bzw. pause). An: der Manager schickt vor dem `add` ein `resumeAll`, wenn das Programm `globalPause` kann und die letzte Abfrage es pausiert las.
27. **Ein Ausfall zeigt sich nur an der Erreichbarkeit (krobi 2026-10-06 17:55, Flotten-Suite „counterpart gone and back“)** — ein nicht erreichbares Programm setzt nur `online` und die drei Erreichbarkeits-Werte unter `info`, `error`, Downloads und Summen behalten ihre letzten Werte (die Summen zählen den letzten Schnappschuss jedes Programms); ein Fehlschlag schreibt nur die Erreichbarkeit, ein unbestätigtes `summary.pauseAll` bleibt unbestätigt; nur Stopp und Start (für einen Absturz, `idleSummary`) setzen die Summen auf nichts.
28. **Eine Antwort, die ihre Form verloren hat, wird ganz abgelehnt (Flotten-Suite C26b)** — Download-Listen und ihre Kennungen gehen durch `answer.ts`, die Kennungsart (Text oder Zahl) legt jeder Treiber fest; eine leere Version behält die letzte; nur ein ausdrückliches Nein des Programms ist eine abgelehnte Anmeldung.
29. **Ein 429 ist ein Ratenlimit (Flotten-Suite D21)** — der HTTP-Client fragt das Programm bis zum Ende von `retry-after` nicht mehr (Sekunden oder HTTP-Datum, ohne 60 s, höchstens 1 h); Fehlschläge in Folge verdoppeln den Abstand bis 120 s, ein länger eingestelltes Intervall bleibt.

<!-- core-decisions:begin (generated from the sealed register — change only through the Werkbank) -->

## Core decisions (sealed)

krobi's decisions for this adapter. The register with his verbatim words lives in the locked Werkbank tool tree; a change is a request to the Werkbank, never an edit here. Each guarded rule has a test under `src/decisions/`.

- **D-01** One adapter for every download program (JDownloader, qBittorrent, Transmission, Deluge, SABnzbd, NZBGet, aria2, pyLoad); a new program joins as one more driver behind the same interface, the core stays.
- **D-02** All download programs run in the same dl-manager instance, each one a device — not one adapter per downloader (D-01); every download is its own channel with typed single datapoints (status, progress, speed …) usable in Blockly, never a JSON list instead of that subtree.
- **D-03** A JDownloader is reached locally or through its My.JDownloader account; the JDownloader dialog switches between the two and asks only the fields of the chosen way; with My.JDownloader the user picks the JDownloader instance of the account from a list.
- **D-04** Every download has a datapoint of its own to remove it (as in the parcelapp adapter); removing takes it at most out of the program's list — the adapter never deletes downloaded files.
- **D-05** What is the same for all downloads is set once for the whole instance — never per download or per program.
- **D-06** Which downloads stand in the object tree is set by a scope (all / without finished / only unfinished; failed ones always stay) and a highest number per program (0–1000, 0 = all, default 100); above it the best ranked stay (running → failed → paused/waiting → queue → seeding → finished, the newest first within a rank); the sums always count everything. At 0 or more than 200 the settings page shows a warning box; when a program actually shows more than 200 downloads in the object tree at runtime, the log warns once per program and start.
- **D-07** Programs are set up as device-manager cards like in the yamaha adapter, not in a table; each dialog shows only the fields of its program; the same program may be added any number of times, only never twice with the same configuration (the same address, or the same My.JDownloader account with the same instance).
- **D-08** The card shows, it controls nothing: no control on the card pauses downloads; pausing goes through the datapoint `paused`, which stays.
- **D-09** The "last" values (last finished, when, last failed, when) stand in a channel `last` of their own below every program and below the summary.
- **D-11** The programs do not live in the object tree but in `programs.json` in the instance's data folder, which every ioBroker backup takes along; password and API key are encrypted with `encrypt()`; neither account nor password appears in the object tree, and so in no object export.
- **K1** A download is the unit the user added: a JDownloader or pyLoad package with many files is one channel, likewise a torrent, an NZB job, an aria2 download.
- **K2** One status list for all programs: every download shows the same status whatever the program (queued, downloading, waiting, paused, checking, postprocessing, seeding, completed, failed) — a Blockly script works the same for every program.
- **K3** An unknown raw status of a program becomes "queued" instead of an error; a debug line names the raw value so it can be added.
- **K4** What a program can do decides its datapoints; a program without a pause of its own (Transmission, aria2, qBittorrent before 5.3) gets one from the adapter: it stops only the downloads that run and later resumes exactly these, also after a restart.
- **K5** After a rejected login the adapter asks the program no more until its card changes; one warning points at the card.

<!-- core-decisions:end -->

## Ein Programm hinzufügen

1. `src/lib/programs/<typ>/` mit `client.ts` (Adresse über `baseUrl`), `map.ts` (Status-Tabelle), `driver.ts`; Zeile in `catalog.ts` (Typ, Name, Familie, Port, Pfad, Anmeldeart), Treiber in `DRIVERS` (`registry.ts`).
2. `driver.test.ts` über `runDriverContract` (`test/helpers/contract.ts`) plus die programmeigenen Fälle.
3. Container-Modul `test/live/programs/<typ>.mjs` + Matrix-Zeile in `.github/workflows/live-programs.yml`; Lauf, dann `test/live/import.mjs` → `test/fixtures/<typ>/<version>/`.
4. Route in `test/fixture-hook.js` + Zeile in `PROGRAM_ROWS` (`test/inventory.js`), Inventar neu erzeugen.
5. Dialog-Hinweis: Schlüssel `hint_<typ>` in `HINT` (`dm-forms.ts`) und Text in allen elf `admin/i18n/*.json` (erzeugt vom lokalen i18n-Quellskript, nie von Hand einzeln); Piktogramm und Dialogfelder folgen dem Katalog.
6. README-Tabelle „Tested with“, `docs/<sprache>/datapoints.md` (Matrix von Hand, gegen `datapoints.ts` und die Fähigkeiten der Treiber — einen Generator gibt es nicht).

## Tests

- **vitest** (`src/**/*.test.ts`): Kern, jeder Treiber gegen den gemeinsamen Vertrag (`test/helpers/contract.ts`) auf
  einem Fixture-Server, My.JDownloader gegen `test/helpers/myjd-server.ts` mit echter Kryptographie; Gerätemanager
  (`device-management.test.ts`) und Dialoge (`dm-forms.test.ts`, Feld-Ausdrücke laufen mit json-configs `return`-Regel,
  `applyDisabledRule` wie im Gerätemanager); `manifest.test.ts` hält `supportedMessages.deviceManager` (ohne ihn kommt
  keine dm-Nachricht an); `i18n.core.test.ts` prüft `tName` gegen das ECHTE adapter-core (`@iobroker/adapter-core/i18n`)
  — `tName` füllt die Platzhalter selbst, weil adapter-core 3.4.3 bei mehreren Werten nur den letzten ins erste `%s` setzt;
  `move.test.ts` hält jeden Umzug fest (Wert mit ts/lc/q, `custom` + `aliasId`, Räume, Aliase, Löschreihenfolge,
  Wiederaufnahme) — die Aufzeichnungs-Prüfung des Inventars sieht eine beim Umzug verlorene Aufzeichnung nicht.
- **Fixtures** `test/fixtures/<typ>/<version>/<zustand>/*.json` — aufgezeichnet von `live-programs.yml` (Container je
  Programm und Version, `test/live/record.mjs`), maskiert und importiert mit `test/live/import.mjs`.
- **Objekt-Inventar** `test/inventory.js` + `test/fixture-hook.js` (ersetzt `fetch` nur im Adapter-Prozess): alle neun
  Programmtypen aus den Aufzeichnungen, Ergebnis `test/objects.inventory.json`; nur über `with-werkstatt-lock.py`.
  Die Zeilen gehen wie bei 0.2.0 in `native.programs` (als ganzes Objekt geschrieben — `changeAdapterConfig` machte aus der
  Liste ein Objekt mit Zahlenschlüsseln), der Start zieht sie in den Speicher; Passwörter im Abzug maskiert, die
  Aufstiegs-Suite gibt dem gesäten Speicher-Objekt des Vorgängers die Fixture-Geheimnisse zurück (`restoreMaskedSecrets`,
  Werkzeug-Runde 67); jede Suite startet ohne den Datenordner der Instanz (`clearInstanceData`, Vorlage seit Runde 71 —
  der Harness leert pro Suite nur die Datenbank, eine liegengebliebene `programs.json` verdeckte die Übernahme); ab einem
  Vorgänger 0.3.2 trägt kein Abzug die Programme mehr — `seedInstanceData` (Runde 75) schreibt dann `programs.json`, wie
  der Vorgänger sie hinterließ (IDs, My.JD-Id `dev1`, Geheimnisse wie eingetippt), sonst richtete der Start die Programme
  über den gesäten Geräten neu ein;
  `MOVES` (berechnet aus dem Vorgänger-Inventar) nennt die Umzüge von 0.3.0, deren Aufzeichnung ankommen muss.
- **Paket-/Standard-Prüfung** `test/package.js`, `test/standards` (`iobroker-adapter-checks`), `test/self-explaining.json`
  (D08), `test/readable-values.json` (Werte-Prüfung).
- Zahlen nie pinnen — `npx vitest run` ist die Wahrheit.
