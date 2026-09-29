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

| Program       | Tested with                             | Access                                                                         |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| JDownloader 2 | build 48637 (local API), My.JDownloader | local API without password, or My.JDownloader e-mail, password and device name |
| qBittorrent   | 4.6.7, 5.1.4, 5.2.3                     | user and password, or API key (5.2 and later)                                  |
| Transmission  | 4.0.6, 4.1.3                            | user and password (if set in Transmission)                                     |
| Deluge        | 2.1.1, 2.2.0                            | web UI password                                                                |
| SABnzbd       | 4.5.5, 5.1.3                            | API key                                                                        |
| NZBGet        | 24.8, 26.3                              | control user and password                                                      |
| aria2         | 1.37.0                                  | RPC secret                                                                     |
| pyLoad-ng     | 0.5.0b3.dev101                          | API key, or user and password                                                  |

Every version in this table was started in a container and put into each status it can reach; the adapter's tests run
against those recorded answers.

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

---

## Configuration

| Setting                                     | Meaning                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Programs**                                | One line per program: program, ID (becomes part of the object path, e.g. `qbittorrent-nas`), name, host, port (empty = the program's default), HTTPS, path (only behind a reverse proxy), user, password, API key and — for My.JDownloader — the device name |
| **Query interval**                          | How often every program is asked (seconds, default 10). My.JDownloader is asked at most every 30 seconds, pyLoad at most every 5 seconds                                                                                                                     |
| **Remove finished downloads from ioBroker** | Completed downloads disappear from the object tree; the program keeps them. Seeding and failed downloads stay                                                                                                                                                |

**JDownloader:** the local API (JDownloader → Settings → Advanced settings → `DeprecatedApi`) has no password. Use it only when JDownloader runs on the ioBroker host or in the same Docker network; otherwise choose _JDownloader 2 (My.JDownloader)_ and log in with your My.JDownloader account.

**API key column:** SABnzbd API key, pyLoad API key, aria2 RPC secret, qBittorrent API key (instead of user and password, 5.2 and later).

**SABnzbd** refuses host names it does not know — enter an IP address or add the name to `host_whitelist` in SABnzbd.
**Transmission** answers only addresses in its `rpc-whitelist` — add the ioBroker host or switch the whitelist off.

---

## State Tree

```
dl-manager.0
├── info                     connection, programsTotal, programsOnline, programsAllOnline
├── summary                  downloading, active, queued, downloadSpeed, uploadSpeed, pauseAll,
│                            lastFinished, lastFinishedTime, lastFailed, lastFailedTime
└── <program>-<id>           e.g. qbittorrent-nas
    ├── online, error, version, downloading, paused, downloadSpeed, uploadSpeed,
    │   speedLimit, uploadLimit, altSpeed, freeSpace, active, queued, total, add,
    │   lastFinished, lastFinishedTime, lastFailed, lastFailedTime
    └── downloads
        └── <download>       status, progress, size, downloaded, speed, uploadSpeed, ratio, eta,
                             added, finished, category, error, paused, remove (+ program extras)
```

Only the datapoints a program really supports are created — pyLoad has no pause per download, SABnzbd and NZBGet no speed per download, only the torrent programs have upload and ratio.

---

## Troubleshooting

| What you see                                            | What it means                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `online` is false, `error` shows a network text         | The program is not reachable from the ioBroker host — host, port, HTTPS, firewall                                                                       |
| A warning "login rejected" and an ioBroker notification | The program refused the login. The adapter asks it no more (qBittorrent and Transmission lock an address after failed logins) until the settings change |
| `error` is `Unknown`                                    | The program has not been asked yet, or the adapter is stopped                                                                                           |
| A download disappears                                   | The program removed it, or it finished while _Remove finished downloads from ioBroker_ is on                                                            |
| pyLoad reports "too many requests"                      | pyLoad allows 100 calls a minute — raise the query interval                                                                                             |

The _Test connections_ button on the settings page asks every program of the (unsaved) table once and shows the answer.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- New: first release — JDownloader 2, qBittorrent, Transmission, Deluge, SABnzbd, NZBGet, aria2 and pyLoad in one instance, with one channel per download

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
