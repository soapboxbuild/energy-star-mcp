import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { EspmClient } from './espm-client.js'
import { registerTools } from './tools.js'

const app = express()
app.use(express.json())

// Health check — Railway pings this after deploy
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'energy-star-mcp' })
})

// MCP endpoint — stateless: new EspmClient per request, no shared state between users
app.post('/mcp', async (req, res) => {
  const authHeader = req.headers.authorization ?? ''
  const client = new EspmClient(authHeader)
  const server = new McpServer({ name: 'energy-star-mcp', version: '1.0.0' })
  registerTools(server, client)

  // sessionIdGenerator: undefined = stateless (no session persistence between requests)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { server.close().catch(() => {}) })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

const port = parseInt(process.env.PORT ?? '3000', 10)
app.listen(port, () => {
  console.log(`[energy-star-mcp] listening on :${port}`)
})
