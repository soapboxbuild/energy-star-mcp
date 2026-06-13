import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'

const BASE_URL = 'https://portfoliomanager.energystar.gov/ws'
const PORT = parseInt(process.env.PORT ?? '3000', 10)

// Central Soapbox ESPM account — stored as env vars, used for all data fetches.
// Users share their properties with this account during connect_property.
const CENTRAL_USERNAME = process.env.ESPM_USERNAME ?? ''
const CENTRAL_PASSWORD = process.env.ESPM_PASSWORD ?? ''
const CENTRAL_CREDS = Buffer.from(`${CENTRAL_USERNAME}:${CENTRAL_PASSWORD}`).toString('base64')

async function epaFetch(path: string, credentials: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    },
  })
}

async function epaGet(path: string, credentials = CENTRAL_CREDS): Promise<unknown> {
  const res = await epaFetch(path, credentials)
  if (!res.ok) throw new Error(`EPA ${res.status} GET ${path}: ${await res.text()}`)
  return res.json()
}

async function epaPost(path: string, credentials = CENTRAL_CREDS, body: unknown): Promise<unknown> {
  const res = await epaFetch(path, credentials, { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`EPA ${res.status} POST ${path}: ${await res.text()}`)
  return res.json()
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'energy-star-portfolio-manager', version: '0.2.0' })

  // ── One-time setup: user provides their own PM credentials to find properties
  // and share them with the central Soapbox account. After this, only the
  // property ID is needed — user credentials are never stored.
  server.tool(
    'connect_property',
    'One-time setup: authenticate with user\'s PM credentials to list their properties, then share the selected property with the central Soapbox ESPM account. Returns propertyId to store as the connector identifier.',
    {
      userUsername: z.string().describe('User\'s Portfolio Manager username'),
      userPassword: z.string().describe('User\'s Portfolio Manager password'),
      propertyNameSearch: z.string().optional().describe('Search term to filter properties by name (optional — omit to list all)'),
    },
    async ({ userUsername, userPassword, propertyNameSearch }) => {
      const userCreds = Buffer.from(`${userUsername}:${userPassword}`).toString('base64')

      // 1. List user's properties
      const data = await epaGet('/property/list', userCreds) as { links?: { link?: unknown[] } }
      const links = data?.links?.link ?? []
      const properties = (Array.isArray(links) ? links : [links]) as Array<Record<string, unknown>>

      const filtered = propertyNameSearch
        ? properties.filter(p => String(p['@_hint'] ?? p.name ?? '').toLowerCase().includes(propertyNameSearch.toLowerCase()))
        : properties

      const propertyList = filtered.map(p => ({
        id: String(p['@_id'] ?? p.id ?? ''),
        name: String(p['@_hint'] ?? p.name ?? ''),
      }))

      if (propertyList.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No properties found', searched: propertyNameSearch }) }] }
      }

      // 2. Share the first matched property with the central Soapbox account
      if (propertyList.length === 1 && CENTRAL_USERNAME) {
        const propertyId = propertyList[0].id
        try {
          await epaPost(`/property/${propertyId}/share`, userCreds, {
            accountUsername: CENTRAL_USERNAME,
            level: 'READ_ONLY',
          })
        } catch {
          // Sharing may fail if already shared — non-fatal
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            properties: propertyList,
            instruction: propertyList.length > 1
              ? 'Multiple properties found. Run connect_property again with propertyNameSearch to narrow to one, then call share_property with the chosen propertyId.'
              : `Property connected. Store propertyId: ${propertyList[0].id}`,
          }, null, 2),
        }],
      }
    }
  )

  server.tool(
    'share_property',
    'Share a specific PM property with the central Soapbox ESPM account (called after connect_property if multiple properties were found).',
    {
      userUsername: z.string(),
      userPassword: z.string(),
      propertyId: z.string().describe('PM property ID to share'),
    },
    async ({ userUsername, userPassword, propertyId }) => {
      const userCreds = Buffer.from(`${userUsername}:${userPassword}`).toString('base64')
      await epaPost(`/property/${propertyId}/share`, userCreds, {
        accountUsername: CENTRAL_USERNAME,
        level: 'READ_ONLY',
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, propertyId, sharedWith: CENTRAL_USERNAME }) }] }
    }
  )

  // ── Data tools — all use central credentials, propertyId from connector ──────

  server.tool(
    'get_property',
    'Get property details and current ENERGY STAR score using the stored propertyId.',
    { propertyId: z.string() },
    async ({ propertyId }) => {
      const [details, metrics] = await Promise.all([
        epaGet(`/property/${propertyId}`),
        epaGet(`/property/${propertyId}/metrics`).catch(() => null),
      ])
      return { content: [{ type: 'text' as const, text: JSON.stringify({ property: details, metrics }, null, 2) }] }
    }
  )

  server.tool(
    'get_metrics',
    'Get energy metrics for a property: ENERGY STAR score, site EUI (kBtu/ft²), source EUI, total GHG emissions (tCO2e).',
    {
      propertyId: z.string(),
      year: z.number().optional().describe('Year (defaults to previous year)'),
    },
    async ({ propertyId, year }) => {
      const targetYear = year ?? new Date().getFullYear() - 1
      const data = await epaGet(`/property/${propertyId}/metrics?year=${targetYear}`)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ year: targetYear, propertyId, metrics: data }, null, 2) }] }
    }
  )

  server.tool(
    'get_meters',
    'List all utility meters for a property.',
    { propertyId: z.string() },
    async ({ propertyId }) => {
      const data = await epaGet(`/property/${propertyId}/meter/list`) as { links?: { link?: unknown[] } }
      const links = data?.links?.link ?? []
      const meters = (Array.isArray(links) ? links : [links]).map((l) => { const m = l as Record<string, unknown>; return ({
        id: m['@_id'] ?? m.id,
        name: m['@_hint'] ?? m.name,
        type: m['@_type'],
        unitOfMeasure: m['@_unitOfMeasure'],
      })})
      return { content: [{ type: 'text' as const, text: JSON.stringify(meters, null, 2) }] }
    }
  )

  server.tool(
    'submit_meter_data',
    'Submit energy consumption data for a utility meter.',
    {
      meterId: z.string(),
      startDate: z.string().describe('YYYY-MM-DD'),
      endDate: z.string().describe('YYYY-MM-DD'),
      usage: z.number(),
      cost: z.number().optional(),
    },
    async ({ meterId, startDate, endDate, usage, cost }) => {
      const result = await epaPost(`/meter/${meterId}/consumption`, CENTRAL_CREDS, {
        meterConsumption: { startDate, endDate, usage, estimatedValue: false, ...(cost !== undefined ? { cost } : {}) },
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, meterId, result }, null, 2) }] }
    }
  )

  server.tool(
    'get_energy_star_score',
    'Get the current ENERGY STAR score (1-100) and national percentile for a property.',
    { propertyId: z.string() },
    async ({ propertyId }) => {
      const data = await epaGet(`/property/${propertyId}/metrics`) as Record<string, unknown>
      const score = (data as Record<string, unknown>)?.score ?? (data as Record<string, unknown>)?.energyStarScore
      return { content: [{ type: 'text' as const, text: JSON.stringify({ propertyId, energyStarScore: score, rawMetrics: data }, null, 2) }] }
    }
  )

  return server
}

// ── Hono HTTP app ─────────────────────────────────────────────────────────────

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true, service: 'energy-star-mcp', version: '0.2.0' }))

app.post('/mcp', async (c) => {
  if (!CENTRAL_USERNAME || !CENTRAL_PASSWORD) {
    return c.json({ error: 'ESPM_USERNAME and ESPM_PASSWORD env vars are required' }, 500)
  }
  const server = createServer()
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`energy-star-mcp running on :${PORT}`)
  if (!CENTRAL_USERNAME) console.warn('WARNING: ESPM_USERNAME not set')
})
