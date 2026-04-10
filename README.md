# cib7-mcp

MCP tool for investigating CIB Seven process instances. Gives Claude comprehensive knowledge of CIB Seven REST APIs with live execution and Keycloak authentication.

## Features

- **Investigation tools** — process instances, counts, daily/weekly/monthly stats, incidents, activity history, variables, BPMN XML, jobs
- **Semantic descriptions** — Claude understands what each field means operationally, not just raw endpoint data
- **BPMN introspection** — fetch process definition XML, Claude reasons about expected vs actual execution path
- **Keycloak auth** — OIDC client credentials flow with automatic token refresh
- **Variable redaction** — configurable regex patterns to hide sensitive data
- **Diagnostic prompts** — `diagnose_stuck_process` and `incident_report` workflows

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cib7": {
      "command": "npx",
      "args": ["cib7-mcp"],
      "env": {
        "CIB7_URL": "http://localhost:6009/rest"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add cib7-mcp -- npx cib7-mcp
```

Then set the environment variable `CIB7_URL` to your CIB Seven instance.

## Configuration

All configuration is via environment variables.

| Variable | Required | Description |
|----------|----------|-------------|
| `CIB7_URL` | Yes | CIB Seven REST API URL (e.g., `http://localhost:6009/rest`) |
| `KEYCLOAK_URL` | No | Keycloak server URL (e.g., `https://keycloak.example.com`) |
| `KEYCLOAK_REALM` | No | Keycloak realm name |
| `KEYCLOAK_CLIENT_ID` | No | Keycloak client ID |
| `KEYCLOAK_CLIENT_SECRET` | No | Keycloak client secret |
| `CIB7_REDACT_PATTERNS` | No | Comma-delimited regex patterns for variable redaction (e.g., `password.*,secret.*,token.*`) |

If any `KEYCLOAK_*` variable is set, all four must be provided. If none are set, the tool runs in unauthenticated mode.

### With Keycloak

```json
{
  "mcpServers": {
    "cib7": {
      "command": "npx",
      "args": ["cib7-mcp"],
      "env": {
        "CIB7_URL": "https://your-instance.com/rest",
        "KEYCLOAK_URL": "https://your-keycloak.com",
        "KEYCLOAK_REALM": "your-realm",
        "KEYCLOAK_CLIENT_ID": "mcp-client",
        "KEYCLOAK_CLIENT_SECRET": "your-secret",
        "CIB7_REDACT_PATTERNS": "password.*,secret.*,token.*,creditCard.*"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `get_process_instance` | Look up a process instance by ID — state, definition, business key |
| `list_process_instances` | Search process instances by definition, business key, state, start/end date, incident status, with sorting |
| `count_process_instances` | Count matching instances without fetching rows. Same filter surface as `list_process_instances`. |
| `process_instance_stats` | Daily / weekly / monthly histogram of started instances. Returns per-period counts + summary (total, average, max, min). |
| `list_incidents` | List open incidents, optionally filtered by process instance |
| `get_activity_history` | Execution trace — every activity that ran, in order |
| `get_process_variables` | All variables for a process instance (with redaction) |
| `get_process_definition_xml` | BPMN XML model (diagram elements stripped for readability) |
| `get_job_details` | Job execution details — retries, exception messages |

## Prompts

| Prompt | Description |
|--------|-------------|
| `diagnose_stuck_process` | Step-by-step diagnostic for a stuck process instance |
| `incident_report` | Comprehensive report of all open incidents with root cause analysis |

## Statistics & counting

Three tools work together for volume questions without pulling back rows:

- **`list_process_instances`** — when you actually need the records. Supports filtering by definition key (single or multi), definition name, business key, `startedBy`, active/suspended/completed state, `startedAfter`/`startedBefore`, `finishedAfter`/`finishedBefore`, `withIncidents`, `incidentStatus`, plus `sortBy`/`sortOrder` and pagination via `maxResults`/`firstResult`.
- **`count_process_instances`** — same filter surface, returns just `{ count: N }`. Use this for "how many?" questions so the engine never has to serialize rows.
- **`process_instance_stats`** — daily / weekly / monthly histogram of started instances over a date range. Takes `from`, `to`, and `periodUnit` (`day`, `week`, or `month`). Internally loops `count_process_instances` over date windows in parallel, so a 30-day daily histogram is 30 cheap count calls, not a row fetch.

`process_instance_stats` returns each bucket plus a summary with total, average-per-bucket, and the busiest/quietest bucket:

```json
{
  "from": "2025-03-01T00:00:00.000Z",
  "to":   "2025-03-31T00:00:00.000Z",
  "periodUnit": "day",
  "bucketCount": 30,
  "summary": {
    "total": 4820,
    "average": 160.67,
    "max": { "period": "2025-03-17", "count": 412 },
    "min": { "period": "2025-03-09", "count": 3 }
  },
  "periods": [
    { "period": "2025-03-01", "start": "...", "end": "...", "count": 145 },
    { "period": "2025-03-02", "start": "...", "end": "...", "count": 160 }
  ]
}
```

A few things to know:

- Windows are right-open `[start, nextStart)`, so no bucket double-counts the boundary instant.
- Week windows advance by 7 days from `from`. They are **not** aligned to Monday unless `from` is itself a Monday — pick your `from` accordingly if you want ISO weeks.
- Month windows advance by calendar month (handles variable-length months correctly).
- A safety cap of 500 buckets protects against runaway queries. Raise it with `maxBuckets` if you genuinely need a longer range, or use a coarser `periodUnit`.

## Example Usage

Ask Claude:

- "Is process `abc-123` stuck?"
- "Show me all open incidents"
- "What's the BPMN definition for process definition `orderProcess:1:456`?"
- "Generate an incident report"
- "How many instances of `orderProcess` are running right now?"
- "How many `orderProcess` instances finished with incidents last week?"
- "Show me daily volume for `orderProcess` over the last 30 days — which day was busiest?"
- "Give me a monthly histogram of all process starts this year."

## Development

```bash
npm install
npm run build
npm test
```

Requires Node.js 18+.

## License

MIT
