import { createHash } from 'node:crypto'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'

const PM_BASE = 'https://portfoliomanager.energystar.gov'
const WS_BASE = 'https://portfoliomanager.energystar.gov/ws' // Official REST API (Basic Auth + XML)
const SESSION_TTL_MS = 25 * 60 * 1000 // 25 min — PM sessions last ~30 min

// Process-level session cache: credentialHash → { cookie, expiresAt }
// Cleared on server restart. Safe: each entry is keyed to one user's credentials.
const sessionCache = new Map<string, { cookie: string; expiresAt: number }>()

export class EspmError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message)
    this.name = 'EspmError'
  }
}

/**
 * ESPM client using session-based auth against the PM web interface.
 * Works for any PM user — no EPA service-provider registration or IP allowlisting required.
 *
 * Auth flow:
 *   1. GET /pm/login → capture JSESSIONID + _csrf token
 *   2. POST /pm/j_spring_security_check with credentials + _csrf → get authenticated session
 *   3. Use session cookie for all data calls to internal PM JSON endpoints
 */
export class EspmClient {
  private readonly username: string
  private readonly password: string
  private readonly cacheKey: string
  private sessionCookie: string | null = null

  constructor(authHeader: string) {
    // Soapbox proxy sends: Authorization: Bearer username:password
    // The credential may be plain text OR already base64-encoded.
    const raw = authHeader.replace(/^Bearer\s+/i, '').trim()
    let cred = raw
    // Detect pre-encoded base64: if decoding gives printable ASCII with a colon, use decoded form
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8')
      if (decoded.includes(':') && /^[\x20-\x7E]+$/.test(decoded)) cred = decoded
    } catch { /* use raw */ }

    const colonIdx = cred.indexOf(':')
    this.username = colonIdx >= 0 ? cred.slice(0, colonIdx) : cred
    this.password = colonIdx >= 0 ? cred.slice(colonIdx + 1) : ''
    this.cacheKey = createHash('sha256').update(cred).digest('hex')

    // Restore cached session if still valid
    const cached = sessionCache.get(this.cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      this.sessionCookie = cached.cookie
    }
  }

  private async login(): Promise<void> {
    // Direct POST — PM sets SESSION cookie on the login response itself, no prior GET needed
    const res = await fetch(`${PM_BASE}/pm/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 PortfolioManager-MCP/1.0',
        'Referer': `${PM_BASE}/pm/login`,
      },
      body: new URLSearchParams({ username: this.username, password: this.password }).toString(),
    })

    // Node.js 22 fetch: use getSetCookie() to read all Set-Cookie headers
    const cookies: string[] = typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : [res.headers.get('set-cookie') ?? '']

    const sessionCookie = cookies.find(c => c.startsWith('SESSION='))
    const sessionId = sessionCookie?.match(/SESSION=([^;]+)/)?.[1]

    if (!sessionId) throw new EspmError('Could not establish PM session — check credentials', 500)

    // Success: location redirects to /pm/ or /pm/home
    // Failure: location contains "error" or redirects back to /pm/login
    const location = res.headers.get('location') ?? ''
    if (!location || location.includes('error') || /\/pm\/login[?#]/.test(location)) {
      throw new EspmError('Invalid Portfolio Manager credentials', 401)
    }

    this.sessionCookie = `SESSION=${sessionId}`
    sessionCache.set(this.cacheKey, { cookie: this.sessionCookie, expiresAt: Date.now() + SESSION_TTL_MS })
  }

  private async pmFetch(path: string): Promise<Response> {
    if (!this.sessionCookie) await this.login()

    const res = await fetch(`${PM_BASE}${path}`, {
      headers: {
        Cookie: this.sessionCookie!,
        Accept: 'application/json, text/javascript, */*',
        'User-Agent': 'Mozilla/5.0 PortfolioManager-MCP/1.0',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })

    if (res.status === 403 || res.status === 302 || res.url.includes('/pm/login')) {
      // Session expired — clear cache, re-login once and retry
      this.sessionCookie = null
      sessionCache.delete(this.cacheKey)
      await this.login()
      return fetch(`${PM_BASE}${path}`, {
        headers: {
          Cookie: this.sessionCookie!,
          Accept: 'application/json, text/javascript, */*',
          'User-Agent': 'Mozilla/5.0 PortfolioManager-MCP/1.0',
          'X-Requested-With': 'XMLHttpRequest',
        },
      })
    }

    return res
  }

  // ── Official REST API (Basic Auth + XML) ─────────────────────────────────────
  private get basicAuth(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`
  }

  private async wsGet(path: string): Promise<any> {
    const res = await fetch(`${WS_BASE}${path}`, {
      headers: { Authorization: this.basicAuth, Accept: 'application/xml', 'User-Agent': 'PortfolioManager-MCP/1.0' },
    })
    if (!res.ok) throw new EspmError(`REST API error on GET ${path}: HTTP ${res.status}`, res.status)
    const xml = await res.text()
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: true })
    return parser.parse(xml)
  }

  private async wsPost(path: string, xmlBody: string): Promise<any> {
    const res = await fetch(`${WS_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: this.basicAuth, 'Content-Type': 'application/xml', Accept: 'application/xml', 'User-Agent': 'PortfolioManager-MCP/1.0' },
      body: xmlBody,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new EspmError(`REST API error on POST ${path}: HTTP ${res.status} — ${body.slice(0, 300)}`, res.status)
    }
    const xml = await res.text()
    if (!xml.trim()) return { ok: true }
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: true })
    return parser.parse(xml)
  }

  private async wsPut(path: string, xmlBody: string): Promise<any> {
    const res = await fetch(`${WS_BASE}${path}`, {
      method: 'PUT',
      headers: { Authorization: this.basicAuth, 'Content-Type': 'application/xml', Accept: 'application/xml', 'User-Agent': 'PortfolioManager-MCP/1.0' },
      body: xmlBody,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new EspmError(`REST API error on PUT ${path}: HTTP ${res.status} — ${body.slice(0, 300)}`, res.status)
    }
    const xml = await res.text()
    if (!xml.trim()) return { ok: true }
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: true })
    return parser.parse(xml)
  }

  private async wsDelete(path: string): Promise<void> {
    const res = await fetch(`${WS_BASE}${path}`, {
      method: 'DELETE',
      headers: { Authorization: this.basicAuth, 'User-Agent': 'PortfolioManager-MCP/1.0' },
    })
    if (!res.ok) throw new EspmError(`REST API error on DELETE ${path}: HTTP ${res.status}`, res.status)
  }

  async getAccount(): Promise<{ username: string }> {
    // Login validates credentials; return the username
    if (!this.sessionCookie) await this.login()
    return { username: this.username }
  }

  async listProperties(): Promise<Array<{ propertyId: number; name: string; address: string | null; city: string | null; state: string | null; postalCode: string | null }>> {
    const res = await this.pmFetch(`/pm/account/dashboardView?_=${Date.now()}`)
    if (!res.ok) throw new EspmError(`Failed to list properties: HTTP ${res.status}`, res.status)
    const data = await res.json() as any
    const props: any[] = data?.properties ?? []
    const basic = props.map(p => ({ propertyId: Number(p.id), name: String(p.name ?? p.id) }))

    // Enrich each property with address from REST API (in parallel, capped at 10 concurrent)
    const enriched: Array<{ propertyId: number; name: string; address: string | null; city: string | null; state: string | null; postalCode: string | null }> = []
    const CONCURRENCY = 10
    for (let i = 0; i < basic.length; i += CONCURRENCY) {
      const batch = basic.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(async (p) => {
        try {
          const xml = await this.wsGet(`/property/${p.propertyId}`)
          const addr = xml?.property?.address ?? null
          return {
            ...p,
            address: addr?.['@_address1'] ?? null,
            city: addr?.['@_city'] ?? null,
            state: addr?.['@_state'] ?? null,
            postalCode: addr?.['@_postalCode'] ?? null,
          }
        } catch {
          return { ...p, address: null, city: null, state: null, postalCode: null }
        }
      }))
      enriched.push(...results)
    }
    return enriched
  }

  async getProperty(propertyId: number): Promise<Record<string, unknown>> {
    const [detail, xml] = await Promise.all([
      this.pmFetch(`/pm/property/${propertyId}/detailsTabJson?_=${Date.now()}`).then(r => r.ok ? r.json() as any : null).catch(() => null),
      this.wsGet(`/property/${propertyId}`).catch(() => null),
    ])
    const addr = xml?.property?.address ?? null
    return {
      propertyId,
      primaryFunction: detail?.propertyUseTypesList ? Object.values(detail.propertyUseTypesList).join(', ') : null,
      grossFloorArea: detail?.propertyGFA?.value ? Number(detail.propertyGFA.value) : null,
      grossFloorAreaUnits: detail?.propertyGFA?.unitOfMeasure ?? 'Square Metres',
      notes: detail?.notes?.value ?? null,
      address: addr?.['@_address1'] ?? null,
      city: addr?.['@_city'] ?? null,
      state: addr?.['@_state'] ?? null,
      postalCode: addr?.['@_postalCode'] ?? null,
    }
  }

  async getMetrics(propertyId: number, year?: number): Promise<Record<string, unknown>> {
    const res = await this.pmFetch(`/pm/property/${propertyId}/billboard.json?_=${Date.now()}`)
    if (!res.ok) throw new EspmError(`Metrics not available for property ${propertyId}`, res.status)
    const data = await res.json() as any

    // billboard.json wraps values in nested JSON strings — parse each row
    const parseRow = (rowStr: string): any => {
      try { return JSON.parse(rowStr) } catch { return {} }
    }

    const row = parseRow(data?.billboardRow ?? '{}')
    // Extract numeric values from the HTML-heavy row data
    const extractNum = (val: any): number | null => {
      if (val == null || val === 'N/A' || val === '') return null
      const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''))
      return isNaN(n) ? null : n
    }

    // The billboard columns vary but typically: score, siteEUI, sourceEUI
    const cols: any[] = Array.isArray(row.colValues) ? row.colValues : []

    return {
      year: year ?? new Date().getFullYear(),
      energyStarScore: extractNum(cols[0]?.currentValue ?? cols[0]?.value),
      scoreEligible: data?.whyNotScoreAlert == null,
      whyNotScoreAlert: data?.whyNotScoreAlert ?? null,
      siteEUI: extractNum(cols[1]?.currentValue ?? cols[1]?.value),
      sourceEUI: extractNum(cols[2]?.currentValue ?? cols[2]?.value),
      rawBillboard: row,
    }
  }

  async listMeters(propertyId: number): Promise<Array<Record<string, unknown>>> {
    const res = await this.pmFetch(`/pm/property/${propertyId}/energyUsage/chart?_=${Date.now()}`)
    if (!res.ok) throw new EspmError(`Could not fetch energy data for property ${propertyId}`, res.status)
    const data = await res.json() as any
    const series: any[] = data?.series ?? []
    return series
      .filter((s: any) => Array.isArray(s.data) && s.data.length > 0)
      .map((s: any, i: number) => ({
        meterId: i,
        name: String(s.name ?? `Meter ${i + 1}`),
        type: String(s.name ?? ''),
        monthsOfData: s.data.length,
        units: 'GJ',
      }))
  }

  /**
   * Get monthly energy consumption for Audette calibration.
   *
   * Returns data by fuel type (Electric - Grid, Natural Gas, etc.) with:
   * - startDate / endDate as ISO date strings
   * - usage_GJ: raw value in gigajoules (PM's native unit)
   * - usage_kWh: converted for electricity (1 GJ = 277.778 kWh)
   * - usage_therms: converted for gas (1 GJ = 9.4782 therms)
   *
   * Pass to Audette's add_utility_data tool directly.
   * Audette accepts kWh for electricity and therms or GJ for gas.
   */
  async getMeterConsumption(
    propertyId: number,
    startDate?: string,
    endDate?: string,
  ): Promise<Array<{ fuelType: string; months: Array<Record<string, unknown>> }>> {
    const res = await this.pmFetch(`/pm/property/${propertyId}/energyUsage/chart?_=${Date.now()}`)
    if (!res.ok) throw new EspmError(`Could not fetch energy data for property ${propertyId}`, res.status)
    const data = await res.json() as any
    const series: any[] = data?.series ?? []

    const filterStart = startDate ? new Date(startDate).getTime() : 0
    const filterEnd = endDate ? new Date(endDate).getTime() : Infinity

    return series
      .filter((s: any) => Array.isArray(s.data) && s.data.length > 0)
      .map((s: any) => {
        const fuelType = String(s.name ?? 'Unknown')
        const isElec = /electric/i.test(fuelType)
        const isGas = /natural.gas|gas/i.test(fuelType)

        const months = (s.data as Array<[number, number]>)
          .filter(([ts]) => ts >= filterStart && ts <= filterEnd)
          .map(([ts, gjValue]) => {
            const start = new Date(ts)
            const end = new Date(start.getFullYear(), start.getMonth() + 1, 0) // end of same month
            return {
              startDate: start.toISOString().slice(0, 10),
              endDate: end.toISOString().slice(0, 10),
              usage_GJ: gjValue,
              usage_kWh: isElec ? Math.round(gjValue * 277.778 * 10) / 10 : null,
              usage_therms: isGas ? Math.round(gjValue * 9.4782 * 10) / 10 : null,
            }
          })
          .sort((a, b) => a.startDate.localeCompare(b.startDate))

        return { fuelType, months }
      })
  }

  // ── Write operations (Official REST API) ──────────────────────────────────────

  /** Create a new property in the PM account. Returns the new propertyId. */
  async createProperty(params: {
    name: string
    primaryFunction: string
    address: string
    city: string
    state: string
    postalCode: string
    country?: string
    yearBuilt?: number
    grossFloorArea?: number
    grossFloorAreaUnits?: 'Square Feet' | 'Square Metres'
    constructionStatus?: 'Existing' | 'New Construction'
    isFederalProperty?: boolean
  }): Promise<{ propertyId: number }> {
    const gfa = params.grossFloorArea
    const gfaUnits = params.grossFloorAreaUnits ?? 'Square Metres'
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<property>
  <name>${esc(params.name)}</name>
  <primaryFunction>${esc(params.primaryFunction)}</primaryFunction>
  <yearBuilt>${params.yearBuilt ?? ''}</yearBuilt>
  <address>
    <address1>${esc(params.address)}</address1>
    <city>${esc(params.city)}</city>
    <state>${esc(params.state)}</state>
    <postalCode>${esc(params.postalCode)}</postalCode>
    <country>${esc(params.country ?? 'US')}</country>
  </address>
  <constructionStatus>${params.constructionStatus ?? 'Existing'}</constructionStatus>
  <isFederalProperty>${params.isFederalProperty ?? false}</isFederalProperty>
  ${gfa != null ? `<grossFloorArea units="${esc(gfaUnits)}">${gfa}</grossFloorArea>` : ''}
</property>`
    const data = await this.wsPost('/account/property', xml)
    const id = data?.response?.id ?? data?.id ?? data?.propertyId
    if (!id) throw new EspmError('Property created but no ID returned', 500)
    return { propertyId: Number(id) }
  }

  /** Update an existing property's attributes. */
  async updateProperty(propertyId: number, params: {
    name?: string
    primaryFunction?: string
    address?: string
    city?: string
    state?: string
    postalCode?: string
    country?: string
    yearBuilt?: number
    grossFloorArea?: number
    grossFloorAreaUnits?: 'Square Feet' | 'Square Metres'
    constructionStatus?: 'Existing' | 'New Construction'
  }): Promise<{ ok: true }> {
    // Fetch current values to merge
    const current = await this.wsGet(`/property/${propertyId}`)
    const p = current?.property ?? current
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<property>
  <name>${esc(params.name ?? p?.name)}</name>
  <primaryFunction>${esc(params.primaryFunction ?? p?.primaryFunction)}</primaryFunction>
  <yearBuilt>${params.yearBuilt ?? p?.yearBuilt ?? ''}</yearBuilt>
  <address>
    <address1>${esc(params.address ?? p?.address?.address1 ?? '')}</address1>
    <city>${esc(params.city ?? p?.address?.city ?? '')}</city>
    <state>${esc(params.state ?? p?.address?.state ?? '')}</state>
    <postalCode>${esc(params.postalCode ?? p?.address?.postalCode ?? '')}</postalCode>
    <country>${esc(params.country ?? p?.address?.country ?? 'US')}</country>
  </address>
  <constructionStatus>${params.constructionStatus ?? p?.constructionStatus ?? 'Existing'}</constructionStatus>
  <isFederalProperty>${p?.isFederalProperty ?? false}</isFederalProperty>
  ${params.grossFloorArea != null ? `<grossFloorArea units="${esc(params.grossFloorAreaUnits ?? 'Square Metres')}">${params.grossFloorArea}</grossFloorArea>` : ''}
</property>`
    await this.wsPut(`/property/${propertyId}`, xml)
    return { ok: true }
  }

  /** Add an energy or water meter to a property. Returns the new meterId. */
  async addMeter(propertyId: number, params: {
    name: string
    type: 'Electric - Grid' | 'Natural Gas' | 'Municipal Potable Water' | 'Fuel Oil (No. 2)' | 'Propane' | 'District Steam' | 'District Hot Water' | 'District Chilled Water - Electric' | 'Wood' | 'Coal - Anthracite' | 'Coal - Bituminous' | 'Coke'
    units: string
    firstBillDate: string  // YYYY-MM-DD
    inUse?: boolean
  }): Promise<{ meterId: number }> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<meter>
  <name>${esc(params.name)}</name>
  <type>${esc(params.type)}</type>
  <unitOfMeasure>${esc(params.units)}</unitOfMeasure>
  <firstBillDate>${esc(params.firstBillDate)}</firstBillDate>
  <inUse>${params.inUse ?? true}</inUse>
</meter>`
    const data = await this.wsPost(`/property/${propertyId}/meter`, xml)
    const id = data?.response?.id ?? data?.id ?? data?.meterId
    if (!id) throw new EspmError('Meter created but no ID returned', 500)
    return { meterId: Number(id) }
  }

  /** List all meters for a property via the official API. */
  async listMetersRest(propertyId: number): Promise<Array<{ meterId: number; name: string; type: string; units: string; inUse: boolean }>> {
    const data = await this.wsGet(`/property/${propertyId}/meter/list`)
    const links: any[] = data?.response?.links?.link ?? []
    const meters: Array<{ meterId: number; name: string; type: string; units: string; inUse: boolean }> = []
    for (const link of links) {
      const mid = link['@_id'] ?? link.id
      if (!mid) continue
      try {
        const m = await this.wsGet(`/meter/${mid}`)
        const meter = m?.meter ?? m
        meters.push({
          meterId: Number(mid),
          name: String(meter?.name ?? `Meter ${mid}`),
          type: String(meter?.type ?? ''),
          units: String(meter?.unitOfMeasure ?? ''),
          inUse: meter?.inUse !== false,
        })
      } catch { /* skip inaccessible meters */ }
    }
    return meters
  }

  /** Submit monthly energy consumption entries for a meter. */
  async submitMeterData(meterId: number, entries: Array<{
    startDate: string   // YYYY-MM-DD
    endDate: string     // YYYY-MM-DD
    usage: number
    cost?: number
    estimatedValue?: boolean
  }>): Promise<{ ok: true; entriesSubmitted: number }> {
    const consumptionEntries = entries.map((e, i) => `
  <meterConsumption>
    <startDate>${esc(e.startDate)}</startDate>
    <endDate>${esc(e.endDate)}</endDate>
    <usage>${e.usage}</usage>
    ${e.cost != null ? `<cost>${e.cost}</cost>` : ''}
    <estimatedValue>${e.estimatedValue ?? false}</estimatedValue>
  </meterConsumption>`).join('')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<meterData>${consumptionEntries}
</meterData>`
    await this.wsPost(`/meter/${meterId}/consumptionData`, xml)
    return { ok: true, entriesSubmitted: entries.length }
  }

  /** Delete a specific meter consumption entry. */
  async deleteMeterEntry(meterId: number, consumptionDataId: number): Promise<{ ok: true }> {
    await this.wsDelete(`/meter/${meterId}/consumptionData/${consumptionDataId}`)
    return { ok: true }
  }

  /** Share a property with another PM user. */
  async shareProperty(propertyId: number, params: {
    toUsername: string
    permission: 'Read Only' | 'Read Write' | 'None'
    canShare?: boolean
    includeMeters?: boolean
  }): Promise<{ ok: true }> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sharingRequest>
  <toUsername>${esc(params.toUsername)}</toUsername>
  <permission>${esc(params.permission)}</permission>
  <canShare>${params.canShare ?? false}</canShare>
  <includeMeters>${params.includeMeters ?? true}</includeMeters>
</sharingRequest>`
    await this.wsPost(`/property/${propertyId}/share`, xml)
    return { ok: true }
  }

  /** Get ENERGY STAR score eligibility and apply for certification (75+ score required). */
  async getScoreDetails(propertyId: number): Promise<Record<string, unknown>> {
    const data = await this.wsGet(`/property/${propertyId}/metrics?year=${new Date().getFullYear() - 1}&month=12&measurementSystem=Metric`)
    const metrics = data?.metrics?.metric ?? []
    const byName = (name: string) => (Array.isArray(metrics) ? metrics : [metrics]).find((m: any) => m?.['@_name'] === name)
    return {
      energyStarScore: byName('ENERGY_STAR_SCORE')?.value ?? null,
      siteEUI: byName('SITE_EUI')?.value ?? null,
      sourceEUI: byName('SOURCE_EUI')?.value ?? null,
      ghgEmissions: byName('GHG_EMISSIONS')?.value ?? null,
      scoreEligible: byName('SCORE_ELIGIBLE')?.value === 'true',
    }
  }

  /** Request a data quality check before applying for ENERGY STAR certification. */
  async checkDataQuality(propertyId: number): Promise<Record<string, unknown>> {
    const data = await this.wsGet(`/property/${propertyId}/verify`)
    return data?.verificationResults ?? data ?? {}
  }

  /** Get list of valid primary function types for property creation. */
  async listPropertyTypes(): Promise<string[]> {
    return [
      'Office', 'Hotel', 'K-12 School', 'Multifamily Housing', 'Retail Store',
      'Senior Care Community', 'Hospital (General Medical and Surgical)',
      'Supermarket/Grocery Store', 'Warehouse (Refrigerated)', 'Warehouse (Unrefrigerated)',
      'Data Center', 'Financial Office', 'Courthouse', 'Medical Office',
      'Worship Facility', 'Retail Store', 'Refrigerated Warehouse',
      'Automobile Dealership', 'Bank Branch', 'College/University',
      'Convenience Store without Gas Station', 'Convenience Store with Gas Station',
      'Fast Food Restaurant', 'Restaurant', 'Distribution Center',
      'Urgent Care/Clinic/Other Outpatient', 'Non-Refrigerated Warehouse',
      'Mixed Use Property', 'Other',
    ]
  }
}

/** Escape XML special characters */
function esc(s: string | number | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
