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
src/main.ts                      → Lebenszyklus: Instanzobjekt korrigieren (nur `stopInstance`) → native-/common-Schlüssel
                                   migrieren → I18n → Manifest-Objekte auffrischen → subscribeStates("*") → ProgramManager.start;
                                   onStateChange (ack=false: KnownStates.forget, dann Befehl), Gerätemanager verdrahten,
                                   onUnload → stop().finally(cb)
src/lib/device-management.ts     → DlDeviceManagement (dm-utils): Karten je Zeile, Hinzufügen (Programmwahl → Dialog → bei
                                   My.JDownloader Instanzwahl), Bearbeiten, Löschen, Test, Ein/Aus, Pause-Schalter; `DmHost`
src/lib/dm-forms.ts              → rein: Dialog-Schemas, Zeile ↔ Dialogdaten, Kennung aus dem Namen, Duplikat-Ausdruck
src/lib/core/model.ts            → STATUSES, ACTIVE, ProgramDriver-Vertrag (poll/command/close, subscribe?, test?, minIntervalMs?)
src/lib/core/datapoints.ts       → Fähigkeit → Datenpunkt (Programm- und Download-Ebene), einzige Datenpunkt-Tabelle
src/lib/core/config.ts           → native.programs → ProgramRow {id, enabled, cfg, problem, entry?}, addressOf, programKey /
                                   sameProgram (Duplikat), Abfrage-Intervall 2 s–1 h
src/lib/core/manager.ts          → ProgramManager: Runner je Programm, Summen, Nutzer-Schreibweiche, testProgram (eine Zeile)
src/lib/core/devices.ts          → Geräte gegen die Einstellungen: planHandover/continues (rein), Offline-Stempel,
                                   Zuordnungen tragen (enum-carry)
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
9. **Zugangsdaten liegen in `native.programs` wie eingetippt, geschützt über `protectedNative: ["programs"]`** — `encryptedAttributes` erst, wenn der Admin mit dem json-config-Fix (ioBroker/json-config#179, `||=` → `&&=`) Mindestversion ist; die Umstellung braucht dann eine Migration, die die gespeicherten Werte in json-configs XOR-Form (Systemgeheimnis, nicht AES) verschlüsselt. Nie `encryptedNative`-Punkt-Schlüssel (Prüfbot W1093/W1103).
10. **Dateien löscht der Adapter nie** — `remove` nimmt einen Download nur aus der Liste des Programms.
11. **JDownloader über My.JDownloader ist ein eigener Programmtyp** (`jdownloader-cloud`) mit demselben Treiber und zweitem Transport, höchstens alle 30 s, ohne Push.
12. **Fehlt dem Programm eine Programm-Pause, wird sie nachgebildet** (Transmission, aria2, qBittorrent < 5.3) — nur Laufende anhalten, genau diese fortsetzen, Stand übersteht den Neustart.
13. **Ein ID-Wechsel bei gleichem Typ und gleicher Adresse, oder ein JDownloader, der bei gleicher Kennung zwischen lokal und My.JDownloader wechselt, trägt Raum-/Funktionszuordnungen** — eine gelöschte Zeile nimmt ihr Gerät mit, eine ausgeschaltete behält es offline.
14. **Die Programme richtet der Gerätemanager ein (dm-utils, Karten wie yamaha)** — je Programm ein Dialog nur mit dessen Feldern aus `catalog.ts`; Speicherformat bleibt `native.programs`, jede Änderung startet die Instanz neu; Radio-Beschriftungen sind einfache Zeichenketten (`tText`), weil json-configs Radio-Zweig `label` roh rendert.
15. **Beliebig viele Einträge je Programm, doppelt ist dasselbe Programm** — gleiche Adresse (Host, tatsächlicher Port und Pfad, ohne Schema) oder gleiches My.JDownloader-Konto samt Instanz; der Dialog weist es ab, der Adapter fragt die zweite Zeile nicht (`same program as <id>`).
16. **Die Kennung wird beim Hinzufügen einmal festgelegt und gespeichert** — aus dem Namen, eindeutig mit `-2`…; beim Bearbeiten bleibt sie.
17. **Ein Wertespeicher (`KnownStates`)** — jeder Zustand im Speicher verglichen; ein fremder Schreibvorgang (ack:false) und ein gelöschtes Objekt lassen ihn vergessen; abonniert wird vor dem Start.
18. **Eine Karte warnt nur bei einem echten Fehler** — `Unknown` und leer zeichnen kein Warndreieck (dm-gui zeigt jeden Text).
19. **Ein Gerätemanager-Dialog sperrt OK über `applyDisabledRule` aus allen Feldprüfungen (`applyRuleOf`)** — `validatorNoSaveOnError` und `validatorErrorText` wirken dort nicht; eine belegte Adresse erklärt ein Warnkasten im Dialog; kein Feld-Ausdruck enthält das Wort `return` (json-config läuft ihn sonst ohne eigenes `return`), eingebettete Werte gehen durch `literal()`.

## Ein Programm hinzufügen

1. `src/lib/programs/<typ>/` mit `client.ts` (Adresse über `baseUrl`), `map.ts` (Status-Tabelle), `driver.ts`; Zeile in `catalog.ts` (Typ, Name, Familie, Port, Pfad, Anmeldeart), Treiber in `DRIVERS` (`registry.ts`).
2. `driver.test.ts` über `runDriverContract` (`test/helpers/contract.ts`) plus die programmeigenen Fälle.
3. Container-Modul `test/live/programs/<typ>.mjs` + Matrix-Zeile in `.github/workflows/live-programs.yml`; Lauf, dann `test/live/import.mjs` → `test/fixtures/<typ>/<version>/`.
4. Route in `test/fixture-hook.js` + Zeile in `PROGRAM_ROWS` (`test/inventory.js`), Inventar neu erzeugen.
5. Dialog-Hinweis: Schlüssel `hint_<typ>` in `HINT` (`dm-forms.ts`) und Text in `Ressourcen/dl-manager/i18n_src.py` (erzeugt `admin/i18n/*`); Piktogramm und Dialogfelder folgen dem Katalog.
6. README-Tabelle „Tested with“, `docs/<sprache>/datapoints.md` (Matrix aus dem gebauten Code erzeugen, nicht von Hand).

## Tests

- **vitest** (`src/**/*.test.ts`): Kern, jeder Treiber gegen den gemeinsamen Vertrag (`test/helpers/contract.ts`) auf
  einem Fixture-Server, My.JDownloader gegen `test/helpers/myjd-server.ts` mit echter Kryptographie; Gerätemanager
  (`device-management.test.ts`) und Dialoge (`dm-forms.test.ts`, Feld-Ausdrücke laufen mit json-configs `return`-Regel,
  `applyDisabledRule` wie im Gerätemanager); `manifest.test.ts` hält `supportedMessages.deviceManager` (ohne ihn kommt
  keine dm-Nachricht an); `i18n.core.test.ts` prüft `tName` gegen das ECHTE adapter-core (`@iobroker/adapter-core/i18n`)
  — `tName` füllt die Platzhalter selbst, weil adapter-core 3.4.3 bei mehreren Werten nur den letzten ins erste `%s` setzt.
- **Fixtures** `test/fixtures/<typ>/<version>/<zustand>/*.json` — aufgezeichnet von `live-programs.yml` (Container je
  Programm und Version, `test/live/record.mjs`), maskiert und importiert mit `test/live/import.mjs`.
- **Objekt-Inventar** `test/inventory.js` + `test/fixture-hook.js` (ersetzt `fetch` nur im Adapter-Prozess): alle neun
  Programmtypen aus den Aufzeichnungen, Ergebnis `test/objects.inventory.json`; nur über `with-werkstatt-lock.py`.
- **Paket-/Standard-Prüfung** `test/package.js`, `test/standards` (`iobroker-adapter-checks`), `test/self-explaining.json`
  (D08), `test/readable-values.json` (Werte-Prüfung).
- Zahlen nie pinnen — `npx vitest run` ist die Wahrheit.
