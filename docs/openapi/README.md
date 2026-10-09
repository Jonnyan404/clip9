# OpenAPI spec for the clip9 server

`clip9.openapi.yaml` is an **OpenAPI 3.1** description of the HTTP + WebSocket contract
implemented by `clip9-server` (`rust/crates/server`). It is derived from the routing table in
`crates/server/src/lib.rs` and from each handler, so **the code is the source of truth** — where
prose here and the code disagree, the code wins.

| File | What it is |
|---|---|
| `clip9.openapi.yaml` | the spec: 32 paths, 51 schemas, every response carries a named example; the Chinese build is checked too |
| `check-openapi.py` | checks the document, and that every example conforms to its schema |

## Checking it

```bash
python3 -m pip install pyyaml openapi-spec-validator jsonschema
python3 docs/openapi/check-openapi.py
```

```
OK  structure: clip9.openapi.yaml is a valid OpenAPI 3.1.0 document (32 paths, 51 schemas)
OK  examples: all 190 named examples conform to their schemas
```

The example check is the point. `openapi-spec-validator` only proves the document is
well-formed; it happily accepts examples that describe a response the server will never send.
Generated clients and careful readers trust examples, so a spec whose examples are wrong is
worse than a spec with no examples at all.

## Viewing it

```bash
# Redoc
npx @redocly/cli preview-docs docs/openapi/clip9.openapi.yaml
# or Swagger UI
npx swagger-ui-watcher docs/openapi/clip9.openapi.yaml
```

Both need Node and network access for the viewer assets. Without either, the published site renders
the spec at <https://jonnyan404.github.io/clip9/spec.html> (with a language switch), and the top of
the file has an endpoint index.

**Chinese**: `clip9.openapi.zh.yaml` is **generated** — `zh.yaml` holds the translated prose and
`build-zh.py` splices it into a copy of this spec. Structure (paths, fields, `required`, examples)
comes from the English file, so the two cannot drift; that is the whole reason it is generated
rather than written twice. Entries that are not translated yet keep their English text.

## What to read first

- **Authentication** — three carriers (`Authorization`, `?auth=`, `Sec-WebSocket-Protocol`) and
  four credential kinds (global password, room password, session token, share token).
- **Error contract** — one shape, three fields, never split by `Accept`.
- **Limits** — `text.limit` / `file.limit` come from the WS `config` frame, not from `/server`,
  and there are separate absolute per-request body ceilings.
- **Realtime** — `/push` carries an `x-websocket-events` extension describing every frame, since
  OpenAPI has no native WebSocket support.

## Deliberate divergences from the Go and Worker backends

The three backends are not identical, and the older prose reference (now removed) had drifted from
the Rust implementation in a few places. The spec follows the code; these are the differences,
marked in the spec with `NOTE (code)`:

| Area | Go / older docs | this spec (and the Rust code) |
|---|---|---|
| Content format | table lists `?format=` priority 1-5 | `?json=1` is legacy, `.json` path suffix is **gone** (`/content/7.json` → `400 invalid_content_id`) |
| `GET /content/latest` | "omit `room` → newest across all rooms" | omit `room` → the `default` room; cross-room needs the explicit `?all=1` |
| `GET /upload` response | `uuid` / `name` / `size` / `expire` | `{url, id, type}` only |
| `/revoke/{id}`, `/revoke/all` | `DELETE` | `POST` only (a browser hitting `/revoke/5` must not delete anything) |
| `/push` credential | documented as `?token=` | `?auth=` / `Authorization` / `Sec-WebSocket-Protocol` |
| `/file/{uuid}` | — | `DELETE` is also accepted; a share token works for `GET` only |
| `senderDevice` | shown with the same keys as a device event | a free-form string map (`type` / `os` / `browser` / `name`), not the WS `DeviceMeta` |
| `/tasks/preview` reference time | — | returned as `referenceAt2`, while a saved-task dry run calls it `scheduledAt` |
| `GET /content/{id}/column` auth error | — | `room_auth_required`, not `room_forbidden` |

`/healthz` is present in the spec but is **not** part of the contract — it is a liveness probe
that the Rust server and the Cloudflare Worker both answer (the Worker also keeps its original
`/health`; the Go server had neither), flagged as such in its description.
