import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EspmClient, EspmError } from '../espm-client.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function htmlRes(body: string, status = 200, headers: Record<string, string> = {}) {
  return Promise.resolve(new Response(body, { status, headers: { 'Content-Type': 'text/html', ...headers } }))
}
function jsonRes(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

const LOGIN_HTML = `<html><body>
  <form><input name="_csrf" value="test-csrf-token"><input name="username" value=""><input name="password" value=""></form>
</body></html>`

function mockLoginSuccess() {
  mockFetch.mockResolvedValueOnce(htmlRes(LOGIN_HTML, 200, { 'set-cookie': 'JSESSIONID=initial123; Path=/; HttpOnly' }))
  mockFetch.mockResolvedValueOnce(htmlRes('', 302, { 'location': '/pm/home', 'set-cookie': 'JSESSIONID=auth456; Path=/; HttpOnly' }))
}

describe('EspmClient', () => {
  let client: EspmClient

  beforeEach(() => { vi.clearAllMocks() })

  describe('credential parsing', () => {
    it('parses plain username:password from Bearer header', () => {
      client = new EspmClient('Bearer myuser:mypassword')
      expect((client as any).username).toBe('myuser')
      expect((client as any).password).toBe('mypassword')
    })

    it('decodes pre-encoded base64 credentials', () => {
      const b64 = Buffer.from('AudetteAnalytics:WPX8yxp9cbv1krm!efn').toString('base64')
      client = new EspmClient(`Bearer ${b64}`)
      expect((client as any).username).toBe('AudetteAnalytics')
      expect((client as any).password).toBe('WPX8yxp9cbv1krm!efn')
    })

    it('handles password containing colons', () => {
      client = new EspmClient('Bearer user:pass:word')
      expect((client as any).username).toBe('user')
      expect((client as any).password).toBe('pass:word')
    })
  })

  describe('login', () => {
    beforeEach(() => { client = new EspmClient('Bearer myuser:mypassword') })

    it('POSTs credentials and csrf to j_spring_security_check', async () => {
      mockLoginSuccess()
      await client.getAccount()
      const call = mockFetch.mock.calls[1]
      expect(call[0]).toContain('/pm/j_spring_security_check')
      expect(call[1].body).toContain('username=myuser')
      expect(call[1].body).toContain('password=mypassword')
      expect(call[1].body).toContain('_csrf=test-csrf-token')
    })

    it('throws EspmError 401 on invalid credentials', async () => {
      mockFetch.mockResolvedValueOnce(htmlRes(LOGIN_HTML, 200, { 'set-cookie': 'JSESSIONID=x; Path=/' }))
      mockFetch.mockResolvedValueOnce(htmlRes('', 302, { 'location': '/pm/login?error=true' }))
      await expect(client.getAccount()).rejects.toBeInstanceOf(EspmError)
    })

    it('throws EspmError 500 if no session cookie', async () => {
      mockFetch.mockResolvedValueOnce(htmlRes(LOGIN_HTML, 200))
      await expect(client.getAccount()).rejects.toBeInstanceOf(EspmError)
    })
  })

  describe('listProperties', () => {
    beforeEach(() => { client = new EspmClient('Bearer myuser:mypassword') })

    it('returns array from dashboardView properties', async () => {
      mockLoginSuccess()
      mockFetch.mockResolvedValueOnce(jsonRes({ properties: [{ id: 101, name: 'My Office' }, { id: 202, name: 'My Warehouse' }] }))
      const result = await client.listProperties()
      expect(result).toEqual([{ propertyId: 101, name: 'My Office' }, { propertyId: 202, name: 'My Warehouse' }])
      expect(mockFetch.mock.calls[2][0]).toContain('/pm/account/dashboardView')
    })

    it('returns empty array when properties missing', async () => {
      mockLoginSuccess()
      mockFetch.mockResolvedValueOnce(jsonRes({ groups: [] }))
      expect(await client.listProperties()).toEqual([])
    })
  })

  describe('getMetrics', () => {
    beforeEach(() => { client = new EspmClient('Bearer myuser:mypassword') })

    it('marks scoreEligible false when whyNotScoreAlert present', async () => {
      mockLoginSuccess()
      mockFetch.mockResolvedValueOnce(jsonRes({ billboardRow: JSON.stringify({ colValues: [] }), whyNotScoreAlert: 'Not eligible' }))
      const r = await client.getMetrics(101)
      expect(r.scoreEligible).toBe(false)
      expect(r.whyNotScoreAlert).toBe('Not eligible')
    })

    it('marks scoreEligible true and extracts score when no alert', async () => {
      mockLoginSuccess()
      mockFetch.mockResolvedValueOnce(jsonRes({ billboardRow: JSON.stringify({ colValues: [{ currentValue: '82' }, { currentValue: '45.2' }] }), whyNotScoreAlert: null }))
      const r = await client.getMetrics(101)
      expect(r.scoreEligible).toBe(true)
      expect(r.energyStarScore).toBe(82)
    })
  })
})
