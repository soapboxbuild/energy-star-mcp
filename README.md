# ENERGY STAR Portfolio Manager MCP Server

An MCP server that wraps the [EPA ENERGY STAR Portfolio Manager REST API](https://portfoliomanager.energystar.gov/webservices/), enabling AI assistants to query and update building energy data.

## Prerequisites

1. **Portfolio Manager account** — sign up at [energystar.gov](https://portfoliomanager.energystar.gov/pm/login)
2. **Web Services access** — enable in PM under *Account Settings → Web Services*

## Authentication

The server uses HTTP Basic Auth forwarded to the EPA API. Encode your credentials:

```js
const credentials = btoa('your_pm_username:your_pm_password')
// => e.g. "dXNlcm5hbWU6cGFzc3dvcmQ="
```

Pass as a Bearer token on every MCP request:

```
Authorization: Bearer dXNlcm5hbWU6cGFzc3dvcmQ=
```

## Available Tools

| Tool | Description |
|------|-------------|
| `list_properties` | List all properties in the PM account |
| `get_property` | Get property details + current ENERGY STAR score |
| `get_metrics` | Get energy metrics (EUI, GHG, score) for a year |
| `get_meters` | List utility meters for a property |
| `submit_meter_data` | Submit energy consumption data for a meter |
| `get_national_median` | Get national median EUI for a property type |

## Running locally

```bash
npm install
npm run dev        # tsx watch mode
# or
npm run build && npm start
```

Server runs on `http://localhost:3000` by default. Override with `PORT` env var.

## Deploying to Railway

```bash
railway login
railway init
railway up
```

Or use the one-liner after repo creation:

```bash
railway link <project-id> && railway up
```

## Adding to Soapbox as a Connector

1. Deploy to Railway and copy the public URL (e.g. `https://energy-star-mcp.up.railway.app`)
2. In Soapbox admin, add a new MCP connector:
   - **URL**: `https://energy-star-mcp.up.railway.app/mcp`
   - **Auth header**: `Authorization: Bearer <btoa(username:password)>`
3. Assign to agents that need building energy data access

## EPA API Reference

- [PM Web Services documentation](https://portfoliomanager.energystar.gov/webservices/home)
- [API test environment](https://portfoliomanager.energystar.gov/webservices/home/test)
- [ENERGY STAR score methodology](https://www.energystar.gov/buildings/benchmark/understand_metrics/how_score_calculated)
