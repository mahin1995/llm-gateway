# LLM Gateway

TypeScript LLM gateway with Express, Prisma, local PostgreSQL, OpenRouter-compatible provider routing, and a React dashboard served by the same server in production.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Update `DATABASE_URL` for your local PostgreSQL database.
3. Set `OPENROUTER_API_KEY`.
4. Install dependencies:

```bash
npm install
```

5. Run Prisma migration and seed:

```bash
npm run prisma:migrate -- --name init
npm run prisma:seed
```

6. Start development servers:

```bash
npm run dev
```

The React app runs at `http://localhost:5173` in development and proxies `/api` to Express at `http://localhost:3000`.

Main dashboard routes:

```text
/dashboard
/admin
/api-keys
/openrouter-keys
/openrouter-models
/tester
/logs
/policy
```

## Production Mode

```bash
npm run build
npm start
```

Express serves both:

- API routes under `/api`
- React build from `client/dist`

## Seeded Local User

The seed script creates an admin user and a local gateway API key:

```text
Dashboard email: admin@example.local
Dashboard password: admin12345
Gateway API key: lgw_dev_key
```

Use the dashboard login to create additional gateway API keys for tools like Claude, Roo Code, Codex, or any OpenAI-compatible client you point at this gateway.

Gateway API keys are sent as:

```http
Authorization: Bearer lgw_dev_key
```

## Core Policy

- Requests start from `L1` unless the caller explicitly requests an allowed tier.
- Escalation is bounded by the user's `maxTier`.
- Admin users can create reusable packages that define token limits, feature flags, and L1/L2/L3 model mappings.
- Admin users can create dashboard users, assign packages to users, and add provider model records from the admin panel.
- Admin users can view OpenRouter management key usage on `/openrouter-keys` when `OPENROUTER_MANAGEMENT_KEY` is configured.
- Admin users can sync and view the OpenRouter model catalog on `/openrouter-models`; synced models are stored in the local database.
- Cache and RAG flags are policy fields.
- If cache or RAG is enabled before those services are configured, the gateway rejects the request instead of partially executing the feature.
- Input, output, and RAG token budgets are enforced before provider calls.

## Main API

```http
POST /api/auth/login
GET /api/account/me
GET /api/account/policy
GET /api/account/api-keys
POST /api/account/api-keys
DELETE /api/account/api-keys/:id
GET /api/account/request-logs
GET /api/admin/dashboard
POST /api/admin/users
PATCH /api/admin/users/:id
POST /api/admin/packages
PATCH /api/admin/packages/:id
POST /api/admin/models
PATCH /api/admin/models/:id
GET /api/admin/openrouter-keys
GET /api/admin/openrouter-keys/:hash
GET /api/admin/openrouter-models
POST /api/admin/openrouter-models/sync
GET /api/v1/me/policy
POST /api/v1/chat
POST /v1/chat/completions
```

Dashboard/account routes use the login session token. Gateway routes under `/api/v1` and the OpenAI-compatible `/v1/chat/completions` route use generated gateway API keys.

For OpenAI-compatible clients:

```text
Base URL: http://localhost:3000/v1
API key: a generated lgw_... gateway key
Model: L1, L2, or L3 for an explicit tier override, or any placeholder model name to start from L1
```

Example chat body:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Explain this gateway in three bullets."
    }
  ],
  "maxOutputTokens": 512
}
```

Each chat request logs:

- prompt text and prompt preview
- selected tier and model
- estimated input tokens
- provider input/output/total tokens when returned by the provider
- OpenRouter cost, cached tokens, reasoning tokens, and raw usage details when returned by the provider
- escalation attempts
- error category and message

Claude Code can connect through the Anthropic-compatible route:

```powershell
$env:ANTHROPIC_BASE_URL="http://localhost:3000"
$env:ANTHROPIC_AUTH_TOKEN="lgw_..."
claude
```

`ANTHROPIC_AUTH_TOKEN` is used because this gateway accepts bearer tokens. The gateway also accepts `x-api-key`, so `ANTHROPIC_API_KEY` can work for direct Anthropic-style clients.
