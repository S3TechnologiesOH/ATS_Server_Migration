# Environment Variable Validation

This backend includes comprehensive environment variable validation that runs at startup to prevent runtime failures.

## How It Works

The validation system checks for:
1. **Required variables** - Critical variables that must be set
2. **Conditional variables** - Variables required when certain features are enabled
3. **Type validation** - Ensures numeric values are valid numbers
4. **Configuration completeness** - Warns about partial configurations

## Validation Categories

### ✅ Required (Critical)
These variables **must** be set or the application will not start:
- `SESSION_SECRET` - Session cookie signing (security)
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` - Database connection

### ⚠️ Conditional (Feature-Specific)
These are required only when specific features are used:

#### Azure AD Authentication
If **any** Azure AD variable is set, all must be set:
- `AZURE_AD_TENANT_ID`
- `AZURE_AD_CLIENT_ID`
- `AZURE_AD_CLIENT_SECRET`

#### Separate ATS Database
If `ATS_DB_HOST` or `ATS_DB_NAME` is set, all must be set:
- `ATS_DB_HOST`, `ATS_DB_PORT`, `ATS_DB_NAME`
- `ATS_DB_USER`, `ATS_DB_PASSWORD`

#### Bearer Token Validation
If `REQUIRE_BEARER_FOR_PUBLIC_APPLY=1`, these are required:
- `OAUTH_TENANT_ID`
- `OAUTH_API_AUDIENCE`

### 💡 Recommended (Optional)
These generate warnings if missing:
- `FILES_SIGNING_SECRET` - Uses SESSION_SECRET as fallback (not recommended)
- `NODE_ENV` - Defaults to development mode
- `GOOGLE_API_KEY`, `OPENAI_API_KEY` - Disables related features

## Setup Instructions

1. **Copy the example file:**
   ```bash
   cp .env.example .env
   ```

2. **Fill in required values:**
   Edit `.env` and set at minimum:
   - `SESSION_SECRET` (generate with: `openssl rand -hex 32`)
   - Database credentials

3. **Start the application:**
   ```bash
   npm start
   ```

4. **Check startup output:**
   - ✅ Green checkmark = All validations passed
   - ⚠️ Yellow warnings = Optional variables missing
   - ❌ Red errors = Required variables missing (app will exit)

## Example Output

### Success with warnings:
```
⚠️  Environment validation warnings:
   • FILES_SIGNING_SECRET not set, falling back to SESSION_SECRET (not recommended for production)
   • NODE_ENV not set, defaulting to development mode
   • GOOGLE_API_KEY not set, related features may be disabled

✅ Environment validation passed
Server listening on port 3000
```

### Validation failure:
```
❌ Environment validation failed:
   • SESSION_SECRET is required but not set
   • DB_HOST is required but not set
   • DB_PASSWORD is required but not set

Set these variables in your .env file or deployment environment.
```

## Production Deployment

### Docker/Kubernetes
Pass environment variables via deployment config:
```yaml
env:
  - name: SESSION_SECRET
    valueFrom:
      secretKeyRef:
        name: app-secrets
        key: session-secret
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: db-secrets
        key: password
```

### Docker Compose
Use `.env` file or environment section:
```yaml
services:
  app:
    environment:
      - SESSION_SECRET=${SESSION_SECRET}
      - DB_PASSWORD=${DB_PASSWORD}
```

## Security Best Practices

1. **Never commit `.env` files** to version control
2. **Use different secrets** for `SESSION_SECRET` and `FILES_SIGNING_SECRET`
3. **Rotate secrets** periodically in production
4. **Use secure secret management** (Azure Key Vault, AWS Secrets Manager, etc.)
5. **Set `NODE_ENV=production`** in production environments

## Troubleshooting

### App exits immediately on startup
Check the error output for missing required variables. Set them in `.env` and restart.

### "Azure AD authentication is partially configured" warning
Either set all three Azure AD variables or remove them all. Partial configuration won't work.

### Database connection fails after validation passes
Validation only checks that variables are **set**, not that they're **correct**. Verify:
- Database host is reachable
- Credentials are valid
- Database exists
- Network/firewall allows connection

## Adding New Environment Variables

When adding new required variables to the codebase:

1. **Update `validateEnvironment()` function** in `app.js`
2. **Add to `.env.example`** with documentation
3. **Document in this file** under appropriate category
4. **Update deployment configs** (docker-compose.yml, k8s manifests, etc.)

## Related Files

- `.env.example` - Template with all available variables
- `app.js` - Contains validation logic (lines 23-135)
- `docker-compose.yml` - Production environment configuration
