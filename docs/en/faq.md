# FAQ

## A program stays `online` = false

`error` on the program's device says why. A network text (refused, timeout, no route) means the ioBroker host cannot
reach the program: check host, port, the HTTPS switch and a firewall between the two. The test button on the
program's card asks it once and shows its answer. Some programs refuse callers they do not know:

- **SABnzbd** answers only host names on its `host_whitelist` — enter the IP address, or add the name there.
- **Transmission** answers only addresses on its `rpc-whitelist` — add the ioBroker host, or switch the whitelist off.
- **JDownloader (local API)** answers only the same computer unless `DeprecatedApiLocalhostOnly` is off.

## "Login rejected" — and the program is not asked any more

When a program refuses the login, the adapter writes a warning, shows an ioBroker notification and stops asking that
program. qBittorrent and Transmission lock an address after several failed logins; asking again every few seconds
would lock the ioBroker host out. The warning says what to check on the card — and when the card holds no login at
all, it says so: Transmission, for example, needs _The program asks for a login_ switched on in its dialog. Correct
the access data on the program's card — the change applies at once, the program is asked again, and the log shows its
answer.

## Should I use the JDownloader local API or My.JDownloader?

The local API has no password: anyone who reaches its port can change JDownloader's settings or shut it down. Use it
only when JDownloader runs on the ioBroker host or in the same Docker network. In every other case choose
_Through My.JDownloader_ in the JDownloader dialog, log in and pick your JDownloader from the list. My.JDownloader is
asked at most every 30 seconds, whatever the query interval says. Switching an existing JDownloader between the two keeps
its rooms and functions.

## How often are the programs asked?

Every program is asked every _Query interval_ seconds (default 10, from 10 seconds to 1 hour). A change you write — a
pause, a limit, a new link — is sent right away, and the program is asked again right after. aria2 also reports
changes on its own as they happen.

## Does `remove` delete my files?

No. `remove` takes the download off the program's list; the files stay on disk. The adapter never deletes files.

## A finished download stays in the object tree

It stays as long as the program lists it and the tree settings show it. Set _Downloads in the object tree_ to
_Without completed_ to leave completed downloads out, or to _Only unfinished_ to leave seeding torrents out as well.
Failed downloads always stay — they need you. The program keeps every download either way.

## A download is missing from the object tree

Either its status is not shown (_Downloads in the object tree_), or the program has more downloads than _At most this
many downloads per program_ allows: then the running, failed, paused and queued ones keep their channel before seeding
and completed ones. Raise the limit or set it to 0 for all — above 200 per program the object tree gets slow.

## I want a message when a download is done

Trigger on `summary.last.finished` (or on the program's own `last.finished`) with **was updated**, not with **was
changed**: two downloads with the same name finish with the same value, and a "changed" trigger would miss the
second one. `summary.last.finishedTime` holds the time. `summary.last.failed` works the same way for failed downloads.

## `paused` on Transmission, aria2 or an older qBittorrent

These programs have no pause for the whole program. The adapter stops the downloads that are running, remembers exactly
those and starts exactly those again when you set `paused` back to false. A download you paused yourself stays paused.
If you start one of the stopped downloads in the program itself, the adapter's pause ends.

## Why is there no `speed` on SABnzbd or NZBGet downloads?

Both programs load one job after the other and report speed and time left only for the whole program. You find them
in the program's `downloadSpeed`; the adapter does not invent a value per download.

## Two servers with the same program

Add one card per server — each gets the machine it runs on as its ID: `qbittorrent-nas` and `qbittorrent-seedbox`
are two devices side by side. Two of the same program on one machine differ by their port (`qbittorrent-nas-8081`).

## Can I choose a program's ID?

No — the adapter gives it once, when the program is added, and it never changes: a new name, a new address or a
switch between local and My.JDownloader keep the device where it is, with its rooms, functions and scripts. The card's
details show the ID. A card you delete takes its device with it. A card you switch off keeps its device, shown as
offline.

## pyLoad reports "too many requests"

pyLoad allows 100 calls a minute; the adapter needs four to six calls per query and asks at most every 10 seconds.
If the message still appears, other tools ask the same pyLoad as well — raise the query interval or ask less there.
