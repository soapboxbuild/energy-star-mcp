import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'

const BASE_URL = 'https://portfoliomanager.energystar.gov/ws'
const PORT = parseInt(process.env.PORT ?? '3000', 10)

// ── EPA API helper ────────────────────────────────────────────────────────────

async function epaFetch(
  path: string,
  credentials: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  return fetch(url, { ...options, headers })
}

async function epaGet(path: string, credentials: string): Promise<unknown> {
  const res = await epaFetch(path, credentials)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`EPA API ${res.status} on GET ${path}: ${text}`)
  }
  return res.json()
}

async function epaPost(
  path: string,
  credentials: string,
  body: unknown
): Promise<unknown> {
  const res = await epaFetch(path, credentials, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`EPA API ${res.status} on POST ${path}: ${text}`)
  }
  return res.json()
}

// ── MCP server factory ────────────────────────────────────────────────────────

function createServer(credentials: string): McpServer {
  const server = new McpServer({
    name: 'energy-star-portfolio-manager',
    version: '0.1.0',
  })

  // 1. list_properties
  server.tool(
    'list_properties',
    'List all properties in the Portfolio Manager account',
    {},
    async () => {
      const data = (await epaGet('/property/list', credentials)) as {
        links?: { link?: Array<{ '@_id': string; '@_hint': string }> }
        response?: { links?: { link?: unknown[] } }
      }

      // PM returns a links object; each link has the property id + name
      const links =
        (data as { links?: { link?: unknown[] } })?.links?.link ?? []
      const properties = (links as Array<Record<string, unknown>>).map((l) => ({
        id: l['@_id'] ?? l.id,
        name: l['@_hint'] ?? l.name,
      }))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(properties, null, 2),
          },
        ],
      }
    }
  )

  // 2. get_property
  server.tool(
    'get_property',
    'Get property details and current ENERGY STAR score',
    { propertyId: z.string().describe('Portfolio Manager property ID') },
    async ({ propertyId }) => {
      const [details, metrics] = await Promise.all([
        epaGet(`/property/${propertyId}`, credentials),
        epaGet(`/property/${propertyId}/metrics`, credentials).catch(
          () => null
        ),
      ])

      const result = {
        property: details,
        metrics: metrics,
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // 3. get_metrics
  server.tool(
    'get_metrics',
    'Get energy metrics for a property (ENERGY STAR score, EUI, GHG emissions)',
    {
      propertyId: z.string().describe('Portfolio Manager property ID'),
      year: z
        .number()
        .optional()
        .describe('Year for metrics (defaults to last year)'),
    },
    async ({ propertyId, year }) => {
      const targetYear = year ?? new Date().getFullYear() - 1
      const data = await epaGet(
        `/property/${propertyId}/metrics?year=${targetYear}`,
        credentials
      )

      // Normalise the PM response into a flat metrics object
      const raw = data as Record<string, unknown>
      const metrics =
        raw?.metrics ??
        raw?.propertyMetrics ??
        raw?.response ??
        raw

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { year: targetYear, propertyId, metrics },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  // 4. get_meters
  server.tool(
    'get_meters',
    'List all utility meters for a property',
    { propertyId: z.string().describe('Portfolio Manager property ID') },
    async ({ propertyId }) => {
      const data = await epaGet(
        `/property/${propertyId}/meter/list`,
        credentials
      )

      const raw = data as Record<string, unknown>
      const links = (raw?.links as Record<string, unknown>)?.link ?? []
      const meters = (Array.isArray(links) ? links : [links]).map(
        (l: Record<string, unknown>) => ({
          id: l['@_id'] ?? l.id,
          name: l['@_hint'] ?? l.name,
          type: l['@_type'] ?? l.type,
          unitOfMeasure: l['@_unitOfMeasure'] ?? l.unitOfMeasure,
          inUse: l['@_inUse'] ?? l.inUse,
        })
      )

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(meters, null, 2) }],
      }
    }
  )

  // 5. submit_meter_data
  server.tool(
    'submit_meter_data',
    'Submit energy consumption data for a utility meter',
    {
      meterId: z.string().describe('Portfolio Manager meter ID'),
      startDate: z.string().describe('Start date in YYYY-MM-DD format'),
      endDate: z.string().describe('End date in YYYY-MM-DD format'),
      usage: z.number().describe('Energy usage amount'),
      cost: z.number().optional().describe('Cost in USD (optional)'),
    },
    async ({ meterId, startDate, endDate, usage, cost }) => {
      const body: Record<string, unknown> = {
        meterConsumption: {
          startDate,
          endDate,
          usage,
          ...(cost !== undefined ? { cost } : {}),
          estimatedValue: false,
        },
      }

      const result = await epaPost(
        `/meter/${meterId}/consumption`,
        credentials,
        body
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { success: true, meterId, startDate, endDate, usage, cost, result },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  // 6. get_national_median
  server.tool(
    'get_national_median',
    'Get national median EUI for a property type (e.g. "Office", "Multifamily Housing", "Retail Store")',
    {
      propertyType: z
        .string()
        .describe('Property type name, e.g. "Office", "Multifamily Housing"'),
    },
    async ({ propertyType }) => {
      // Fetch the full property use type list and filter client-side
      const data = await epaGet('/property/propertyUse/list', credentials)

      const raw = data as Record<string, unknown>
      // PM wraps this in various shapes; try to extract the list
      const types =
        (raw?.propertyUses as Record<string, unknown>)?.propertyUse ??
        (raw?.response as Record<string, unknown>)?.propertyUses ??
        raw?.propertyUse ??
        []

      const list = (Array.isArray(types) ? types : [types]) as Array<
        Record<string, unknown>
      >

      const match = list.find(
        (t) =>
          String(t.name ?? t['@_name'] ?? '').toLowerCase() ===
          propertyType.toLowerCase()
      )

      if (!match) {
        // Return available types to help the caller
        const available = list.map(
          (t) => t.name ?? t['@_name'] ?? JSON.stringify(t)
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: `Property type "${propertyType}" not found`,
                  available,
                },
                null,
                2
              ),
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                propertyType: match.name ?? match['@_name'],
                medianEUI: match.medianEUI ?? match.nationalMedianEUI,
                units: match.units ?? 'kBtu/ft²',
                raw: match,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  return server
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono()

app.post('/mcp', async (c) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader) {
    return c.json({ error: 'Missing Authorization header' }, 401)
  }

  // Accept "Bearer <base64>" where base64 = btoa(username:password)
  const credentials = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.startsWith('Basic ')
      ? authHeader.slice(6).trim()
      : null

  if (!credentials) {
    return c.json(
      {
        error:
          'Authorization header must be "Bearer <base64_credentials>" where credentials = btoa(username:password)',
      },
      401
    )
  }

  const server = createServer(credentials)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  })

  await server.connect(transport)

  // Convert Hono request to Web Standard Request
  const req = c.req.raw
  const response = await transport.handleRequest(req)
  return response
})

app.get('/health', (c) => c.json({ status: 'ok', service: 'energy-star-mcp' }))

app.get('/', (c) =>
  c.json({
    name: 'ENERGY STAR Portfolio Manager MCP Server',
    version: '0.1.0',
    endpoint: 'POST /mcp',
    auth: 'Authorization: Bearer <btoa(username:password)>',
  })
)

// ── Start ─────────────────────────────────────────────────────────────────────

serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`ENERGY STAR MCP server running on http://localhost:${info.port}`)
    console.log(`  POST /mcp  — MCP endpoint`)
    console.log(`  GET  /health — health check`)
  }
)
