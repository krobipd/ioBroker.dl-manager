# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.dl-manager@main/admin/dl-manager.svg" width="48" align="top" /> ioBroker.dl-manager

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.dl-manager)](https://www.npmjs.com/package/iobroker.dl-manager) ![stable](https://iobroker.live/badges/dl-manager-stable.svg) ![Installations](https://iobroker.live/badges/dl-manager-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.dl-manager)](https://www.npmjs.com/package/iobroker.dl-manager)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.dl-manager/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.dl-manager/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Monitors and controls your download programs from ioBroker — [JDownloader 2](https://jdownloader.org/), [qBittorrent](https://www.qbittorrent.org/), [Transmission](https://transmissionbt.com/), [Deluge](https://deluge-torrent.org/), [SABnzbd](https://sabnzbd.org/), [NZBGet](https://nzbget.com/), [aria2](https://aria2.github.io/) and [pyLoad](https://pyload.net/) — in one instance.

---

## Features

- Every configured program is a device with its speed, limits, free space, pause switch and an input to add a download
- Every download is a channel of its own with status, progress, size, speed and time left — ready for Blockly without parsing anything
- One status list for all programs: queued, downloading, waiting, paused, checking, post-processing, seeding, completed, failed
- A summary over all programs: any download active, total speed, pause all, last finished and last failed download
- Several programs of the same kind side by side (for example two qBittorrent servers)

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting is active by default. It stays off when the ioBroker diagnostics setting is `none` (`diag` in the system configuration), when data reporting is disabled for this instance or its host (`disableDataReporting`), and on CI systems. A report contains the error with its stack trace and technical context such as versions and platform, plus an anonymous installation ID.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

---

## Requirements

- **Node.js >= 22**
- **ioBroker js-controller >= 7.2.2**
- **ioBroker Admin >= 8.0.14**
- At least one of the supported download programs, reachable from the ioBroker host

| Program       | Tested with                             | Access                                                                 |
| ------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| JDownloader 2 | build 48637 (local API), My.JDownloader | local API without password, or your My.JDownloader e-mail and password |
| qBittorrent   | 4.6.7, 5.1.4, 5.2.3                     | user and password, or API key (5.2 and later)                          |
| Transmission  | 4.0.6, 4.1.3                            | user and password (if set in Transmission)                             |
| Deluge        | 2.1.1, 2.2.0                            | web UI password                                                        |
| SABnzbd       | 4.5.5, 5.1.3                            | API key                                                                |
| NZBGet        | 24.8, 26.3                              | control user and password                                              |
| aria2         | 1.37.0                                  | RPC secret                                                             |
| pyLoad-ng     | 0.5.0b3.dev101                          | API key, or user and password                                          |

Every version in this table was started in a container and put into each status it can reach; the adapter's tests run
against those recorded answers.

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

---

## Configuration

| Setting                                     | Meaning                                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Programs**                                | One card per program. **+** adds one: choose the program, and its dialog asks only for what that program needs — a name, address, port (empty = its default), its login and, under _Advanced_, HTTPS and path                         |
| **Query interval**                          | How often every program is asked (seconds, 10 to 3600, default 10). My.JDownloader is asked at most every 30 seconds                                                                                                                  |
| **Downloads in the object tree**            | _All_ (default), _Without completed_ or _Only unfinished_ (no completed, no seeding). Failed downloads always stay. The program keeps every download, and the totals count all of them                                                |
| **At most this many downloads per program** | Default 100, 0 = all. Above the limit, running and failed downloads keep their channel first, completed and seeding ones give it up first. More than 200 per program slow ioBroker down — the settings page and the log warn about it |

Every program can be added as often as you like — two qBittorrent servers, a local JDownloader and one at a friend's.
A second entry for the same program (the same address, or the same JDownloader of a My.JDownloader account) is refused.
Each card shows whether the program answers, its speed and running downloads, and has an on/off switch, a connection
test, edit and delete; its details show the object ID. A change on a card applies at once — the instance does not
restart. Passwords and API keys are stored encrypted.

The name is only a label. The object ID is given by the adapter once, when the program is added: the program and the
machine it runs on (`qbittorrent-nas`, `transmission-192-168-1-20`, `aria2-<ioBroker host>` for `localhost`), for
My.JDownloader the last four characters of the account's id for that JDownloader (`jdownloader-7f11`). A second
program on the same machine gets its port, then a counter. Renaming, a new address or switching a JDownloader between
local and My.JDownloader keeps the ID.

**JDownloader:** the dialog switches between _Local network_ and _Through My.JDownloader_. The local API (JDownloader →
Settings → Advanced settings → `DeprecatedApi`) has no password — use it only when JDownloader runs on the ioBroker host
or in the same Docker network. Through My.JDownloader you log in with your account and pick the JDownloader from a list.

**SABnzbd** refuses host names it does not know — enter an IP address or add the name to `host_whitelist` in SABnzbd.
**Transmission** answers only addresses in its `rpc-whitelist` — add the ioBroker host or switch the whitelist off.

---

## State Tree

```
dl-manager.0
├── info                     connection, programsTotal, programsOnline, programsAllOnline
├── programs                 the program settings (the adapter's own store, not a datapoint)
├── summary                  downloading, active, queued, downloadSpeed, uploadSpeed, pauseAll
│   └── last                 finished, finishedTime, failed, failedTime
└── <program>-<piece>        e.g. qbittorrent-nas
    ├── online, error, version, downloading, paused, downloadSpeed, uploadSpeed,
    │   speedLimit, uploadLimit, altSpeed, freeSpace, active, queued, total, add
    ├── last                 finished, finishedTime, failed, failedTime
    └── downloads
        └── <download>       status, progress, size, downloaded, speed, uploadSpeed, ratio, eta,
                             added, finished, category, error, paused, remove (+ program extras)
```

Only the datapoints a program really supports are created — pyLoad has no pause per download, SABnzbd and NZBGet no speed per download, only the torrent programs have upload and ratio.

---

## Troubleshooting

| What you see                                            | What it means                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `online` is false, `error` shows a network text         | The program is not reachable from the ioBroker host — host, port, HTTPS, firewall                                                                                                                 |
| A warning "login rejected" and an ioBroker notification | The program refused the login. The adapter asks it no more (qBittorrent and Transmission lock an address after failed logins) until its card changes; the warning names what to check on the card |
| `error` is `Unknown`                                    | The program has not been asked yet, or the adapter is stopped                                                                                                                                     |
| A download disappears                                   | The program removed it, or the tree settings leave it out — its status is not shown, or the program has more downloads than the limit                                                             |
| pyLoad reports "too many requests"                      | pyLoad allows 100 calls a minute — raise the query interval                                                                                                                                       |

The test button on a program's card asks the program once and shows its answer.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.3.1 (2026-09-30)

- Changed: after adding, editing, switching or deleting a program on its card you now see at once whether it worked — the program answers, is not reachable, or is gone
- Fixed: the warning for a rejected login names what to check on the card and says so when the card holds no login at all, as with Transmission's login switch
- Changed: the query interval now starts at 10 seconds; a smaller value stored before keeps working and simply runs at 10 seconds from now on
- Fixed: when several programs answered at the same moment, the totals could briefly show an older speed or count

### 0.3.0 (2026-09-29)

- Fixed: saving a program card no longer hangs, and the settings page can no longer undo a change made on a card
- Changed: a change on a card applies at once without restarting the adapter; passwords are no longer kept in plain text
- Changed: device IDs follow the program and machine (My.JDownloader: its id) and never change; the name is a label
- Changed: the last finished and failed download moved into a `last` channel below each program and the summary
- Changed: the card shows the object ID in its details and has no pause switch; the `paused` datapoint stays
- Fixed: a JDownloader renamed in its own settings keeps its My.JDownloader connection

### 0.2.0 (2026-09-29)

- New: programs are set up as cards — a dialog with only the program's fields, and test, pause and on/off on every card
- New: for My.JDownloader you pick the JDownloader from a list of your account after logging in
- New: a second entry for the same program (same address, or same My.JDownloader device) is refused
- Changed: switching a JDownloader between local and My.JDownloader keeps its rooms and functions
- Fixed: a download that showed up again could show empty values until something about it changed

### 0.1.0 (2026-09-29)

- New: first release — JDownloader 2, qBittorrent, Transmission, Deluge, SABnzbd, NZBGet, aria2 and pyLoad in one instance, with one channel per download

### 0.0.1 (2026-09-29)

- Changed: placeholder on npm that reserves the package name — install the first release instead

[Older changelogs can be found there](CHANGELOG_OLD.md)

---

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.dl-manager/issues)

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

## License

MIT License

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

_Developed with assistance from Claude.ai_
