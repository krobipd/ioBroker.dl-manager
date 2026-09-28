# FAQ

## A program stays `online` = false

`error` on the program's device says why. A network text (refused, timeout, no route) means the ioBroker host cannot
reach the program: check host, port, the HTTPS switch and a firewall between the two. Press **Test connections** on
the settings page to try the table before you save it. Some programs refuse callers they do not know:

- **SABnzbd** answers only host names on its `host_whitelist` — enter the IP address, or add the name there.
- **Transmission** answers only addresses on its `rpc-whitelist` — add the ioBroker host, or switch the whitelist off.
- **JDownloader (local API)** answers only the same computer unless `DeprecatedApiLocalhostOnly` is off.

## "Login rejected" — and the program is not asked any more

When a program refuses the login, the adapter writes a warning, shows an ioBroker notification and stops asking that
program. qBittorrent and Transmission lock an address after several failed logins; asking again every few seconds
would lock the ioBroker host out. Correct the access data in the settings — saving restarts the instance, and the
program is asked again.

## Should I use the JDownloader local API or My.JDownloader?

The local API has no password: anyone who reaches its port can change JDownloader's settings or shut it down. Use it
only when JDownloader runs on the ioBroker host or in the same Docker network. In every other case choose
_JDownloader 2 (My.JDownloader)_ and enter your My.JDownloader e-mail, password and the device name. My.JDownloader is
asked at most every 30 seconds, whatever the query interval says.

## How often are the programs asked?

Every program is asked every _Query interval_ seconds (default 10, from 2 seconds to 1 hour). A change you write — a
pause, a limit, a new link — is sent right away, and the program is asked again right after. aria2 also reports
changes on its own as they happen.

## Does `remove` delete my files?

No. `remove` takes the download off the program's list; the files stay on disk. The adapter never deletes files.

## A finished download stays in the object tree

It stays as long as the program lists it. Switch on _Remove finished downloads from ioBroker_ if you want only the
running ones: completed downloads then disappear from the object tree, the program keeps them. Seeding and failed
downloads always stay — a seeding torrent still transfers, a failed download needs you.

## I want a message when a download is done

Trigger on `summary.lastFinished` (or on the program's own `lastFinished`) with **was updated**, not with **was
changed**: two downloads with the same name finish with the same value, and a "changed" trigger would miss the
second one. `summary.lastFinishedTime` holds the time. `summary.lastFailed` works the same way for failed downloads.

## `paused` on Transmission, aria2 or an older qBittorrent

These programs have no pause for the whole program. The adapter stops the downloads that are running, remembers exactly
those and starts exactly those again when you set `paused` back to false. A download you paused yourself stays paused.
If you start one of the stopped downloads in the program itself, the adapter's pause ends.

## Why is there no `speed` on SABnzbd or NZBGet downloads?

Both programs load one job after the other and report speed and time left only for the whole program. You find them
in the program's `downloadSpeed`; the adapter does not invent a value per download.

## Two servers with the same program

Add one line per server with its own ID — `qbittorrent-nas` and `qbittorrent-seedbox` are two devices side by side.

## I changed a program's ID

When a line keeps its program and address but gets a new ID, the adapter moves the room and function assignments of
the device and its datapoints to the new device and removes the old one; the downloads come back with the next query.
A line you delete takes its device with it. A line you switch off keeps its device, shown as offline.

## pyLoad reports "too many requests"

pyLoad allows 100 calls a minute. Raise the query interval, or reduce other tools that ask the same pyLoad.
