# notify-worker

Cloudflare Worker (Hono + TypeScript) — ส่ง Google Chat notification สำหรับ PR review request

## Stack

| Layer           | Tool                            |
| --------------- | ------------------------------- |
| Runtime         | Cloudflare Workers (serverless) |
| Framework       | Hono v4                         |
| Language        | TypeScript                      |
| Package manager | Bun                             |

---

## Quick Start

```bash
bun install
```

### 1. ตั้งค่า secrets

```bash
wrangler secret put GCHAT_WEBHOOK_URL   # Incoming Webhook URL จาก Google Chat
wrangler secret put API_TOKEN           # Bearer token ป้องกัน endpoint (ตั้งเองได้เลย)
```

### 2. แก้ `wrangler.toml`

```toml
[vars]
PR_NUMBER = "4008"
REPO_NAME = "true-ecommerce-store-web"
```

### 3. รันในเครื่อง

```bash
bun run dev
```

### 4. Deploy

```bash
bun run deploy
# หรือ
wrangler deploy --env staging
```

---

## API

### `GET /health`

```json
{ "status": "ok" }
```

---

### `POST /notify`

**Headers**

```
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

**Body**

```json
{
  "prLink": "https://github.com/org/ecommerce-web/pull/999",
  "ticketLink": "https://jira.example.com/browse/EC-999",
  "reviewers": [
    { "name": "dev1", "userId": "users/111111111" },
    { "name": "dev2", "userId": "users/222222222" },
    { "name": "dev3" }
  ],
  "lead": { "name": "devlead", "userId": "users/999999999" }
}
```

> `userId` เป็น optional ต่อ mention — ถ้าใส่จะ ping จริง, ถ้าไม่ใส่จะแสดงเป็น `@name` plain text

**Response 200**

```json
{
  "success": true,
  "message": {
    "text": "Please review code\nPull-requests : 4008\n..."
  }
}
```

---

## Message ที่ส่งไป Google Chat

```
Please review code
Pull-requests : 4008
Repositories: true-ecommerce-store-web
Link: https://github.com/org/true-ecommerce-store-web/pull/4008
Ticket: https://jira.example.com/browse/EC-4008

<users/111111111> <users/222222222> @dev3
cc. <users/999999999>
```

---

## หา Google Chat userId

เปิด Google Chat ใน browser → คลิกชื่อคน → ดู URL จะมี `/users/<numeric-id>`

---

## cURL

```bash
curl -X POST https://gchat-notifier.<subdomain>.workers.dev/notify \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "prLink": "https://github.com/org/repo/pull/4008",
    "ticketLink": "https://jira.example.com/browse/EC-4008",
    "reviewers": [
      { "name": "dev1", "userId": "users/111111111" },
      { "name": "dev2", "userId": "users/222222222" },
      { "name": "dev3" }
    ],
    "lead": { "name": "devlead", "userId": "users/999999999" }
  }'
```
