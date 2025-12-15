# ATS Backend

Express + PostgreSQL backend with Azure AD (OIDC) authentication.

## Tech Stack
* Node.js / Express
* PostgreSQL (`pg`)
* Azure AD OpenID Connect (`@azure/msal-node`)
* Sessions (`express-session`)
* Swagger Docs (`swagger-jsdoc`, `swagger-ui-express`)

## Prerequisites
* Node.js 18+
* Docker (if running with compose)
* Azure AD App Registration (Web)
	* Redirect URI: `https://ats.s3protection.com/api/auth/callback`

## Environment Variables
Create a `.env` file (already gitignored):

```
SESSION_SECRET=replace_with_long_random_string
POSTGRES_PASSWORD=your_postgres_password

AZURE_AD_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_AD_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_AD_CLIENT_SECRET=your_client_secret_value
AZURE_AD_REDIRECT_URI=https://ats.s3protection.com/api/auth/callback

# Optional overrides
# DB_HOST=postgres-db
# DB_PORT=5432
# DB_NAME=applicationDashboard
# DB_USER=admin
# SWAGGER_SERVER_URL=https://ats.s3protection.com/api
```

Never commit real secrets. For production use a secrets manager (Azure Key Vault, etc.) or Docker/Swarm/K8s secrets.

## Install
```
npm install
```

## Development
```
npm run dev
```
Server runs on `http://localhost:3000`.

### API Docs (Swagger UI)
Swagger endpoints require an authenticated session (log in via `/auth/login` first).

After the server starts, visit:

- Global Swagger UI (core endpoints only): `http://localhost:3000/docs`
- Global OpenAPI JSON: `http://localhost:3000/openapi.json`
- ATS Swagger UI: `http://localhost:3000/ats/docs`
- ATS OpenAPI JSON: `http://localhost:3000/ats/openapi.json`

If the server runs behind a reverse proxy or on a public domain, you can set the base server URL displayed in the docs via environment variable:

```
SWAGGER_SERVER_URL=https://ats.s3protection.com/api
```

## Key Routes
* `GET /` – basic info & auth state
* `GET /health` – DB connectivity check
* `GET /docs` – Swagger UI
* `GET /openapi.json` – OpenAPI spec
* `GET /auth/login` – Start Azure AD login
* `GET /auth/callback` – Azure AD redirect
* `GET /auth/success` – Auth success JSON (requires session)
* `POST /auth/logout` – Destroy session
* `GET /api/user` – Authenticated user details

## Docker
Build & run (env file automatically read by compose if exported or passed):

```
docker compose up --build -d
```

Logs:
```
docker logs -f ats-server
```

## Session & Security Notes
* Ensure HTTPS in production so secure cookies are honored.
* Rotate `SESSION_SECRET` and Azure AD client secret periodically.
* Consider enabling Helmet & morgan (already commented in `app.js`).

## Troubleshooting
* Auth redirect mismatch – verify Redirect URI in Azure portal matches `AZURE_AD_REDIRECT_URI`.
* 500 on `/health` – check DB env vars or network connectivity.
* Session not persisting – confirm cookies allowed and proxy `trust proxy` is correct.

## License
Internal / Proprietary (update if needed).
