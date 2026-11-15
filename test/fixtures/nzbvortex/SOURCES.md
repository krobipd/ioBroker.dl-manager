# NZBVortex fixtures — where they come from

Nothing here is recorded by `live-programs.yml`. NZBVortex runs on macOS only (no container), and its licence allows the
paid forms on the buyer's household computers only and network access only with a site licence, so it is not run on a
CI runner either. Each file's `_source.origin` names where its answer comes from; `recordedAt` says whether a running
NZBVortex gave it.

- **Captures of a running NZBVortex** (the version is not named in either source):
  - `auth/nonce.json`, `auth/login.json`, `queue/list-empty.json` — Sonarr's trace log in the attachment
    `nzbdrone.copy.txt` of [Sonarr/Sonarr#1168](https://github.com/Sonarr/Sonarr/issues/1168) (2016-03-03), lines 4586,
    4588 and 1235. Nonce and session id are replaced by recognisable placeholders of the same form.
  - `auth/not-logged-in.json` — the HTTP 403 and its body for a lapsed session, from Sonarr v2.0.0.4949's log in
    [Sonarr forum thread 16517](https://forums.sonarr.tv/t/16517), post 1 (2017-10-25).
- **Examples of NZBVortex's Network API documentation**, revision 1.7 (API level 2.3, NZBVortex 3.2.0), published on
  [nzbvortex.com/developerconnect](https://nzbvortex.com/site/developer-connect/): the refused login (p. 11), the version
  (p. 13), the success of a command (p. 19–24) and the speed limit (p. 28–30). The documentation writes them with
  typographic quotes and comments; here they are the plain JSON they describe.
- **Built by the adapter** — no source holds a non-empty queue of a running NZBVortex:
  - `queue/list.json`: every key of an entry and its type as the documentation lists them (p. 15), the states from its
    table (p. 35), `groupName` as Sonarr's `NzbVortexQueueItem` reads it. Every value is the adapter's own.
  - `commands/add.json`: the form of p. 17–18 with an `add_uuid` of the adapter's own.
