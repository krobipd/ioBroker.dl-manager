# Download Station fixtures — where they come from

Nothing here is recorded by `live-programs.yml`: DSM may run on Synology hardware only (its licence), so there is no
container to record. Every answer comes from outside this adapter's code; each file's `_source.origin` names the
repository, the commit, the file and the key it was taken from.

- **`4.1-5012/`** — DSM 7.2.2 with Download Station 4.1-5012 (Virtual DSM).
  - Live captures by [cmeans/mcp-synology](https://github.com/cmeans/mcp-synology) (Apache-2.0), commit
    `5d4e202f3c0e185601b7cdc0612f1850c28e9c0b`, `tests/modules/downloadstation/fixtures/dsm-7.2.2-ds-4.1-5012.json`,
    captured on 2026-10-10 (its issue #123). Only the account name in `username` is replaced.
  - The login answer and the refused login (error 400): test data of
    [mib1185/py-synologydsm-api](https://github.com/mib1185/py-synologydsm-api) (MIT), commit
    `9aca699eec2a49c8817828c9cc9c5afec6ffc670` — no live login answer exists.
  - The lost session (error 119): the mock answer of cmeans' `tests/core/test_auth.py`.
  - `auth/api-info.json` is composed: the Download Station entries from the capture, `SYNO.API.Auth` from
    py-synologydsm-api's DSM 7 test data (the capture holds no Auth entry).
- **`3.8-3543/`** — DSM 6.2 with Download Station 3.8-3543: test data of py-synologydsm-api (MIT, same commit); whether a
  live capture stands behind it the repository does not say. Its task list was asked with `additional=detail,file`, so
  it carries no `transfer` block and no byte counts. The account name and a partner parameter in one link are replaced.
