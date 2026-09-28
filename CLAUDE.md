# CLAUDE.md — ioBroker.download-manager

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Download Manager** — ein Adapter, eine Instanz, acht Download-Programme (JDownloader 2 lokal und über
My.JDownloader, qBittorrent, Transmission, Deluge, SABnzbd, NZBGet, aria2, pyLoad). Je Programm ein Gerät, je Download ein
Kanal mit Einzel-Datenpunkten, Summen für Blockly.

- **Version:** `io-package.json` ist die Wahrheit; interne Geschichte samt Belegen in `.claude/dev-history.md` (lokal).
- **GitHub:** https://github.com/krobipd/ioBroker.download-manager
- **npm:** https://www.npmjs.com/package/iobroker.download-manager
- **Runtime-Deps:** nur `@iobroker/adapter-core` (fetch, WebSocket, node:crypto aus Node ≥ 22)
- **Plan / Bauplan / Schnittstellen:** `Ressourcen/download-manager/` (`plan-2026-09-28.md`, `bauplan-2026-09-28.md`, `api-*.md`)

## Architektur

```
src/main.ts                      → Lebenszyklus, Konfiguration, Runner je Programm, Summen, onStateChange-Weiche, sendTo
src/lib/core/                    → programmunabhängig: Modell, Einheiten, Kennungen, Baum-Abgleich, Runner, Fehlerklassen
src/lib/programs/registry.ts     → die EINZIGE Programmliste
src/lib/programs/<typ>/          → client (Transport + Anmeldung), map (Rohantwort → Modell), driver (Fähigkeiten + Befehle)
test/fixtures/<typ>/             → aufgezeichnete echte Antworten (live-programs.yml)
```

## Design-Entscheidungen

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen in `.claude/dev-history.md`._

1. **Ein Adapter, eine Instanz, alle Programme** — mehrere Gegenstellen sind Geräte in derselben Instanz.
2. **Jeder Download ist ein eigener Kanal** — keine JSON-Liste, Nutzer bauen mit Blockly.
3. **Ein Download ist die Einheit, die der Nutzer hinzugefügt hat** — JD-/pyLoad-Paket, Torrent, NZB-Auftrag, oberste aria2-GID.
4. **Eine Statusliste für alle Programme** — queued, downloading, waiting, paused, checking, postprocessing, seeding, completed, failed.
5. **Datenpunkte nur, wo das Programm sie liefert** — Fähigkeiten je Treiber entscheiden, keine Platzhalter.
6. **Fertige bleiben, solange das Programm sie führt** — außer die Option `removeFinished` ist an; `seeding` und `failed` bleiben immer.
7. **Nach einem Anmeldefehler wird das Programm nicht mehr gefragt** — bis zur nächsten Konfigurationsänderung (IP-Sperren).
8. **Zugangsdaten verschlüsselt die Tabelle** (`encryptedAttributes`), nicht `encryptedNative`-Punkt-Schlüssel (Prüfbot W1093/W1103).
9. **Dateien löscht der Adapter nie** — `remove` nimmt einen Download nur aus der Liste des Programms.
10. **JDownloader über My.JDownloader ist ein eigener Programmtyp** (`jdownloader-cloud`) mit demselben Treiber und zweitem Transport.

## Tests

vitest (`src/**/*.test.ts`), Paket-Prüfung (mocha), Repo-Standards (`iobroker-adapter-checks`), Objekt-Inventar
(Fixture-Server je Programmtyp) und der Container-Lauf `live-programs.yml`. Zahlen nie pinnen.
