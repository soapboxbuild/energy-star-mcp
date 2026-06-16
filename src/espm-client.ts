const PM_BASE = 'https://portfoliomanager.energystar.gov'

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
  }

  private async login(): Promise<void> {
    // Step 1: GET /pm/login to establish a SESSION cookie
    const loginRes = await fetch(`${PM_BASE}/pm/login`, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 PortfolioManager-MCP/1.0' },
    })
    const setCookie = loginRes.headers.get('set-cookie') ?? ''
    // PM uses Spring Session cookie named SESSION (not JSESSIONID)
    const sessionId = setCookie.match(/SESSION=([^;]+)/)?.[1] ?? ''
    if (!sessionId) throw new EspmError('Could not establish PM session', 500)

    const html = await loginRes.text()
    const csrf = html.match(/name="_csrf"[^>]*value="([^"]+)"/)?.[1] ?? ''

    // Step 2: POST credentials to /pm/login (Spring Security processes it)
    const body = new URLSearchParams({ username: this.username, password: this.password })
    if (csrf) body.set('_csrf', csrf)

    const loginPost = await fetch(`${PM_BASE}/pm/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `SESSION=${sessionId}`,
        'User-Agent': 'Mozilla/5.0 PortfolioManager-MCP/1.0',
        'Referer': `${PM_BASE}/pm/login`,
      },
      body: body.toString(),
    })

    // Success redirects to /pm/ or /pm/home; failure redirects to /pm/login?error
    const location = loginPost.headers.get('location') ?? ''
    if (location.includes('error') || (location.includes('login') && !location.endsWith('/pm/login'))) {
      throw new EspmError('Invalid Portfolio Manager credentials', 401)
    }
    if (!location || location.includes('login')) {
      throw new EspmError('Invalid Portfolio Manager credentials', 401)
    }

    // The SESSION cookie may be rotated on successful login
    const authSetCookie = loginPost.headers.get('set-cookie') ?? ''
    const authSession = authSetCookie.match(/SESSION=([^;]+)/)?.[1]
    this.sessionCookie = `SESSION=${authSession ?? sessionId}`
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
      // Session expired — re-login once and retry
      this.sessionCookie = null
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

  async getAccount(): Promise<{ username: string }> {
    // Login validates credentials; return the username
    if (!this.sessionCookie) await this.login()
    return { username: this.username }
  }

  async listProperties(): Promise<Array<{ propertyId: number; name: string }>> {
    const res = await this.pmFetch(`/pm/account/dashboardView?_=${Date.now()}`)
    if (!res.ok) throw new EspmError(`Failed to list properties: HTTP ${res.status}`, res.status)
    const data = await res.json() as any
    const props: any[] = data?.properties ?? []
    return props.map(p => ({ propertyId: Number(p.id), name: String(p.name ?? p.id) }))
  }

  async getProperty(propertyId: number): Promise<Record<string, unknown>> {
    const res = await this.pmFetch(`/pm/property/${propertyId}/detailsTabJson?_=${Date.now()}`)
    if (!res.ok) throw new EspmError(`Property ${propertyId} not found`, res.status)
    const d = await res.json() as any
    return {
      propertyId,
      primaryFunction: d.propertyUseTypesList ? Object.values(d.propertyUseTypesList).join(', ') : null,
      grossFloorArea: d.propertyGFA?.value ? Number(d.propertyGFA.value) : null,
      grossFloorAreaUnits: d.propertyGFA?.unitOfMeasure ?? 'Square Metres',
      notes: d.notes?.value ?? null,
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
    // energyUsage/chart returns meter types with consumption summaries
    const series: any[] = data?.series ?? data?.energySeries ?? []
    return series.map((s: any, i: number) => ({
      meterId: i,
      name: String(s.name ?? s.label ?? `Meter ${i + 1}`),
      type: String(s.name ?? s.label ?? ''),
      units: String(s.units ?? s.unit ?? ''),
    }))
  }

  async getMeterConsumption(
    propertyId: number,
    _startDate?: string,
    _endDate?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const res = await this.pmFetch(`/pm/property/${propertyId}/energyUsage/chart?_=${Date.now()}`)
    if (!res.ok) throw new EspmError(`Could not fetch energy data for property ${propertyId}`, res.status)
    const data = await res.json() as any
    return data?.series ?? data?.energySeries ?? []
  }
}
