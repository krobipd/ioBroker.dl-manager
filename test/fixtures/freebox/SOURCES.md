# Freebox fixtures — where they come from

Nothing here is recorded by `live-programs.yml`. The Freebox is a router of the French provider Free — there is no
container to start and no Freebox on a CI runner. Each file's `_source.origin` names where its answer comes from;
`recordedAt` says whether a running Freebox gave it. The folder `v8/` is the API path the driver speaks; the answers of
the older path `/api/v1/` carry the same objects (the Freebox OS documentation 4.0 and the box's own documentation for
API 16.0 describe them alike).

- **Answers of running Freeboxes** (the box model is not named in the logs):
  - `queue/list.json`, `config/get.json`, `commands/add.json`, `commands/put.json`, `auth/challenge.json`,
    `auth/session.json`, `auth/auth-required.json` — Radarr 6.3.0.10514's trace log in the attachment `radarr.trace.txt`
    of [Radarr/Radarr#11651](https://github.com/Radarr/Radarr/issues/11651) (2026-08-25), lines 1892, 1798, 1804, 1808,
    3080, 3084 and 2969–2971.
  - `queue/list-stopped.json`, `queue/list-checking.json`, `queue/list-empty.json` — Radarr 5.5.0.8729's trace log of
    [Radarr/Radarr#9938](https://github.com/Radarr/Radarr/issues/9938) (2024-04-19), the gist `YannD-Delta/bd76cb87`
    revision `9802aa4d`, lines 13023, 13533 and 19334. An empty list is `{"success": true}` without `result`.
  - `app/api-version.json` — the answer of `/api_version` of a Freebox v9 (r1), API 16.0, in
    [AriusII/Freenaute-Freebox-Api](https://github.com/AriusII/Freenaute-Freebox-Api) at commit `84f15ddb`
    (`docs/freebox-official/api-16.0/sources/api-version.json`, 2026-10-02); its author removed `uid`, `api_domain`,
    `https_port`, `device_name` and `https_available`. The repository names no licence: the file is the box's own
    answer — five facts about it (API version and path, model, model name, device type) —, not the author's code.
  - Replaced in these answers by recognisable placeholders: release names, info hashes, the release folders in the
    base64 `download_dir`, session token, challenge, password salt, `uid` and the usenet user. Nothing else changed.
- **Test data of [NikolaLohinski/free-go](https://github.com/NikolaLohinski/free-go)** (MIT), commit `9848288a`,
  `client/`: `auth/invalid-token.json` (`authentication_test.go` L555–L564, HTTP 403), `auth/session-no-downloader.json`
  (L389–L413, an app without the right to the downloads) and `commands/task-not-found.json` (`downloads_test.go`
  L259–L263; the mock answers HTTP 200, no source shows the real code). The app token of the driver's tests is
  free-go's test token (`suite_test.go` L20), and the session password test is its vector (L376/L387); the inventory
  row's token is `fixture`, like every other row's secret.
- **Examples of the Freebox OS API documentation 4.0** (`dev.freebox.fr/sdk/os`): the pairing (`pairing/authorize.json`,
  `pairing/track-pending.json`, `pairing/track-granted.json`, `login.txt` L64–L160), the removal
  (`commands/delete.json`, `download.txt` L371–L401) and the config with set limits (`config/get-limited.json`,
  `download_config.txt` L402–L455, the answer to an update; the comments and the elided `schedule` left out).
- **Built by the adapter**:
  - `pairing/track-denied.json`: the status `denied` the documentation lists for the pairing, in the form of its examples.
  - `queue/list-states.json`: one task per documented status and type no capture holds (`download.txt` L42–L120) —
    done, error, an NZB's checking, repairing and extracting, starting, stopping, retry, queued, an http download that
    loads —, in the key order of the captures; bt like Radarr #11651, http/ftp/nzb like free-go's fixture (no info hash,
    piece length 0). Every value is the adapter's own.
