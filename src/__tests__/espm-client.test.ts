import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EspmClient, EspmError } from '../espm-client.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function xmlRes(body: string, status = 200) {
  return Promise.resolve(new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml' },
  }))
}

describe('EspmClient', () => {
  let client: EspmClient

  beforeEach(() => {
    vi.clearAllMocks()
    client = new EspmClient('Bearer myuser:mypassword')
  })

  it('converts Bearer credential to Basic auth header', async () => {
    mockFetch.mockReturnValueOnce(xmlRes(
      '<account><id>42</id><username>myuser</username><email>me@test.com</email></account>'
    ))
    await client.getAccount()
    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers.Authorization).toBe(
      'Basic ' + Buffer.from('myuser:mypassword').toString('base64')
    )
  })

  it('getAccount returns parsed account', async () => {
    mockFetch.mockReturnValueOnce(xmlRes(
      '<account><id>42</id><username>myuser</username><email>me@test.com</email></account>'
    ))
    expect(await client.getAccount()).toEqual({ accountId: 42, username: 'myuser', email: 'me@test.com' })
  })

  it('listProperties returns id+name array', async () => {
    mockFetch
      .mockReturnValueOnce(xmlRes('<account><id>42</id><username>u</username><email>e</email></account>'))
      .mockReturnValueOnce(xmlRes(`
        <response><links>
          <link id="101" hint="My Office" />
          <link id="202" hint="My Warehouse" />
        </links></response>
      `))
    expect(await client.listProperties()).toEqual([
      { propertyId: 101, name: 'My Office' },
      { propertyId: 202, name: 'My Warehouse' },
    ])
  })

  it('getMetrics returns score and EUI', async () => {
    mockFetch.mockReturnValueOnce(xmlRes(`
      <propertyMetrics>
        <metric name="score" value="82" units="" />
        <metric name="siteEUI" value="45.2" units="kBtu/ft²" />
        <metric name="sourceEUI" value="68.1" units="kBtu/ft²" />
        <metric name="totalGHGEmissions" value="110.5" units="MtCO2e" />
      </propertyMetrics>
    `))
    const m = await client.getMetrics(101, 2025)
    expect(m.energyStarScore).toBe(82)
    expect(m.scoreEligible).toBe(true)
    expect(m.siteEUI).toBe(45.2)
    expect(m.year).toBe(2025)
  })

  it('getMetrics marks scoreEligible false when score absent', async () => {
    mockFetch.mockReturnValueOnce(xmlRes(
      '<propertyMetrics><metric name="siteEUI" value="60.0" units="kBtu/ft²" /></propertyMetrics>'
    ))
    const m = await client.getMetrics(101)
    expect(m.energyStarScore).toBeNull()
    expect(m.scoreEligible).toBe(false)
  })

  it('throws EspmError on ESPM API error', async () => {
    mockFetch.mockReturnValueOnce(xmlRes(
      '<errors><error><message>Property not found</message></error></errors>',
      404
    ))
    await expect(client.getMetrics(999)).rejects.toBeInstanceOf(EspmError)
  })

  it('getMeterConsumption defaults to last 24 months and returns sorted entries', async () => {
    mockFetch.mockReturnValueOnce(xmlRes(`
      <meterData>
        <meterConsumption startDate="2025-01-01" endDate="2025-01-31" usage="1200" cost="180" estimatedValue="false" />
      </meterData>
    `))
    const result = await client.getMeterConsumption(55)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ startDate: '2025-01-01', usage: 1200, estimatedValue: false })
    const [url] = mockFetch.mock.calls[0]
    expect(url).toMatch(/startDate=\d{4}-\d{2}-\d{2}&endDate=\d{4}-\d{2}-\d{2}/)
  })
})
