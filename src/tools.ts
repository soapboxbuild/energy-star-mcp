import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { EspmClient, EspmError } from './espm-client.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

async function wrap(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn()
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (err) {
    const msg = err instanceof EspmError
      ? `ESPM API error (${err.statusCode}): ${err.message}`
      : `Error: ${err instanceof Error ? err.message : String(err)}`
    return { content: [{ type: 'text', text: msg }], isError: true }
  }
}

export function registerTools(server: McpServer, client: EspmClient): void {
  server.tool(
    'get_account',
    'Verify Portfolio Manager credentials and return the username. Call this first to confirm the connection works before listing properties.',
    {},
    () => wrap(() => client.getAccount()),
  )

  server.tool(
    'list_properties',
    'List all properties in the PM account. Returns propertyId and name for each.',
    {},
    () => wrap(() => client.listProperties()),
  )

  server.tool(
    'get_property',
    'Get full details for a specific ESPM property — address, primary function, gross floor area, year built.',
    { propertyId: z.number().int().positive().describe('ESPM property ID from list_properties') },
    ({ propertyId }) => wrap(() => client.getProperty(propertyId)),
  )

  server.tool(
    'get_metrics',
    'Get ENERGY STAR score, site EUI, source EUI, GHG emissions, and water use for a property. energyStarScore is null when scoreEligible is false — not all property types qualify for a numeric score.',
    {
      propertyId: z.number().int().positive().describe('ESPM property ID'),
      year: z.number().int().min(2000).max(2035).optional()
        .describe('Year for metrics. Defaults to current calendar year.'),
    },
    ({ propertyId, year }) => wrap(() => client.getMetrics(propertyId, year)),
  )

  server.tool(
    'list_meters',
    'List energy meter types for a property (Electricity, Natural Gas, Steam, etc.) with consumption summaries.',
    { propertyId: z.number().int().positive().describe('ESPM property ID') },
    ({ propertyId }) => wrap(() => client.listMeters(propertyId)),
  )

  server.tool(
    'get_meter_consumption',
    'Get monthly energy consumption for a property, broken down by fuel type (Electric - Grid, Natural Gas, etc.). Returns GJ values plus pre-converted kWh (electricity) and therms (gas). Use this to calibrate Audette — pass the monthly data directly to Audette\'s add_utility_data tool.',
    {
      propertyId: z.number().int().positive().describe('ESPM property ID'),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
        .describe('Start date filter YYYY-MM-DD. Omit for all available data.'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
        .describe('End date filter YYYY-MM-DD. Omit for all available data.'),
    },
    ({ propertyId, startDate, endDate }) => wrap(() => client.getMeterConsumption(propertyId, startDate, endDate)),
  )
}
