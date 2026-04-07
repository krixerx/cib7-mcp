# cib7-mcp

MCP tool for investigating CIB Seven process instances. Gives Claude comprehensive knowledge of CIB Seven REST APIs with live execution and Keycloak authentication.

## Features

- **7 investigation tools** — process instances, incidents, activity history, variables, BPMN XML, jobs
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
| `list_process_instances` | Search process instances by definition key, business key, or state |
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

## Example Usage

Ask Claude:

- "Is process `abc-123` stuck?"
- "Show me all open incidents"
- "What's the BPMN definition for process definition `orderProcess:1:456`?"
- "Generate an incident report"

## Development

```bash
npm install
npm run build
npm test
```

Requires Node.js 18+.

## License

MIT
