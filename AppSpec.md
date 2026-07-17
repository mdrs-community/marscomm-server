# MarsComm Server Specification

See also: `AppSpec.md` in the client repo (`a:/prog/misc/qooxdoo`) for the overall application specification including full functional requirements and client design.

---

## Overview

The MarsComm server is a Node.js/Express application that provides the backend for the MarsComm communications simulation system. It maintains an in-memory database of mission Sols, instant messages, and reports, and pushes real-time updates to connected clients via Server-Sent Events (SSE).

State is automatically persisted to `db.json` after 1 minute of server idle time (no client requests), and immediately on clean shutdown (SIGINT/SIGTERM). Writes are atomic (write to `db.json.tmp`, then rename). On startup the DB is loaded from `db.json` by default if it exists. Uncaught exceptions and unhandled promise rejections trigger an emergency save before exiting. Each save also rotates up to 5 numbered rolling backups (`db.json.1`–`db.json.5`), and if the existing `db.json` is from a previous calendar day, it is additionally archived as `db.json.YYYY-MM-DD` before being rotated out.

---

## Technology Stack

- **Runtime**: Node.js
- **Framework**: Express 4
- **File upload**: multer
- **ZIP generation**: JSZip
- **Configuration**: `config.json` (loaded at startup, not reloaded at runtime)
- **Persistence**: In-memory with automatic save to `db.json` after 1 minute of idle or on shutdown; atomic write (tmp+rename); loaded automatically on startup

---

## Source Layout

```
mcserver.js          -- main server (loads mcfiles.js for file-sharing routes)
mcfiles.js           -- file-sharing routes module (registers /files* routes on the Express app)
serverStats.js       -- standalone tool: analyze a db.json and print message statistics
                        (node serverStats.js [dbfile] [firstSol] [lastSol]); not loaded by the server
config.json          -- configuration (organization, port, users, reports, templates, delays)
config.md            -- hand-maintained reference documentation for config.json parameters
db.json              -- optional saved DB snapshot (plus rolling/daily backups db.json.1-5, db.json.YYYY-MM-DD)
package.json         -- dependencies
attachments/         -- uploaded report attachment files (multer-generated filenames)
files/               -- uploaded shared files (multer-generated filenames)
```

---

## Configuration (`config.json`)

| Field | Type | Description |
|---|---|---|
| `organization` | string | `"MDRS"` or `"LunAres"` — controls client branding |
| `port` | number | HTTP port to listen on (default 8081) |
| `crewNum` | number | Current crew rotation number |
| `rotationLength` | number | Number of Sols in the mission rotation (Sol 1 through Sol `rotationLength`) |
| `missionStartDate` | string | YYYY-MM-DD date of Sol 1. If present, enables pre/post-flight phases (see Sol Navigation in client spec). If absent, server falls back to legacy behavior (today at server start = Sol 0). |
| `solDuration` | string | `"Earth"` (default) or `"Mars"`. Controls the length of one Sol used by `getSolNum()` and the client Sol time display. Only meaningful when `missionStartDate` is set. `"Earth"` = 86,400,000 ms per Sol (Sol time equals Earth time); `"Mars"` = 88,775,244 ms per Sol, drifting ~39 min/sol from Earth time. "Sol" is used in a generalised sense — analog missions use the term regardless of actual duration. |
| `startingSolNum` | number | (unused at runtime; reference only) |
| `commsDelay` | number | One-way communications delay in seconds; `-1` means use the real Earth-Mars delay, computed by a sinusoidal approximation (see Known Limitations). Note: the file-sharing module (`mcfiles.js`) does not use the approximation — with `-1` it falls back to a fixed 30 s for file transit windows. |
| `clientPath` | string | Optional path to the client repo, used to gather client git version info for `GET /version` (default `../misc/qooxdoo`) |
| `reports` | `{name, due?, access[]}[]` | Unified report list. `due` absent or `"daily"` = every Sol; `due` as integer = that Sol only. `access` is a list of role names and/or group names (built-in: `"All"`, `"Mission Control"`, `"Crew"`; or custom group names). If `access` is omitted, the report is visible to all users. |
| `users` | `{role, name, word, planet, abbr?}[]` | User accounts; `word` is the password; `planet` is `"Earth"` or `"Mars"`; optional `abbr` is a short role abbreviation used by the client in Chat names (e.g. `"MCD"` for MC Director) |
| `groups` | `{name, roles[]}[]` | Optional custom distribution groups beyond the built-in All/Mission Control/Crew. Each `roles` entry must exactly match a `role` string in `users`. |
| `distributionCooldown` | number | Seconds the client waits after a distribution change before refreshing the chat view. Default 2. |
| `messageArrivalSoundCooldown` | number | Minimum seconds between IM arrival sounds on the client. Default 180. |
| `testMode` | boolean | If `true`, enables test/debug features on the client (e.g. Joke Mode). Default `false`. |
| `reportTemplates` | `{name: htmlString}` | HTML templates for each report type; support placeholders `{crewNum}`, `{date}`, `{solNum}` |
| `fileSystem` | `{folders: [{path, access[]?}]}` | Defines the fixed folder structure for file sharing. Each folder has a `path` (display name / unique key) and an optional `access[]` list using the same role/group format as `reports[].access`. If `access` is omitted, the folder is visible to all users. |

---

## Data Model

### Sol

When `missionStartDate` is configured, created at startup for Sol indices 0..rotationLength+1 (rotationLength+2 total):
- **Sol 0** — pre-flight; accumulates all messages sent before `missionStartDate`
- **Sol 1..rotationLength** — mission days
- **Sol rotationLength+1** — post-flight; accumulates all messages sent after the rotation ends

When `missionStartDate` is absent (legacy mode), created for indices 0..rotationLength-1 as before.

Each Sol contains:
- `solNum`: integer index
- `chats[]`: array of Chat objects (replaces the former flat `ims[]`)
- `reportsEarth[]`: report objects for Earth users
- `reportsMars[]`: report objects for Mars users

Both `reportsEarth` and `reportsMars` are populated with the same report names (daily + applicable special reports), but track content/state independently per planet.

**DB migration:** if a loaded `db.json` has Sols with an `ims[]` field and no `chats[]`, rehydration wraps those IMs into a single Chat whose `users` list is all usernames in `config.users`, preserving history.

### Chat

```
{
  users: string[],   // sorted list of usernames in this chat (always includes sender)
  ims: IM[]
}
```

A Chat is identified by its `users` set. When a new IM is POSTed, the server searches the current Sol's `chats[]` for one whose `users` array matches the target set (including the sender); if found the IM is appended, otherwise a new Chat is created. The sender is always added to the user set server-side even if omitted by the client.

### Report

```
{
  type: "Report",
  name: string,
  planet: "Earth"|"Mars",      // which planet "owns" this copy
  content: string,             // HTML content
  approved: boolean,           // true = approved by Mission Control
  author: string,              // username of last editor
  authorPlanet: string,        // planet of last editor
  transmitted: boolean,        // true = transmit has been initiated
  xmitTime: Date,
  attachments: Attachment[]
}
```

**Report lifecycle on the server:**
1. Reports are created empty at server startup (never created/destroyed by client requests, except copies in transit).
2. `POST /reports/update` — updates content/approval on the author's planet copy.
3. `POST /reports/transmit/:name` — marks the report transmitted, clones it into `reportsInTransit[]`, and schedules `reportArrived()` after `commsDelay` seconds. On arrival, the target planet's copy is updated from the clone, and the clone is discarded.
4. `POST /reports/reset/:name` — clears both planets' copies back to Empty (content, approval, attachments, transmitted state).
5. All mutations push real-time updates to the affected planet's SSE clients.

### IM (Instant Message)

```
{
  type: "IM",
  id: number,           // server-assigned sequential integer, scoped to the containing Chat (1, 2, 3, …)
  content: string,
  user: string,
  planet: "Earth"|"Mars",
  xmitTime: Date,
  transmitted: true,    // IMs are always transmitted immediately
  replyTo?: {           // present only when the sender is replying to a prior IM
    id: number,         // id of the original IM within this Chat
    user: string,       // sender of the original IM
    snippet: string     // first ~60 chars of original IM plain text
  }
}
```

The `id` is assigned by the server at the moment the IM is appended to a Chat: `id = chat.ims.length + 1` (before push). IDs are 1-based and stable across restarts via `db.json`. IDs are scoped to a single Chat — different Chats within the same Sol may reuse the same integers.

The `edited` flag is set to `true` on an IM when its content has been replaced via `POST /ims/edit`.

IMs are stored inside a Chat. The server broadcasts every new IM to ALL connected clients on both planets, including the Chat's `users[]` array in the pushed payload so the client can filter by current distribution. The client is responsible for holding IMs that haven't yet "arrived" based on comms delay.

### File

File records are stored in a global `files[]` array (not scoped per Sol).

```
{
  id: number,            // server-assigned sequential integer (1-based, global)
  name: string,          // current filename
  folder: string,        // current folder path (matches a config fileSystem.folders[].path)
  size: number,          // bytes
  storedAs: string,      // multer-generated opaque filename in files/ directory
  uploadedBy: string,    // username of uploader
  planet: "Earth"|"Mars",
  xmitTime: Date,        // when uploaded
  deleted: boolean,      // true = soft-deleted (not served for download; hidden after delay)
  prevOp?: {             // set when a rename/move/delete is in transit to the other planet
    op: "rename"|"move"|"delete",
    planet: "Earth"|"Mars",  // planet that initiated the operation
    xmitTime: Date,
    prevName?: string,   // name before rename (present for op="rename")
    prevFolder?: string  // folder before move (present for op="move")
  }
}
```

**prevOp lifecycle:**
- Set by the server when processing a rename, move, or delete mutation.
- The server clears `prevOp` from the record once `prevOp.xmitTime + commsDelay` has elapsed (checked lazily on next `GET /files`).
- Clients use `prevOp` on reconnect to reconstruct the in-transit view without SSE replay.

File binaries are stored by multer in the `files/` directory using opaque filenames (`storedAs`). Downloads are streamed via `GET /files/download?id=<id>`.

### Attachment

```
{
  type: "Attachment",
  reportName: string,
  filename: string,      // original filename
  content: string        // multer-generated temp filename in attachments/ dir
}
```

Attachment binary data is stored by multer in the `attachments/` directory using opaque filenames. The `content` field holds that opaque filename. When serving a ZIP, the server reads the file from disk using `content` as the path.

---

## REST API Endpoints

### Configuration / Info (no auth required)

| Method | Path | Response |
|---|---|---|
| `GET` | `/` | `"Hello MarsComm!"` |
| `GET` | `/ref-date` | `{ refDate, missionStartDate, solDuration }` — `refDate` is one Earth day before Sol 1; `missionStartDate` is the YYYY-MM-DD string from config (null if not configured); `solDuration` is `"Earth"` or `"Mars"` |
| `GET` | `/comms-delay` | `{ commsDelay }` — one-way delay in seconds |
| `GET` | `/crew-num` | `{ crewNum }` |
| `GET` | `/rotation-length` | `{ rotationLength }` |
| `GET` | `/organization` | `{ organization }` — `"MDRS"` or `"LunAres"` |
| `GET` | `/distribution-cooldown` | `{ distributionCooldown }` |
| `GET` | `/message-arrival-sound-cooldown` | `{ messageArrivalSoundCooldown }` |
| `GET` | `/test-mode` | `{ testMode }` — whether test features are enabled |
| `GET` | `/version` | `{ server: {tag, hash, date}, client: {tag, hash, date} }` — git tag/short-hash/commit-date of both repos, gathered once at startup via `git describe`/`rev-parse` (client repo located via config `clientPath`) |
| `GET` | `/reports` | `[{name, due?, access[]}]` — all report definitions; `due` present only for Sol-specific reports; `access` present only when restricted |
| `GET` | `/reports/templates` | `{ name: htmlString, ... }` — report templates |

### Authentication

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/login` | `{ username, password }` | `{ token, planet }` on success; `401` on failure |

Tokens are random floats assigned at login. Tokens expire 24 hours after login (validated by checking that `loginTime` is within the last 24 hours).

### Users

| Method | Path | Response |
|---|---|---|
| `GET` | `/users` | `{ users: [{role, name, planet, abbr?}], groups: [{name, roles[]}] }` — all users (no passwords) and config groups |

### Sol Data

| Method | Path | Response |
|---|---|---|
| `GET` | `/sols/:sol` | Full Sol object including `chats`, `reportsEarth`, `reportsMars` |

### Instant Messages

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/ims` | `{ message, username, token, users[], replyTo? }` | `200` + pushes IM (with `users[]`) to all SSE clients |
| `POST` | `/ims/edit` | `{ id, message, username, token, users[] }` | `200` + pushes `IMEdit` event to all SSE clients; updates IM content in-place |

`users[]` is the list of target usernames selected by the sender. The server always adds `username` to the set if not already present. The matching Chat is found by sorted `users[]` comparison, or created if none exists. The optional `replyTo` object (`{ id, user, snippet }`) is stored on the IM as-is; the server does not validate it.

### Reports

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/reports/update` | `{ reportName, content, approved, attachments, username, token }` | `200` + pushes Report to local planet SSE clients |
| `POST` | `/reports/transmit/:reportName` | `{ username, token }` | `200`; schedules arrival on other planet after comms delay |
| `POST` | `/reports/reset/:reportName` | `{ username, token }` | `200`; clears content/approval/attachments/state of the named report on **both** planets for the current Sol and pushes each planet's cleared copy to its SSE clients |

### Attachments

| Method | Path | Notes |
|---|---|---|
| `POST` | `/attachments` | Multipart upload; fields: `files[]`, `reportName`, `username`, `token`. Stored by multer. |
| `POST` | `/reports/add-attachment` | Legacy JSON endpoint (`{ reportName, filename, content, username, token }`) that adds a single attachment record; superseded by the multipart `/attachments` endpoint and no longer called by the client |
| `GET` | `/attachments/:planet/:solNum` | Returns attachment list (with base64 content for client-side ZIP) |
| `GET` | `/attachments/zip/:planet/:solNum` | Returns a ZIP file of all attachment binaries for the Sol/planet |
| `GET` | `/attachments/download?file=<opaque>&name=<orig>` | Streams a single attachment file; `file` is the multer-generated opaque filename (validated against `[a-zA-Z0-9_.-]+`), `name` is the original filename used in `Content-Disposition`. No auth required (opaque name acts as capability token). |

### Files

File storage is handled by a separate module (`mcfiles.js`) loaded by `mcserver.js`. File binaries are stored by multer in the `files/` directory.

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/files/folders` | — | Folder definitions from config `fileSystem.folders` (`[{path, access?}]`); no auth required |
| `GET` | `/files` | — | Array of all non-deleted file records (plus soft-deleted records whose `prevOp.xmitTime + commsDelay` has not elapsed for either planet). Auth not required (access filtering is client-side). |
| `POST` | `/files/upload` | Multipart; fields: `files[]`, `folder`, `username`, `token` | `200`; creates File records; pushes `FileUpdate` (op=`"add"`) to all SSE clients |
| `POST` | `/files/rename` | `{ id, name, username, token }` | `200`; sets `prevOp={op:"rename", planet, xmitTime, prevName}` then updates `name`; pushes `FileUpdate` (op=`"rename"`) to all SSE clients |
| `POST` | `/files/move` | `{ id, folder, username, token }` | `200`; sets `prevOp={op:"move", planet, xmitTime, prevFolder}` then updates `folder`; pushes `FileUpdate` (op=`"move"`) to all SSE clients |
| `POST` | `/files/delete` | `{ id, username, token }` | `200`; sets `prevOp={op:"delete", planet, xmitTime}` then sets `deleted:true`; pushes `FileUpdate` (op=`"delete"`) to all SSE clients |
| `GET` | `/files/download?id=<id>` | — | Streams the file binary; `Content-Disposition: attachment; filename="<name>"`. No auth required (numeric ID is not guessable enough for sensitive data). |

`GET /files` lazily clears expired `prevOp` fields before serializing: if `prevOp.xmitTime + commsDelay < now`, `prevOp` is deleted from the record in memory before the response is sent.

### Server-Sent Events

| Method | Path | Notes |
|---|---|---|
| `GET` | `/events/:planet` | SSE stream. Client subscribes after login. Server pushes IM and Report objects as JSON. |

---

## Authentication

- Passwords are stored in plaintext in `config.json` as `word` field (suitable for simulation/demo use only).
- On login, a random float token is assigned to the user in memory.
- All mutating endpoints (`/ims`, `/reports/update`, `/reports/transmit`, `/attachments`) validate `username` + `token` and reject with `401` if invalid.
- Tokens are validated as "within 24 hours of login time".

---

## Real-Time Push (SSE)

Two sets of SSE clients are maintained: `pushClientsEarth` and `pushClientsMars`.

- IMs are pushed to **all** clients (both planets). The pushed object includes the Chat's `users[]` so the client can determine whether to display the message given the currently-selected distribution. Comms-delay filtering is done client-side as before.
- `IMEdit` events (`{ type: "IMEdit", id, content, user, planet, xmitTime, chatUsers }`) are pushed to **all** clients when a message is edited. The client applies the same comms delay as for a new IM from the same planet, then updates the rendered message label in-place (appending "(edited)" to the timestamp).
- Report updates (`/reports/update`) are pushed to clients on the **same planet** as the author.
- Report arrivals (after transit delay) are pushed to clients on the **target planet**.
- `FileUpdate` events (`{ type: "FileUpdate", op: "add"|"rename"|"move"|"delete", file: <FileRecord> }`) are pushed to **all** clients on file mutations. The client applies commsDelay for events whose `file.planet` differs from the viewer's planet before updating the UI.
- Each client connects via `GET /events/:planet` and is added to the appropriate set; removed on disconnect.

---

## Command-Line Arguments

| Argument | Effect |
|---|---|
| `reset` (aliases `--reset`, `--restart`) | Rename `db.json` to `db.json.<yyyymmdd_hhmmss>` and start with a fresh empty DB |
| `verbose` | Enable verbose logging |
| `help` | Print usage and exit |

---

## Running the Server

```bash
# Install dependencies
npm install

# Start (automatically restores db.json if it exists)
node mcserver.js

# Archive any existing db.json and start with a fresh empty DB
node mcserver.js reset
```

The server listens on `config.port` (default 8081). CORS is enabled for all origins.

---

## Known Limitations / TODOs

- Passwords stored in plaintext in `config.json`.
- `commsDelay = -1` uses a sinusoidal approximation of the real Earth-Mars light travel time (182–1342 seconds), calibrated to the Jan 16 2025 opposition and accurate to ~10% through 2030. No internet lookup is performed.
- When `missionStartDate` is configured, `getSolNum()` computes `sol = floor((now − missionStartDate_midnight) / solDurationMs) + 1` and clamps to [0, rotationLength+1], where `solDurationMs` is 86,400,000 for `"Earth"` or 88,775,244 for `"Mars"`. In legacy mode (no `missionStartDate`), `refDate` is today's date at server start, sol uses Earth day duration, and the clamp is [0, rotationLength-1].
- If a report transmits across a Sol boundary (midnight for Earth, or the equivalent Mars sol boundary), the Sol assignment in `reportArrived()` may be off by one.
- The report-arrival timer in `transmitReport()` uses `config.commsDelay * 1000` directly rather than the `commsDelay()` function, so when `commsDelay = -1` (real Mars delay) the timeout is negative and the report arrives on the other planet immediately. Report transit only works correctly with a fixed non-negative `commsDelay`.
- `reportsInTransit` is included in `db.json` saves but is never restored by `load()`, and arrival timers do not survive a restart — a report that is in transit when the server stops will never arrive on the other planet.
- The `body-parser` package is used explicitly but is included in Express 4 — minor redundancy.
