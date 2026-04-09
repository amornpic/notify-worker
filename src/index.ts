import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth } from 'hono/bearer-auth'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  /** Google Chat Incoming Webhook URL — set via `wrangler secret put GCHAT_WEBHOOK_URL` */
  GCHAT_WEBHOOK_URL: string
  /** Bearer token to protect the endpoint — set via `wrangler secret put API_TOKEN` */
  API_TOKEN: string
}

/**
 * A mention item sent in the request body.
 *
 * Two modes:
 *   { name: "dev1" }                          → plain text  @dev1
 *   { name: "dev1", userId: "users/123456" }  → real Google Chat ping
 *
 * Find userId: open Google Chat DM in browser → the URL contains /users/<numeric-id>
 */
interface Mention {
  name: string
  userId?: string
}

interface NotifyBody {
  prLink: string        // required — full URL to the PR
  ticketLink: string    // required — full URL to the ticket
  spaceId: string       // required — spaceId
  sender: Mention       // required — by. @dev
  reviewers: Mention[]  // required — at least one reviewer (@dev1 @dev2 @dev3)
  lead: Mention         // required — cc. @devlead
}

interface GoogleChatMessage {
  text: string
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidMention(m: unknown): m is Mention {
  if (typeof m !== 'object' || m === null) return false
  const obj = m as Record<string, unknown>
  if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') return false
  if ('userId' in obj && typeof obj['userId'] !== 'string') return false
  return true
}

type ValidationResult =
  | { ok: true; data: NotifyBody }
  | { ok: false; error: string }

function validateBody(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null)
    return { ok: false, error: 'Body must be a JSON object' }

  const b = body as Record<string, unknown>

  if (typeof b['prLink'] !== 'string' || !b['prLink'])
    return { ok: false, error: '`prLink` is required (string)' }

  if (typeof b['ticketLink'] !== 'string' || !b['ticketLink'])
    return { ok: false, error: '`ticketLink` is required (string)' }

  if (typeof b['spaceId'] !== 'string' || !b['spaceId'])
    return { ok: false, error: '`spaceId` is required (string)' }

  if (!Array.isArray(b['reviewers']) || b['reviewers'].length === 0)
    return { ok: false, error: '`reviewers` is required (non-empty array)' }

  if (!isValidMention(b['sender']))
    return { ok: false, error: '`sender` is required: { name: string, userId?: string }' }

  if (!b['reviewers'].every(isValidMention))
    return { ok: false, error: '`reviewers` items must be { name: string, userId?: string }' }

  if (!isValidMention(b['lead']))
    return { ok: false, error: '`lead` is required: { name: string, userId?: string }' }

  return { ok: true, data: body as NotifyBody }
}

// ─── Message builder ──────────────────────────────────────────────────────────

function formatMention(m: Mention): string {
  // userId present → Google Chat resolves this to a real notification ping
  return m.userId ? `<${m.userId}>` : `@${m.name}`
}

function buildMessage(body: NotifyBody, env: Env): [string, GoogleChatMessage] {
  const textSplit = body.prLink.split('/')
  const prNumber     = textSplit[8]
  const repoName     = textSplit[6]
  const senderLine   = `By. ${formatMention(body.sender)}`
  const reviewerLine = body.reviewers.map(formatMention).join(' ')
  const leadLine     = `cc. ${formatMention(body.lead)}`
  const ticket = body.ticketLink.startsWith('https') ? body.ticketLink : `https://trueomx.atlassian.net/browse/${body.ticketLink}`
  const webhookUrl = env.GCHAT_WEBHOOK_URL.split(',').find((url) => url.includes(body.spaceId))

  if (!webhookUrl) {
    throw new Error(`Webhook URL not found for spaceId: ${body.spaceId}`)
  }

  const text = [
    `Please review code`,
    `Pull-requests : ${prNumber}`,
    `Repositories: ${repoName}`,
    `Link: ${body.prLink}`,
    `Ticket: ${ticket}`,
    senderLine,
    ``,
    reviewerLine,
    leadLine,
  ].join('\n')

  return [webhookUrl, { text }]
}

// ─── Google Chat sender ───────────────────────────────────────────────────────

async function sendToGoogleChat(webhookUrl: string, message: GoogleChatMessage): Promise<Response> {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  })
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors())

// GET /health — no auth required
app.get('/health', (c) => c.json({ status: 'ok' }))

// Bearer token guard (skipped if API_TOKEN is not configured)
app.use('/notify/review-pr', async (c, next) => {
  const token = c.env.API_TOKEN
  if (token) return bearerAuth({ token })(c, next)
  return next()
})

// POST /notify
app.post('/notify/review-pr', async (c) => {
  // 1. Parse JSON
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  // 2. Validate
  const result = validateBody(raw)
  if (!result.ok) {
    return c.json(
      {
        success: false,
        error: result.error,
        schema: {
          prLink:     'string (required)',
          ticketLink: 'string (required)',
          spaceId:    'string (required)',
          sender:     'Mention (required)',
          reviewers:  'Mention[] (required, min 1) — Mention: { name: string, userId?: string }',
          lead:       'Mention (required)',
        },
      },
      400,
    )
  }

  // 3. Build message

  // 4. Send to Google Chat
  let gchatRes: Response
  try {
    const [webhookUrl, message] = buildMessage(result.data, c.env)
    gchatRes = await sendToGoogleChat(webhookUrl, message)
  } catch (err) {
    return c.json({ success: false, error: `Network error: ${String(err)}` }, 502)
  }

  if (!gchatRes.ok) {
    const detail = await gchatRes.text()
    return c.json(
      { success: false, error: `Google Chat responded ${gchatRes.status}`, detail },
      502,
    )
  }

  return c.json({ success: true })
})

// 404 fallback
app.notFound((c) => c.json({ error: 'Not found' }, 404))

export default app
