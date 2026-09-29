# ioBroker.dl-manager — user documentation

The adapter connects ioBroker to your download programs. Each program you add becomes a device, each of its
downloads a channel with its own datapoints. Everything the adapter shows comes from the program itself; the adapter
never downloads anything on its own and never deletes files.

## Supported programs

| Program                        | Access                   | What you need                                                                                                                                                      |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JDownloader 2 (local)          | local API, port 3128     | In JDownloader: Settings → Advanced settings → `DeprecatedApiEnabled` on; if ioBroker runs on another computer or container, also `DeprecatedApiLocalhostOnly` off |
| JDownloader 2 (My.JDownloader) | the My.JDownloader cloud | your My.JDownloader e-mail and password — the JDownloader is picked from your account                                                                              |
| qBittorrent                    | Web UI, port 8080        | user and password of the Web UI, or an API key (qBittorrent 5.2 and newer)                                                                                         |
| Transmission                   | RPC, port 9091           | user and password if you set one; the ioBroker host must be allowed in `rpc-whitelist`                                                                             |
| Deluge                         | Web UI, port 8112        | the Web UI password                                                                                                                                                |
| SABnzbd                        | API, port 8080           | the API key (Config → General)                                                                                                                                     |
| NZBGet                         | API, port 6789           | control user and password                                                                                                                                          |
| aria2                          | JSON-RPC, port 6800      | the RPC secret (`--rpc-secret`)                                                                                                                                    |
| pyLoad                         | API, port 8000           | an API key (pyLoad 0.5.0b3.dev97 and newer) or user and password                                                                                                   |

**About the JDownloader local API:** it has no password. Anyone in the network who reaches the port can change
JDownloader's settings or shut it down. Use it only when JDownloader runs on the ioBroker host or in the same Docker
network; otherwise use My.JDownloader.

## Setup

1. Install the adapter and open the instance settings. The programs are cards of the device manager; they appear while
   the instance runs.
2. Press **+**, choose the program. Its dialog asks only for what this program needs: a name, the address and port
   (empty = the program's default) and its login. For JDownloader choose _Local network_ or _Through My.JDownloader_;
   with My.JDownloader you log in and pick your JDownloader from a list.
3. Apply. The instance restarts, and the program appears as a card and as a device under `dl-manager.0`. The ID in
   the object path — `qbittorrent-nas` — comes from the name; under _Advanced_ you can set it yourself before the first
   save. It stays the same from then on, so rooms, functions and scripts keep working.
4. The test button on the card asks the program once and shows its version or the reason it cannot be reached.

Every program can be added as often as you like. A second entry for the same program — the same address, or the same
JDownloader of a My.JDownloader account — is refused. The switch on a card turns a program off without deleting its
device; delete removes the device, never a file.

## What you find in the object tree

- `info.*` — how many programs are configured and reachable.
- `summary.*` — over all programs: whether any download is active, total speeds, a switch that pauses every program,
  the last finished and the last failed download (with time).
- `<program>-<id>.*` — the program: reachable, reason, version, speeds, limits, free space, pause switch, an input to
  add a link, counts and its own last finished / failed download.
- `<program>-<id>.downloads.<download>.*` — one channel per download with status, progress, size, speed, time left,
  error and the actions the program offers (pause, remove, and for some programs recheck, force start or retry).

The status is the same list for every program: queued, downloading, waiting, paused, checking, post-processing, seeding,
completed, failed.

## Which downloads the object tree shows

Two settings decide which downloads get their own channel. The program keeps every download either way, and the totals
(`summary.*`, the program's own counters and `lastFinished`) always count all of them.

- **Downloads in the object tree:** _All_ (the default), _Without completed_, or _Only unfinished_ — the last one also
  leaves out seeding torrents. Failed downloads always stay, they need you.
- **At most this many downloads per program:** 100 by default, 0 = all. When a program has more, the running ones keep
  their channel first, then failed, paused and waiting, queued, seeding and completed ones — the newest first within
  each group. A download that loses its channel gets it back as soon as there is room again.

Every download creates up to 15 objects whose values can change with every poll. With 0 or more than 200 downloads per
program that quickly adds up to thousands, which puts a load on the ioBroker database and slows the object tree in the
admin down. The settings page shows a warning then, and the log warns once per program when more than 200 downloads
actually stand in the tree.

`remove` on a download takes it off the program's list; the files always stay on disk.

## More

- [Every datapoint, per program](datapoints.md)
- [Frequently asked questions](faq.md)

## Error reporting

Error reporting via Sentry is active by default; what it sends and how to switch it off is described in the [Sentry section of the main README](../../README.md#sentry--error-reporting).
