# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.dl-manager@main/admin/dl-manager.svg" width="48" align="top" /> ioBroker.dl-manager

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.dl-manager)](https://www.npmjs.com/package/iobroker.dl-manager) ![stable](https://iobroker.live/badges/dl-manager-stable.svg) ![Installations](https://iobroker.live/badges/dl-manager-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.dl-manager)](https://www.npmjs.com/package/iobroker.dl-manager)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.dl-manager/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.dl-manager/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

> [!IMPORTANT]
> This adapter cannot be installed from github

Monitors and controls your download programs from ioBroker, all in one instance:

- **Torrent:** [qBittorrent](https://www.qbittorrent.org/), [Transmission](https://transmissionbt.com/), [Deluge](https://deluge-torrent.org/), [rTorrent](https://github.com/rakshasa/rtorrent), [rqbit](https://github.com/ikatson/rqbit), [Flood](https://flood.js.org/), [Tribler](https://tribler.org/), [Vuze](https://www.vuze.com/), [µTorrent](https://www.utorrent.com/), [Hadouken](https://github.com/hadouken/hadouken)
- **Usenet:** [SABnzbd](https://sabnzbd.org/), [NZBGet](https://nzbget.com/), [NZBVortex](https://www.nzbvortex.com/)
- **More:** [JDownloader 2](https://jdownloader.org/), [pyLoad](https://pyload.net/), [aria2](https://aria2.github.io/), [Synology Download Station](https://www.synology.com/dsm/packages/DownloadStation), the downloads of a [Freebox](https://www.free.fr/freebox/)

[🇺🇸 Documentation](./docs/en/README.md) · [🇩🇪 Dokumentation](./docs/de/README.md)

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
- **ioBroker js-controller >= 7.2.5**
- **ioBroker Admin >= 8.3.5**
- At least one of the supported download programs, reachable from the ioBroker host

| Program          | Tested with                                                                                        | Access                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| JDownloader 2    | build 48637 (local API), My.JDownloader                                                            | local API without password, or your My.JDownloader e-mail and password |
| qBittorrent      | 4.6.7, 5.1.4, 5.2.3                                                                                | user and password, or API key (5.2 and later)                          |
| Transmission     | 4.0.6, 4.1.3                                                                                       | user and password (if set in Transmission)                             |
| Deluge           | 2.1.1, 2.2.0                                                                                       | web UI password                                                        |
| SABnzbd          | 4.5.5, 5.1.3                                                                                       | API key                                                                |
| NZBGet           | 24.8, 26.3                                                                                         | control user and password                                              |
| aria2            | 1.37.0                                                                                             | RPC secret                                                             |
| pyLoad-ng        | 0.5.0b3.dev101                                                                                     | API key, or user and password                                          |
| rqbit            | 8.1.1, 9.1.0                                                                                       | user and password, if rqbit asks for one                               |
| rTorrent         | 0.9.8, 0.16.25                                                                                     | the login of the web server in front of it, if it asks for one         |
| Tribler          | 8.0.7, 8.4.2                                                                                       | API key                                                                |
| Flood            | 4.11.0 in front of Transmission; 4.16.4 in front of rTorrent, qBittorrent, Transmission and Deluge | Flood's own user and password, if it asks for one                      |
| Vuze             | 5.7.6.0 with Web Remote 0.6.5                                                                      | user and password of Web Remote                                        |
| µTorrent         | µTorrent Server 3.3 (build 30470)                                                                  | user and password of the Web UI                                        |
| Hadouken         | 5.2.0                                                                                              | user and password                                                      |
| Download Station | answers published by others: DSM 7.2.2 with Download Station 4.1, DSM 6.2 with 3.8                 | DSM user and password                                                  |
| NZBVortex        | answers published by others: its API documentation 1.7 and Sonarr logs                             | API key                                                                |
| Freebox          | answers published by others: Radarr logs and Free's API documentation                              | confirmed once on the Freebox's display                                |

Each version named on its own in this table was started in a container and put into each status it can reach; the
adapter's tests run against those recorded answers. Download Station runs only on Synology hardware, NZBVortex only on
macOS, and the Freebox is a router — for these three the tests run against answers that others recorded from a running
program or that its documentation shows; `test/fixtures/<program>/SOURCES.md` names each source.

---

## Configuration

| Setting                                                        | Meaning                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Programs**                                                   | One card per program. **+** adds one: choose the program, and its dialog asks only for what that program needs — a name, address, port (empty = its default), its login and, under _Advanced_, HTTPS and path                            |
| **Query interval (seconds)**                                   | How often every program is asked (seconds, 10 to 3600, default 10). My.JDownloader is asked at most every 30 seconds                                                                                                                     |
| **Downloads in the object tree**                               | _All_ (default), _Without completed_ or _Only unfinished_ (no completed, no seeding). Failed downloads always stay. The program keeps every download, and the totals count all of them                                                   |
| **At most this many downloads per program in the object tree** | Default 100, 0 = all. Above the limit, running and failed downloads keep their channel first, completed and seeding ones give it up first. More than 200 per program slow ioBroker down — the settings page and the log warn about it    |
| **A new link resumes a paused program**                        | Default off: a link added while its program is paused waits until you resume the program (JDownloader, which starts on its own, is paused again). On: adding the link resumes the program                                                |
| **Also delete the files when removing**                        | Default off: `remove` takes a download off its program's list and the files stay. On: every program also deletes what it loaded for the download. Off, each card of a program that can delete files has the same switch for that program |
| **Delete datapoints with recording**                           | Default on: a datapoint the adapter no longer provides goes even when you record it (history, sql, influxdb). Off: it stays, and the log names how many were kept — check them manually                                                  |
| **Delete the recorded data too**                               | Default off, shown only while the option above is on: each recording instance deletes the datapoint's recorded data first; a datapoint whose data an instance does not delete stays                                                      |

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
**rqbit**, **Tribler**, **µTorrent** and **NZBVortex** need a setting in the program first, **rTorrent** a web server in
front of it — each program's dialog says what to do. **Freebox:** saving its card asks the Freebox for access; confirm it
on the Freebox's display.

---

## State Tree

```
dl-manager.0
├── info                     connection, programsTotal, programsOnline, programsAllOnline
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

Only the datapoints a program really supports are created — pyLoad has no pause per download, SABnzbd and NZBGet no speed per download, only programs that share torrents have upload and ratio.

---

## Troubleshooting

| What you see                                            | What it means                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `online` is false, `error` shows a network text         | The program is not reachable from the ioBroker host — host, port, HTTPS, firewall                                                                                                                 |
| A warning "login rejected" and an ioBroker notification | The program refused the login. The adapter asks it no more (qBittorrent and Transmission lock an address after failed logins) until its card changes; the warning names what to check on the card |
| `error` is `Unknown`                                    | The program has not been asked yet, the adapter is stopped, or its card cannot run — the card says why                                                                                            |
| A download disappears                                   | The program removed it, or the tree settings leave it out — its status is not shown, or the program has more downloads than the limit                                                             |
| pyLoad reports "too many requests"                      | pyLoad allows 100 calls a minute — raise the query interval                                                                                                                                       |

The test button on a program's card asks the program once and shows its answer.

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- New: the switch "Also delete the files when removing" on the settings page and on the card of each program that can delete files, off by default
- Changed: a download has no remove datapoint while its program cannot remove it as the switch says
- Fixed: the debug log no longer shows a password or API key typed into a program's dialog
- Fixed: pausing all no longer stops halfway when a download ended meanwhile (rqbit, rTorrent, Tribler)
- Fixed: when the connection breaks off during pause all or resume all, the downloads already paused are resumed later
- Fixed: a link added during a pause is held on the next poll when its first hold did not reach the program
- Fixed: an rqbit 9 torrent paused during its check no longer ends the pause and shows as paused
- Fixed: with rqbit 8, adding a link whose files are already there during a pause no longer fails; it is paused after its check
- Fixed: Flood shows the infinite ratio of Deluge and qBittorrent instead of none
- Fixed: the log line of pause all names a program that refused apart from one that was not reachable
- Fixed: a script testing a connection gets the error as its answer when the test itself fails

### 0.5.0 (2026-11-19)

- New: rqbit can be added as a program
- New: rTorrent can be added as a program, through the web server in front of it
- New: Tribler can be added as a program
- New: Flood can be added as a program
- New: Vuze can be added as a program, through its Web Remote plugin
- New: µTorrent can be added as a program
- New: Hadouken can be added as a program
- New: Synology Download Station can be added as a program
- New: NZBVortex can be added as a program
- New: the downloads of a Freebox can be added as a program, paired once on the Freebox's display
- New: a setting lets a new link resume a paused program
- New: two settings decide whether a datapoint with a recording is deleted, and whether its recorded data goes too
- New: scripts can test a program's connection
- Fixed: the e-mail address of a My.JDownloader account no longer appears in the device object or an object export
- Fixed: a link added while downloads are paused now resumes together with them
- Fixed: aria2 shows seeding torrents and their ratio correctly
- Fixed: an infinite seed ratio shows ∞ instead of staying empty
- Fixed: size and time left stay empty while the program does not know them
- Fixed: NZBGet and pyLoad show their new version after an update
- Fixed: pyLoad shows a decrypting package as queued
- Fixed: pyLoad's speed limit keeps its value when pyLoad does not tell it, instead of emptying
- Fixed: a small speed, limit or size shows its value instead of 0
- Fixed: a program on an IPv6 address is reachable
- Fixed: the last finished and last failed download are named correctly
- Fixed: a finished SABnzbd job keeps its added time
- Fixed: a pressed button resets once the program took the command
- Fixed: the error shows the program's real problem
- Fixed: a programs.json without a program list stops the start instead of removing every device
- Fixed: the program dialog no longer stores invalid fields
- Fixed: the program dialog no longer overwrites changes made in another tab
- Fixed: an unreachable program keeps its last download values
- Fixed: an unexpected answer from a program no longer deletes its downloads
- Fixed: Deluge no longer stops as if its password were wrong
- Fixed: pause all is confirmed only once a program has paused
- Changed: every datapoint of a download starts with the download's name
- Changed: a busy or unreachable program is asked less often
- Changed: passwords and API keys use the platform's encryption; one that cannot be read stops the start instead of being emptied
- Changed: a start that cannot get going ends the adapter instead of running without function
- Changed: a poll interval that is no number ends the start with a notification in the admin instead of running at 10 s
- Improved: the adapter keeps every program's and My.JDownloader's request limit, also across a restart
- Improved: every datapoint has a short description
- Changed: requires js-controller 7.2.5 and admin 8.3.5

### 0.4.0 (2026-10-02)

- Fixed: saving a card while a second admin tab changed the programs could bring back a deleted card or undo a learned My.JDownloader connection
- Fixed: a switched-off program no longer blocks its address when you add the same program again
- Fixed: an updated JDownloader, qBittorrent or aria2 shows its new version without restarting the adapter
- Fixed: the details of a card open even when the program settings cannot be read
- Fixed: an empty entry in a Transmission or SABnzbd list no longer stops the query
- Fixed: a download added while JDownloader is paused no longer starts all its downloads again
- Changed: a card that cannot run shows what is wrong on the card; its `error` datapoint says `Unknown`
- Changed: a program that is down behind a reverse proxy counts as not reachable
- Changed: a new instance starts switched off until you set it up

### 0.3.2 (2026-09-30)

- Changed: your programs and their access data moved out of the object tree into a file of the instance, which every ioBroker backup includes — an object export no longer shows them

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

[Older changelogs can be found there](CHANGELOG_OLD.md)

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
