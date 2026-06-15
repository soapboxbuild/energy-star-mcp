import { XMLParser } from 'fast-xml-parser'
import PQueue from 'p-queue'

const ESPM_BASE = 'https://portfoliomanager.energystar.gov/webservices'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: true,
  trimValues: true,
  isArray: (name) => ['link', 'metric', 'meterConsumption', 'error'].includes(name),
})

const makeQueue = () => new PQueue({ concurrency: 1, intervalCap: 10, interval: 1000 })

export class EspmError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message)
    this.name = 'EspmError'
  }
}

export class EspmClient {
  private readonly basicAuth: string
  private accountId: number | null = null
  private readonly queue = makeQueue()

  constructor(authHeader: string) {
    // Soapbox proxy sends: Authorization: Bearer <credential>
    // The credential may be plain "username:password" OR already base64-encoded.
    // Detect by attempting to decode: if the result is printable ASCII containing
    // a colon, it's already base64 and we use it directly for Basic auth.
    const cred = authHeader.replace(/^Bearer\s+/i, '').trim()
    let decoded = ''
    try { decoded = Buffer.from(cred, 'base64').toString('utf-8') } catch {}
    const isAlreadyBase64 = decoded.includes(':') && /^[\x20-\x7E]+$/.test(decoded)
    this.basicAuth = isAlreadyBase64 ? `Basic ${cred}` : `Basic ${Buffer.from(cred).toString('base64')}`
  }

  private async espmFetch(path: string): Promise<unknown> {
    return this.queue.add(async () => {
      const res = await fetch(`${ESPM_BASE}${path}`, {
        headers: { Authorization: this.basicAuth, Accept: 'application/xml' },
      })
      const text = await res.text()
      if (!res.ok) {
        const xmlMsg = text.match(/<message>([\s\S]*?)<\/message>/)?.[1]?.trim()
        const htmlMsg = text.match(/<h1>([\s\S]*?)<\/h1>/)?.[1]?.trim()
        throw new EspmError(xmlMsg ?? htmlMsg ?? `HTTP ${res.status}`, res.status)
      }
      return xmlParser.parse(text)
    })
  }

  async getAccount(): Promise<{ accountId: number; username: string; email: string }> {
    const data = await this.espmFetch('/account') as any
    const a = data?.account ?? data
    this.accountId = Number(a.id)
    return { accountId: Number(a.id), username: String(a.username ?? ''), email: String(a.email ?? '') }
  }

  private async ensureAccountId(): Promise<number> {
    if (this.accountId !== null) return this.accountId
    const { accountId } = await this.getAccount()
    return accountId
  }

  async listProperties(): Promise<Array<{ propertyId: number; name: string }>> {
    const accountId = await this.ensureAccountId()
    const data = await this.espmFetch(`/account/${accountId}/property/list`) as any
    const links: any[] = data?.response?.links?.link ?? []
    return links.map((l: any) => ({ propertyId: Number(l.id), name: String(l.hint ?? l.id) }))
  }

  async getProperty(propertyId: number): Promise<Record<string, unknown>> {
    const data = await this.espmFetch(`/property/${propertyId}`) as any
    const p = data?.property ?? data
    return {
      propertyId: Number(p.id ?? propertyId),
      name: String(p.name ?? ''),
      address: String(p.address?.address1 ?? ''),
      city: String(p.address?.city ?? ''),
      state: String(p.address?.state ?? ''),
      postalCode: String(p.address?.postalCode ?? ''),
      primaryFunction: String(p.primaryFunction ?? ''),
      grossFloorArea: p.grossFloorArea?.value ?? null,
      grossFloorAreaUnits: String(p.grossFloorArea?.units ?? 'Square Feet'),
      yearBuilt: p.yearBuilt != null ? Number(p.yearBuilt) : null,
      numberOfBuildings: p.numberOfBuildings != null ? Number(p.numberOfBuildings) : 1,
    }
  }

  async getMetrics(propertyId: number, year?: number): Promise<Record<string, unknown>> {
    const y = year ?? new Date().getFullYear()
    const data = await this.espmFetch(
      `/property/${propertyId}/metrics?year=${y}&temporary=false`
    ) as any
    const metrics: any[] = data?.propertyMetrics?.metric ?? []
    const by: Record<string, { value: unknown; units: string }> = {}
    for (const m of metrics) by[m.name] = { value: m.value, units: String(m.units ?? '') }
    const score = by['score']?.value
    return {
      year: y,
      energyStarScore: score != null ? Number(score) : null,
      scoreEligible: score != null,
      siteEUI: by['siteEUI']?.value ?? null,
      siteEUIUnits: by['siteEUI']?.units ?? 'kBtu/ft²',
      sourceEUI: by['sourceEUI']?.value ?? null,
      sourceEUIUnits: by['sourceEUI']?.units ?? 'kBtu/ft²',
      totalGHGEmissions: by['totalGHGEmissions']?.value ?? null,
      totalGHGEmissionsUnits: by['totalGHGEmissions']?.units ?? 'MtCO2e',
      waterUseIntensity: by['waterUseIntensity']?.value ?? null,
      waterUseIntensityUnits: by['waterUseIntensity']?.units ?? null,
    }
  }

  async listMeters(propertyId: number): Promise<Array<Record<string, unknown>>> {
    const data = await this.espmFetch(`/property/${propertyId}/meter/list`) as any
    const links: any[] = data?.response?.links?.link ?? []
    return Promise.all(links.map(async (l: any) => {
      const meterId = Number(l.id)
      const detail = await this.espmFetch(`/meter/${meterId}`) as any
      const m = detail?.meter ?? detail
      return {
        meterId,
        name: String(m.name ?? ''),
        type: String(m.type ?? ''),
        units: String(m.unitOfMeasure ?? ''),
        firstBillDate: m.firstBillDate ?? null,
        inUse: m.inUse !== false,
      }
    }))
  }

  async getMeterConsumption(
    meterId: number,
    startDate?: string,
    endDate?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const end = endDate ?? new Date().toISOString().slice(0, 10)
    const start = startDate ?? new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10)
    const data = await this.espmFetch(
      `/meter/${meterId}/consumptionData?startDate=${start}&endDate=${end}`
    ) as any
    const entries: any[] = data?.meterData?.meterConsumption ?? []
    return entries
      .map((e: any) => ({
        startDate: String(e.startDate ?? ''),
        endDate: String(e.endDate ?? ''),
        usage: e.usage ?? null,
        cost: e.cost ?? null,
        estimatedValue: e.estimatedValue === true || e.estimatedValue === 'true',
      }))
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
  }
}
