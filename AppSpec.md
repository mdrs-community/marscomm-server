# MarsComm Server Specification

See also: `AppSpec.md` in the client repo (`a:/prog/misc/qooxdoo`) for the overall application specification including full functional requirements and client design.

---

## Overview

The MarsComm server is a Node.js/Express application that provides the backend for the MarsComm communications simulation system. It maintains an in-memory database of mission Sols, instant messages, and reports, and pushes real-time updates to connected clients via Server-Sent Events (SSE).

State is automatically persisted to `db.json` after 1 minute of server idle time (no client requests), and immediately on clean shutdown (SIGINT/SIGTERM). Writes are atomic (write to `db.json.tmp`, then rename). On startup the DB is loaded from `db.json` by default if it exists. Uncaught exceptions and unhandled promise rejections trigger an emergency save before exiting.

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
mcserver.js          -- entire server (single file)
config.json          -- configuration (organization, port, users, reports, templates, delays)
db.json              -- optional saved DB snapshot
package.json         -- dependencies
attachments/         -- uploaded attachment files (stored by multer-generated filenames)
```

---

## Configuration (`config.json`)

| Field | Type | Description |
|---|---|---|
| `organization` | string | `"MDRS"` or `"LunAres"` — controls client branding |
| `port` | number | HTTP port to listen on (default 8081) |
| `crewNum` | number | Current crew rotation number |
| `rotationLength` | number | Number of Sols in the rotation |
| `startingSolNum` | number | (unused at runtime; reference only) |
| `commsDelay` | number | One-way communications delay in seconds; `-1` means use real Mars delay (currently falls back to 30s) |
| `dailyReports` | string[] | Report names present every Sol |
| `specialReports` | `{name, due}[]` | Report names present only on specific Sol numbers |
| `users` | `{role, name, word, planet}[]` | User accounts; `word` is the password; `planet` is `"Earth"` or `"Mars"` |
| `reportTemplates` | `{name: htmlString}` | HTML templates for each report type; support placeholders `{crewNum}`, `{date}`, `{solNum}` |

---

## Data Model

### Sol

Created at startup for each Sol index 0..rotationLength-1. Contains:
- `solNum`: integer index
- `ims[]`: array of IM objects
- `reportsEarth[]`: report objects for Earth users
- `reportsMars[]`: report objects for Mars users

Both `reportsEarth` and `reportsMars` are populated with the same report names (daily + applicable special reports), but track content/state independently per planet.

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
4. All mutations push real-time updates to the affected planet's SSE clients.

### IM (Instant Message)

```
{
  type: "IM",
  content: string,
  user: string,
  planet: "Earth"|"Mars",
  xmitTime: Date,
  transmitted: true     // IMs are always transmitted immediately
}
```

IMs are stored per-Sol. The server broadcasts every IM to ALL connected clients (both planets). The client is responsible for holding IMs that haven't yet "arrived" based on comms delay.

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
| `GET` | `/ref-date` | `{ refDate }` — Sol 0 reference date (today's date at server start) |
| `GET` | `/comms-delay` | `{ commsDelay }` — one-way delay in seconds |
| `GET` | `/crew-num` | `{ crewNum }` |
| `GET` | `/rotation-length` | `{ rotationLength }` |
| `GET` | `/organization` | `{ organization }` — `"MDRS"` or `"LunAres"` |
| `GET` | `/reports` | `string[]` — list of all report names (daily + special) |
| `GET` | `/reports/templates` | `{ name: htmlString, ... }` — report templates |

### Authentication

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/login` | `{ username, password }` | `{ token, planet }` on success; `401` on failure |

Tokens are random floats assigned at login. Tokens expire daily (validated by checking `loginTime` is today).

### Sol Data

| Method | Path | Response |
|---|---|---|
| `GET` | `/sols/:sol` | Full Sol object including `ims`, `reportsEarth`, `reportsMars` |

### Instant Messages

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/ims` | `{ message, username, token }` | `200` + pushes IM to all SSE clients |

### Reports

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/reports/update` | `{ reportName, content, approved, attachments, username, token }` | `200` + pushes Report to local planet SSE clients |
| `POST` | `/reports/transmit/:reportName` | `{ username, token }` | `200`; schedules arrival on other planet after comms delay |

### Attachments

| Method | Path | Notes |
|---|---|---|
| `POST` | `/attachments` | Multipart upload; fields: `files[]`, `reportName`, `username`, `token`. Stored by multer. |
| `GET` | `/attachments/:planet/:solNum` | Returns attachment list (with base64 content for client-side ZIP) |
| `GET` | `/attachments/zip/:planet/:solNum` | Returns a ZIP file of all attachment binaries for the Sol/planet |

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

- IMs are pushed to **all** clients (both planets). The client-side handles delay filtering.
- Report updates (`/reports/update`) are pushed to clients on the **same planet** as the author.
- Report arrivals (after transit delay) are pushed to clients on the **target planet**.
- Each client connects via `GET /events/:planet` and is added to the appropriate set; removed on disconnect.

---

## Command-Line Arguments

| Argument | Effect |
|---|---|
| `reset` | Rename `db.json` to `db.json.<yyyymmdd_hhmmss>` and start with a fresh empty DB |
| `verbose` | Enable verbose logging |
| `help` | Print usage and exit |

---

## Running the Server

```bash
# Install dependencies
npm install

# Start with default (empty) DB
node mcserver.js

# Start and restore saved DB
node mcserver.js loadDB
```

The server listens on `config.port` (default 8081). CORS is enabled for all origins.

---

## Known Limitations / TODOs

- Passwords stored in plaintext in `config.json`.
- `commsDelay = -1` uses a sinusoidal approximation of the real Earth-Mars light travel time (182–1342 seconds), calibrated to the Jan 16 2025 opposition and accurate to ~10% through 2030. No internet lookup is performed.
- `getSolNum()` uses today's date at server startup as Sol 0; if a report transmits across midnight, the Sol assignment may be incorrect.
- The `body-parser` package is used explicitly but is included in Express 4 — minor redundancy.
