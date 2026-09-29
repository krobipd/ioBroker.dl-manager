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
- **Plan / Bauplan / Schnittstellen:** `Ressourcen/dl-manager/` (`plan-2026-09-28.md`, `bauplan-2026-09-28.md`, `api-*.md`)

## Architektur

```
src/main.ts                      → Lebenszyklus: Instanzobjekt korrigieren (nur `stopInstance`) → I18n → Programme aus
                                   `native.programs` in den Speicher (einmal) → native-/common-Schlüssel migrieren → Manifest-
                                   Objekte auffrischen → settleDevices (Umzug fortsetzen, IDs vergeben, last-Umzug) →
                                   subscribeStates("*") → ProgramManager.start; saveRows (Speicher + apply, eine Warteschlange),
                                   learnDeviceId (My.JD-Id), onStateChange, onUnload → stop().finally(cb)
src/lib/device-management.ts     → DlDeviceManagement (dm-utils): Karten je Zeile, Details (Objekt-ID), Hinzufügen
                                   (Programmwahl → Dialog → bei My.JDownloader Instanzwahl), Bearbeiten, Löschen, Test, Ein/Aus;
                                   jede Änderung über `DmHost.saveRows`, kein Neustart
src/lib/dm-forms.ts              → rein: Dialog-Schemas, Zeile ↔ Dialogdaten, Duplikat-Ausdruck
src/lib/core/store.ts            → ProgramStore: `<ns>.programs` (meta.folder, `native.rows`), Passwort/API-Schlüssel mit
                                   `encrypt()`, unveränderter Klartext behält seinen Chiffretext, kein leerer Speicher
src/lib/core/device-id.ts        → Geräte-ID `<programm>-<stück>` (deviceIdFor, hostPiece, settleIds), ID_SCHEME = 3, RESERVED_IDS
src/lib/core/move.ts             → moveObjects: Objekte + native, Werte mit ack/ts/lc/q, custom + aliasId, Aliase, EIN
                                   moveAllWithEnums, Kinder zuerst gelöscht, Journal `native.movingTo`, Marke idScheme
src/lib/core/model.ts            → STATUSES, ACTIVE, ProgramDriver-Vertrag (poll/command/close, subscribe?, test?, minIntervalMs?)
src/lib/core/datapoints.ts       → Fähigkeit → Datenpunkt (Programm- und Download-Ebene), einzige Datenpunkt-Tabelle
src/lib/core/config.ts           → Zeilen → ProgramRow {id, scheme, enabled, cfg, problem, entry?}, legacyId (ID bis 0.2.0),
                                   addressOf, programKey / sameProgram (Duplikat), Abfrage-Intervall 2 s–1 h
src/lib/core/manager.ts          → ProgramManager: Runner je Programm, apply (Zeilen live: neu/weg/geändert/umgezogen),
                                   Summen, Nutzer-Schreibweiche, testProgram (eine Zeile)
src/lib/core/devices.ts          → readDevices (nur Geräte mit Programmtyp, keine reservierte Wurzel), Offline-Stempel
src/lib/core/visibility.ts       → rein: welche Downloads einen Kanal bekommen (treeScope, Rang, Obergrenze)
src/lib/core/runner.ts           → Abfrage-Schleife je Programm, Anmelde-Sperre, pollNow nach jedem Befehl
src/lib/core/tree.ts             → ProgramTree: Gerät/Kanäle/Datenpunkte gegen den Schnappschuss abgleichen, itemKey
src/lib/core/objects.ts          → KnownObjects: eigener Baum einmal gelesen, Objekte nur bei Unterschied schreiben (coveredBy)
src/lib/core/states.ts           → KnownStates: EIN Wertespeicher, jeder Zustand im Speicher verglichen; forget (fremder
                                   Schreibvorgang), remove (gelöschtes Objekt)
src/lib/core/summary.ts          → info.* und summary.* aus allen Programmen
src/lib/core/commands.ts         → routeState: Datenpunkt-Id → pauseAll / Befehl an Programm / ignorieren
src/lib/core/http.ts             → HttpClient: Timeout über Adapter-Timer, Cookies, keine Weiterleitungen, multipart
src/lib/core/emulated-pause.ts   → nachgebildete Programm-Pause (PauseStore im native des paused-Objekts)
src/lib/core/{errors,ids,units,redact}.ts → Fehlerklassen, Kennungen, Einheiten + Lesehelfer der Antworten, Geheimnisse
src/lib/programs/catalog.ts      → die EINZIGE Programmliste: Typ, Name, Familie, Standard-Port/-Pfad, Anmeldeart → needsOf,
                                   baseUrl; liest der Kern, jeder Client, die Duplikatprüfung und die Dialoge
src/lib/programs/registry.ts     → Katalog + Treiber (DRIVERS) → PROGRAMS, findProgram
src/lib/programs/<typ>/          → client.ts (Transport + Anmeldung), map.ts (Rohantwort → Modell, Status-Tabelle),
                                   driver.ts (Fähigkeiten, Extras, Befehle)
src/lib/enum-carry.ts            → Kopie aus .consistency-master (byte-gleich halten)
src/lib/{actionable-problems,device-icons,i18n,native-key-migration,err-text}.ts → Flotten-Muster
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
12. **Fehlt dem Programm eine Programm-Pause, wird sie nachgebildet** (Transmission, aria2, qBittorrent < 5.3) — nur Laufende anhalten, genau diese fortsetzen, Stand übersteht den Neustart.
13. **Ein Gerät zieht nur über `move.ts` um (Werte, Aufzeichnung mit `aliasId`, Räume/Funktionen, Aliase, Kinder zuerst gelöscht, Journal an der alten Wurzel)** — eine gelöschte Zeile nimmt ihr Gerät mit, eine ausgeschaltete behält es offline.
14. **Die Programme richtet der Gerätemanager ein (dm-utils, Karten wie yamaha) und sie liegen im eigenen Objekt `<ns>.programs`, nie im Instanzobjekt** — jede Kartenänderung wird gespeichert und live übernommen (`ProgramManager.apply`), die Instanz startet nicht neu und die Einstellungsseite kann keine Programmliste zurückschreiben; je Programm ein Dialog nur mit dessen Feldern aus `catalog.ts`; Radio-Beschriftungen sind einfache Zeichenketten (`tText`), weil json-configs Radio-Zweig `label` roh rendert.
15. **Beliebig viele Einträge je Programm, doppelt ist dasselbe Programm** — gleiche Adresse (Host, tatsächlicher Port und Pfad, ohne Schema) oder gleiches My.JDownloader-Konto samt Instanz; der Dialog weist es ab, der Adapter fragt die zweite Zeile nicht (`same program as <id>`).
16. **Die Geräte-ID vergibt der Adapter einmal beim Hinzufügen nach dem Schema yamaha/govee/homeconnect: `<programm>-<stück>` ohne Zugangsweg** — My.JDownloader die letzten 4 Zeichen der Konto-Id (belegt → ganze Id → Zähler), lokal der Rechner aus der Adresse (belegt → Port → Zähler, `localhost` = ioBroker-Host); gespeichert in der Zeile, nie neu berechnet, Marke `native.idScheme = 3`; der Name ist nur Anzeigename, ein ID-Feld gibt es nicht; die Karte zeigt die ID in den Details.
17. **Ein Wertespeicher (`KnownStates`)** — jeder Zustand im Speicher verglichen; ein fremder Schreibvorgang (ack:false) und ein gelöschtes Objekt lassen ihn vergessen; abonniert wird vor dem Start.
18. **Eine Karte warnt nur bei einem echten Fehler** — `Unknown` und leer zeichnen kein Warndreieck (dm-gui zeigt jeden Text).
19. **Ein Gerätemanager-Dialog sperrt OK über `applyDisabledRule` aus allen Feldprüfungen (`applyRuleOf`)** — `validatorNoSaveOnError` und `validatorErrorText` wirken dort nicht; eine belegte Adresse erklärt ein Warnkasten im Dialog; kein Feld-Ausdruck enthält das Wort `return` (json-config läuft ihn sonst ohne eigenes `return`), eingebettete Werte gehen durch `literal()`.
20. **Eine Karte zeigt, sie steuert nichts** — kein `controls`-Schalter (krobi: die Admin braucht keine Steuerung); der Datenpunkt `paused` bleibt.
21. **Die vier „zuletzt“-Werte stehen im Kanal `last`** (`last.finished`, `last.finishedTime`, `last.failed`, `last.failedTime`) unter jedem Programm und unter `summary`; bis 0.2.0 flach, der Start zieht sie einmal um.
22. **My.JDownloader wird über die gespeicherte Konto-Id verbunden, der Name ist nur Rückfall für eine Zeile ohne Id** — eine Zeile aus 0.2.0 behält ihre alte ID (`idPending`), bis die erste Verbindung die Id nennt, dann zieht das Gerät live um.

## Ein Programm hinzufügen

1. `src/lib/programs/<typ>/` mit `client.ts` (Adresse über `baseUrl`), `map.ts` (Status-Tabelle), `driver.ts`; Zeile in `catalog.ts` (Typ, Name, Familie, Port, Pfad, Anmeldeart), Treiber in `DRIVERS` (`registry.ts`).
2. `driver.test.ts` über `runDriverContract` (`test/helpers/contract.ts`) plus die programmeigenen Fälle.
3. Container-Modul `test/live/programs/<typ>.mjs` + Matrix-Zeile in `.github/workflows/live-programs.yml`; Lauf, dann `test/live/import.mjs` → `test/fixtures/<typ>/<version>/`.
4. Route in `test/fixture-hook.js` + Zeile in `PROGRAM_ROWS` (`test/inventory.js`), Inventar neu erzeugen.
5. Dialog-Hinweis: Schlüssel `hint_<typ>` in `HINT` (`dm-forms.ts`) und Text in `Ressourcen/dl-manager/i18n_src.py` (erzeugt `admin/i18n/*`); Piktogramm und Dialogfelder folgen dem Katalog.
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
  Aufstiegs-Suite sät den Speicher des Vorgängers mit den Fixture-Geheimnissen zurück (`unmasked`).
- **Paket-/Standard-Prüfung** `test/package.js`, `test/standards` (`iobroker-adapter-checks`), `test/self-explaining.json`
  (D08), `test/readable-values.json` (Werte-Prüfung).
- Zahlen nie pinnen — `npx vitest run` ist die Wahrheit.
