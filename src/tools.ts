import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { EspmClient, EspmError } from './espm-client.js'
import { euiPercentile, cbecMedian, VALID_ASSET_CLASSES, CBECS_CITATION, type AssetClass } from './cbecs-benchmarks.js'

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
    'List all properties in the PM account. Returns propertyId, name, and address (address, city, state, postalCode) for each.',
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

  // ── Write tools (Official REST API) ───────────────────────────────────────────

  server.tool(
    'list_property_types',
    'List valid primary function types for use when creating a new ESPM property.',
    {},
    () => wrap(() => client.listPropertyTypes()),
  )

  server.tool(
    'create_property',
    'Create a new property in Portfolio Manager. Returns the propertyId. Call list_property_types first to pick the correct primaryFunction.',
    {
      name: z.string().describe('Property name'),
      primaryFunction: z.string().describe('e.g. "Multifamily Housing", "Office". Call list_property_types for valid values.'),
      address: z.string().describe('Street address'),
      city: z.string(),
      state: z.string().describe('2-letter US state code or full name for international'),
      postalCode: z.string(),
      country: z.string().default('US'),
      yearBuilt: z.number().int().min(1800).max(2030).optional(),
      grossFloorArea: z.number().positive().optional(),
      grossFloorAreaUnits: z.enum(['Square Feet', 'Square Metres']).default('Square Metres'),
      constructionStatus: z.enum(['Existing', 'New Construction']).default('Existing'),
    },
    (params) => wrap(() => client.createProperty(params)),
  )

  server.tool(
    'update_property',
    'Update attributes of an existing ESPM property. Only provided fields are changed.',
    {
      propertyId: z.number().int().positive(),
      name: z.string().optional(),
      primaryFunction: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
      yearBuilt: z.number().int().min(1800).max(2030).optional(),
      grossFloorArea: z.number().positive().optional(),
      grossFloorAreaUnits: z.enum(['Square Feet', 'Square Metres']).optional(),
      constructionStatus: z.enum(['Existing', 'New Construction']).optional(),
    },
    ({ propertyId, ...params }) => wrap(() => client.updateProperty(propertyId, params)),
  )

  server.tool(
    'add_meter',
    'Add an energy or water meter to a property. Returns meterId. Call submit_meter_data after to enter consumption.',
    {
      propertyId: z.number().int().positive(),
      name: z.string().describe('Meter name, e.g. "Main Electric Meter"'),
      type: z.enum([
        'Electric - Grid', 'Natural Gas', 'Municipal Potable Water',
        'Fuel Oil (No. 2)', 'Propane', 'District Steam', 'District Hot Water',
        'District Chilled Water - Electric', 'Wood', 'Coal - Anthracite',
        'Coal - Bituminous', 'Coke',
      ]),
      units: z.string().describe('Unit of measure, e.g. "kWh", "GJ", "therms", "ccf", "Gallons (US)"'),
      firstBillDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date of first bill YYYY-MM-DD'),
      inUse: z.boolean().default(true),
    },
    (params) => wrap(() => client.addMeter(params.propertyId, params)),
  )

  server.tool(
    'list_meters_rest',
    'List all meters for a property via the official REST API — includes meter IDs needed for submit_meter_data.',
    { propertyId: z.number().int().positive() },
    ({ propertyId }) => wrap(() => client.listMetersRest(propertyId)),
  )

  server.tool(
    'submit_meter_data',
    'Submit monthly energy consumption entries for a meter. Call list_meters_rest first to get the meterId.',
    {
      meterId: z.number().int().positive().describe('Meter ID from add_meter or list_meters_rest'),
      entries: z.array(z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        usage: z.number().describe('Energy usage in the meter\'s unit of measure'),
        cost: z.number().optional(),
        estimatedValue: z.boolean().default(false),
      })).min(1),
    },
    ({ meterId, entries }) => wrap(() => client.submitMeterData(meterId, entries)),
  )

  server.tool(
    'share_property',
    'Share a property with another Portfolio Manager account. Useful for sharing with Soapbox or a consultant.',
    {
      propertyId: z.number().int().positive(),
      toUsername: z.string().describe('PM username of the recipient'),
      permission: z.enum(['Read Only', 'Read Write', 'None']),
      canShare: z.boolean().default(false),
      includeMeters: z.boolean().default(true),
    },
    (params) => wrap(() => client.shareProperty(params.propertyId, params)),
  )

  server.tool(
    'get_score_details',
    'Get ENERGY STAR score, EUIs, and GHG emissions via the official API. More reliable than get_metrics for certification workflows.',
    { propertyId: z.number().int().positive() },
    ({ propertyId }) => wrap(() => client.getScoreDetails(propertyId)),
  )

  server.tool(
    'check_data_quality',
    'Run a data quality check before applying for ENERGY STAR certification. Identifies missing or inconsistent data.',
    { propertyId: z.number().int().positive() },
    ({ propertyId }) => wrap(() => client.checkDataQuality(propertyId)),
  )

  // ── Benchmarking tools (CBECS 2018 static dataset) ───────────────────────────

  server.tool(
    'get_peer_percentile',
    `Return the EUI efficiency percentile and ENERGY STAR score percentile for a property vs. its asset-class peers. ` +
    `EUI percentile = percentage of peer buildings with equal or higher site EUI (higher = more efficient). ` +
    `ENERGY STAR score already represents a percentile directly when scoreEligible is true. ` +
    `Valid asset classes: ${VALID_ASSET_CLASSES.join(', ')}.`,
    {
      propertyId: z.number().int().positive().describe('ESPM property ID from list_properties'),
      assetClass: z.enum(VALID_ASSET_CLASSES as [AssetClass, ...AssetClass[]])
        .describe('Asset class for peer group selection'),
      year: z.number().int().min(2000).max(2035).optional()
        .describe('Metrics year. Defaults to current calendar year.'),
    },
    ({ propertyId, assetClass, year }) => wrap(async () => {
      const metrics = await client.getMetrics(propertyId, year)
      const siteEui = metrics.siteEui as number | null
      const esScore = metrics.energyStarScore as number | null

      const euiPctile = siteEui != null ? euiPercentile(siteEui, assetClass) : null
      const median = cbecMedian(assetClass)

      return {
        propertyId,
        assetClass,
        year: metrics.year,
        siteEui,
        euiPercentile: euiPctile,
        euiVsMedian: siteEui != null
          ? { cbecMedian: median, pctDiff: Math.round(((siteEui - median) / median) * 100) }
          : null,
        energyStarScore: esScore,
        energyStarScorePercentile: esScore,
        scoreEligible: metrics.scoreEligible,
        dataSource: CBECS_CITATION,
        note: 'EUI percentile derived from CBECS 2018 national distribution using linear interpolation between published decile/quartile breakpoints.',
      }
    }),
  )

  server.tool(
    'get_portfolio_benchmarks',
    `Batch peer-percentile ranking for a portfolio. Returns EUI and ENERGY STAR score percentiles for all properties, ` +
    `sorted by EUI efficiency percentile descending (best performers first), ` +
    `plus portfolio-level median, top-quartile, and bottom-quartile EUI. ` +
    `Handles up to 200 properties. Valid asset classes: ${VALID_ASSET_CLASSES.join(', ')}.`,
    {
      propertyIds: z.array(z.number().int().positive()).min(1).max(200)
        .describe('List of ESPM property IDs'),
      assetClass: z.enum(VALID_ASSET_CLASSES as [AssetClass, ...AssetClass[]])
        .describe('Asset class applied to all properties in the batch'),
      year: z.number().int().min(2000).max(2035).optional()
        .describe('Metrics year. Defaults to current calendar year.'),
    },
    ({ propertyIds, assetClass, year }) => wrap(async () => {
      // Fetch all properties in parallel (ESPM rate-limits at ~10 concurrent; use batches of 10)
      const BATCH = 10
      const results: Array<{ propertyId: number; siteEui: number | null; energyStarScore: number | null; euiPercentile: number | null; error?: string }> = []

      for (let i = 0; i < propertyIds.length; i += BATCH) {
        const batch = propertyIds.slice(i, i + BATCH)
        const settled = await Promise.allSettled(
          batch.map(async (id) => {
            const metrics = await client.getMetrics(id, year)
            const siteEui = metrics.siteEui as number | null
            return {
              propertyId: id,
              siteEui,
              energyStarScore: metrics.energyStarScore as number | null,
              euiPercentile: siteEui != null ? euiPercentile(siteEui, assetClass) : null,
            }
          }),
        )
        for (let j = 0; j < batch.length; j++) {
          const s = settled[j]
          if (s.status === 'fulfilled') {
            results.push(s.value)
          } else {
            results.push({ propertyId: batch[j], siteEui: null, energyStarScore: null, euiPercentile: null, error: String(s.reason) })
          }
        }
      }

      // Sort by euiPercentile descending (best first), nulls last
      results.sort((a, b) => {
        if (a.euiPercentile == null && b.euiPercentile == null) return 0
        if (a.euiPercentile == null) return 1
        if (b.euiPercentile == null) return -1
        return b.euiPercentile - a.euiPercentile
      })

      // Compute portfolio statistics from non-null EUI values
      const validEuis = results.map(r => r.siteEui).filter((v): v is number => v != null).sort((a, b) => a - b)
      const median = cbecMedian(assetClass)

      const portfolioMedianEui = validEuis.length > 0
        ? validEuis[Math.floor(validEuis.length / 2)]
        : null
      const topQuartileEui = validEuis.length > 0
        ? validEuis[Math.floor(validEuis.length * 0.25)]
        : null
      const bottomQuartileEui = validEuis.length > 0
        ? validEuis[Math.floor(validEuis.length * 0.75)]
        : null

      return {
        assetClass,
        year: year ?? new Date().getFullYear(),
        totalProperties: propertyIds.length,
        successCount: results.filter(r => r.siteEui != null).length,
        properties: results,
        portfolioSummary: {
          medianSiteEui: portfolioMedianEui,
          topQuartileSiteEui: topQuartileEui,
          bottomQuartileSiteEui: bottomQuartileEui,
          cbecNationalMedian: median,
          portfolioVsNationalMedianPct: portfolioMedianEui != null
            ? Math.round(((portfolioMedianEui - median) / median) * 100)
            : null,
        },
        dataSource: CBECS_CITATION,
      }
    }),
  )
}
