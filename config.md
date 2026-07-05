# MarsComm Server Configuration Reference

All configuration lives in `config.json` in the server root directory.

---

## Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `organization` | string | yes | Organization name. Currently `"MDRS"` or `"LunAres"`. Controls app title and logo displayed by the client. |
| `clientPath` | string | yes | Relative path from the server directory to the client repo root. Used to report the client git version. |
| `port` | number | yes | TCP port the HTTP server listens on. |
| `crewNum` | number | yes | Crew/rotation number, shown in report headers and templates. |
| `missionStartDate` | string | no | Start date of Sol 1 in `YYYY-MM-DD` format (local time). If omitted, the app runs in legacy mode: no pre/post-flight phases, Sol numbering uses a rolling reference date instead of a fixed calendar date. |
| `rotationLength` | number | yes | Number of Sols in the rotation. Sol numbers run from 1 to `rotationLength`; Sol 0 is pre-flight, Sol `rotationLength+1` is post-flight. |
| `startingSolNum` | number | no | Reserved for future use. Currently unused by the server. |
| `solDuration` | string | no | Length of one Sol. `"Earth"` (default) = 86,400 s; `"Mars"` = 88,775.244 s (24 h 39 m 35 s). Affects Sol number computation and the Sol time clock displayed in the client. |
| `commsDelay` | number | yes | One-way communications delay in seconds. Set to `0` for no delay. Set to `-1` to use the real-time Earth–Mars light-travel delay computed from orbital mechanics. |
| `distributionCooldown` | number | no | Seconds to wait after the user changes the Distribution checkboxes before auto-refreshing the chat panel. Default: `2`. |
| `messageArrivalSoundCooldown` | number | no | Minimum seconds between IM arrival sound effects. Default: `180`. |
| `testMode` | boolean | no | Enables test/development features in the client (currently: Joke Mode). Default: `false`. Should be `false` for real missions. |

---

## `users` array

Each entry defines one user account.

| Field | Type | Required | Description |
|---|---|---|---|
| `role` | string | yes | Human-readable role title, e.g. `"Commander"`. Used as the display name throughout the app and in report headers. |
| `name` | string | yes | Login username (lowercase, no spaces). |
| `word` | string | yes | Password. |
| `planet` | string | yes | `"Earth"` or `"Mars"`. Determines which side of the comms delay the user is on. |
| `abbr` | string | no | Short abbreviation for the role, e.g. `"C"` for Commander. Used when constructing Chat names for multi-user chats where space is limited. If omitted, the full role name is used. |

---

## `groups` array

Groups are named sets of roles used for Distribution presets and access control.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Group name, e.g. `"Command"`. Referenced in `access` lists for reports, file folders, and in the Distribution dropdown. |
| `roles` | array of strings | yes | List of role titles belonging to this group. Must match `role` values in the `users` array exactly. |

The built-in group names `"Mission Control"` (all Earth users), `"Crew"` (all Mars users), and `"All"` (everyone) are always available and do not need to be listed here.

---

## `reports` array

Each entry defines one report type available on every Sol (or on a specific Sol).

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Report name, e.g. `"General"`. Must match the corresponding key in `reportTemplates`. |
| `access` | array of strings | no | List of role titles, group names, or built-in group names that can see this report. If omitted, the report is visible to all users. |
| `due` | number or `"daily"` | no | Sol number on which this report is due, or `"daily"` (default) to appear on every Sol. |

---

## `fileSystem.folders` array

Defines the shared file space available to users.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Folder path. Use `/` to create a subfolder hierarchy, e.g. `"Photos/EVA"` appears nested under a `Photos` parent in the folder tree. The full path string is stored on each file record. |
| `access` | array of strings | no | List of role titles, group names, or built-in group names that can see this folder. If omitted, the folder is visible to all users. |

---

## `reportTemplates` object

A map of report name to HTML template string. Keys must match the `name` fields in the `reports` array.

Template strings may contain the following placeholders, which are substituted when the user opens a new (empty) report:

| Placeholder | Replaced with |
|---|---|
| `{crewNum}` | The `crewNum` value from config |
| `{date}` | Today's Earth date in `YYYY-MM-DD` format |
| `{solNum}` | The current Sol number |

Templates may contain HTML markup and `<br>` line breaks.

---

## Example

```json
{
    "organization": "MDRS",
    "clientPath": "../misc/qooxdoo",
    "port": 8081,
    "crewNum": 300,
    "missionStartDate": "2026-11-01",
    "rotationLength": 14,
    "solDuration": "Earth",
    "commsDelay": 10,
    "distributionCooldown": 2,
    "messageArrivalSoundCooldown": 180,
    "testMode": false,
    "users": [
        { "role": "MC Director",   "name": "alice", "word": "password", "planet": "Earth", "abbr": "MCD" },
        { "role": "Commander",     "name": "bob",   "word": "password", "planet": "Mars",  "abbr": "C"   }
    ],
    "groups": [
        { "name": "Command", "roles": ["MC Director", "Commander"] }
    ],
    "reports": [
        { "name": "General",  "access": ["Mission Control", "Crew"] },
        { "name": "Medical",  "access": ["Medical"] },
        { "name": "Final",    "access": ["Mission Control", "Crew"], "due": 13 }
    ],
    "fileSystem": {
        "folders": [
            { "path": "Photos/Mission", "access": ["Mission Control", "Crew"] },
            { "path": "Photos/EVA",     "access": ["Mission Control", "Crew"] },
            { "path": "Documents",      "access": ["Mission Control", "Crew"] }
        ]
    },
    "reportTemplates": {
        "General": "Crew {crewNum} General Report {date}<br>\nCommander:<br>\n",
        "Medical": "Crew {crewNum} Medical Report {date}<br>\nMedical Officer:<br>\n",
        "Final":   "Crew {crewNum} Final Report {date}<br>\n"
    }
}
```
