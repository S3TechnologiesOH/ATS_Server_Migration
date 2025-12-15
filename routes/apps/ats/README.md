# ATS Routes - Modular Structure

This directory contains the refactored, modular version of the ATS API routes.

## Background

The original `ats.js` file was 376KB with 10,800+ lines - a massive monolith that was difficult to maintain, test, and navigate. This refactoring splits it into logical, focused modules.

## Module Structure

```
routes/apps/ats/
├── index.js        # Router orchestrator (mounts all sub-routers)
├── helpers.js      # Shared utilities, constants, middleware
├── candidates.js   # /candidates/* routes
├── jobs.js         # /jobs/* routes
├── applications.js # /applications/* routes
├── admin.js        # /admin/* routes
├── graph.js        # /graph/*, /meetings, /emails/* routes
├── reports.js      # /reports/* routes
├── skills.js       # /skills/* and candidate skills routes
├── preferences.js  # /preferences/* routes
├── dashboard.js    # /dashboard/* routes
├── public.js       # /public/* routes (no auth)
├── rejection.js    # /rejection-feedback/* and rejection email routes
└── README.md       # This file
```

## Migration Status

| Module | Status | Lines | Routes |
|--------|--------|-------|--------|
| helpers.js | ✅ Complete | 372 | N/A (utilities) |
| candidates.js | ✅ Complete | 826 | 15 routes |
| jobs.js | ✅ Complete | 582 | 12 routes |
| applications.js | ✅ Complete | 520 | 10 routes |
| admin.js | ✅ Complete | 1,120 | 26 routes |
| graph.js | ✅ Complete | 526 | 12 routes |
| reports.js | ✅ Complete | 521 | 3 routes |
| skills.js | ✅ Complete | 184 | 5 routes |
| preferences.js | ✅ Complete | 180 | 3 routes |
| dashboard.js | ✅ Complete | 103 | 2 routes |
| public.js | ✅ Complete | 634 | 4 routes |
| rejection.js | ✅ Complete | 583 | 6 routes |
| index.js | ✅ Complete | 133 | N/A (orchestrator) |

**Total: 6,284 lines in modular files**

## Module Details

### helpers.js
Shared utilities, constants, and middleware used across all route modules.

**Constants:**
- `DEFAULT_SCHEMA` - Database schema name
- `PEOPLE_TABLE`, `PEOPLE_PK` - Candidates table config
- `APP_TABLE`, `APP_PK` - Applications table config
- `FILES_ROOT`, `FILES_PUBLIC_URL` - File storage paths
- `ADMIN_EMAILS` - Admin user list

**Functions:**
- `getOpenAIClient()` - Lazy-loaded OpenAI client
- `requireAdmin(req, res, next)` - Admin middleware
- `isAdmin(req)` - Check if user is admin
- `getPrimaryEmail(req)` - Get user's primary email
- `ensureDir(dir)` - Create directory recursively
- `safeFileName(name)` - Sanitize filename
- `safeJoin(root, rel)` - Safe path join (prevents traversal)
- `extractTextFromBuffer(buf, filename, contentType)` - Extract text from PDF/DOCX
- `extractMentions(text)` - Extract @mentions from text
- `saveMentions(...)` - Save mentions to database
- `getTableColumns(db, tableName)` - Get table column names
- `ensureAdminTables(db)` - Ensure admin-related tables exist

### candidates.js
Handles all `/candidates/*` routes (15 endpoints).

- List candidates with filtering, sorting, pagination
- Search candidates (full-text, semantic)
- CRUD operations (create, read, update, delete)
- Archive/restore candidates
- AI scoring and score retrieval
- Interview questions generation

### jobs.js
Handles all `/jobs/*` routes (12 endpoints).

- List job listings with filtering
- Public job listing endpoint
- CRUD operations
- AI-assisted job description generation
- Archive/restore jobs
- Candidates per job statistics
- AI ranking of candidates for jobs

### applications.js
Handles all `/applications/*` routes (10 endpoints).

- List applications
- Delete applications
- File uploads (resume, cover letter)
- Attachment management (list, upload, delete)

### admin.js
Handles all `/admin/*` routes (26 endpoints).

- Department CRUD and member management
- Department notes and ideas
- Notification settings
- Candidate flags management
- Bulk delete operations
- User management (CRUD, roles)
- Role management

### graph.js
Handles MS Graph integration (12 endpoints).

**Auth routes (`/graph/*`):**
- OAuth login flow
- Token callback
- Auth status check

**Calendar routes:**
- `/meetings` - List calendar events
- `/graph/getSchedule` - Get free/busy schedules
- `/graph/createEvent` - Create calendar events

**Email routes (`/emails/*`):**
- List email threads
- Get full thread
- Send new email
- Reply to email

**User routes:**
- `/graph/users` - Search users via MS Graph

### reports.js
Handles report generation (3 endpoints).

- `GET /reports` - List available reports
- `POST /reports` - Generate a new report
- `GET /reports/:id/download` - Download a report

**Available report types:**
- `pipeline` - Hiring Pipeline Report
- `recruiter` - Recruiter Performance Report
- `time-to-hire` - Time to Hire Report
- `source` - Source Effectiveness Report

### skills.js
Handles skills management (5 endpoints).

- `GET /skills` - List all skills
- `POST /skills` - Create a new skill
- `GET /candidates/:id/skills` - List skills for a candidate
- `POST /candidates/skills/batch` - Batch fetch skills for multiple candidates
- `POST /candidates/:id/skills` - Add/update a candidate's skill

### preferences.js
Handles user preferences (3 endpoints).

- `GET /preferences` - Get user preferences
- `PUT /preferences` - Update all preferences
- `PATCH /preferences/:section` - Update specific section

### dashboard.js
Handles dashboard statistics (2 endpoints).

- `GET /dashboard/stats` - Get dashboard statistics (candidates, applications, interviews, hires)
- `GET /dashboard/recent-activity` - Get recent application activity

### public.js
Handles public endpoints without authentication (4 endpoints).

- `POST /public/applications` - Submit a job application
- `POST /public/applications/:id/upload/resume` - Upload resume
- `POST /public/applications/:id/upload/cover-letter` - Upload cover letter
- `POST /public/linkedin/init` - Initialize LinkedIn OAuth
- `POST /public/linkedin/auth` - Exchange LinkedIn code for profile

### rejection.js
Handles rejection emails and candidate feedback (6 endpoints).

- `POST /send-rejection-email` - Send rejection email to candidate
- `POST /rejection-feedback/create` - Create feedback request token
- `GET /rejection-feedback/pending` - List pending feedback requests
- `POST /rejection-feedback/respond/:id` - Respond to feedback request
- `GET /public/rejection-feedback/request/:token` - Display feedback form
- `POST /public/rejection-feedback/submit/:token` - Submit feedback

## Usage

### Initialization

The router requires initialization with dependencies:

```javascript
const atsRouter = require("./routes/apps/ats");

// Initialize with dependencies
atsRouter.createRouter({
  buildCandidateVM,
  buildCandidateScoringContext,
  getLatestCandidateScore,
  generateAndStoreCandidateScore,
  enqueueCandidateScore,
  getExtractedTextForUrl,
  mapStatusToStage,
  titleCase,
  buildSignedUrl,
  graphMsal,
  emailService,
});

// Mount the router
app.use("/api/ats", atsRouter);
```

### Testing Individual Modules

To test modules in isolation:

```javascript
const express = require("express");
const candidatesRouter = require("./routes/apps/ats/candidates");

const app = express();
app.use("/candidates", candidatesRouter);
app.listen(4000);
```

## Route Mapping

The routes maintain the same paths as before:

| Old Path in ats.js | New Location |
|-------------------|--------------|
| `router.get("/candidates", ...)` | `candidates.js` → `router.get("/", ...)` |
| `router.get("/jobs", ...)` | `jobs.js` → `router.get("/", ...)` |
| `router.post("/admin/users", ...)` | `admin.js` → `router.post("/users", ...)` |
| `router.get("/graph/login", ...)` | `graph.js` → `router.get("/graph/login", ...)` |
| `router.get("/reports", ...)` | `reports.js` → `router.get("/", ...)` |
| `router.get("/skills", ...)` | `skills.js` → `router.get("/", ...)` |
| `router.get("/preferences", ...)` | `preferences.js` → `router.get("/", ...)` |
| `router.get("/dashboard/stats", ...)` | `dashboard.js` → `router.get("/stats", ...)` |
| `router.post("/public/applications", ...)` | `public.js` → `router.post("/applications", ...)` |
| `router.post("/send-rejection-email", ...)` | `rejection.js` → `router.post("/send-rejection-email", ...)` |

The index.js orchestrator mounts each module at the appropriate base path.

## Benefits of This Structure

1. **Maintainability** - Each file focuses on one domain
2. **Testability** - Modules can be tested in isolation
3. **Navigation** - Easy to find relevant code
4. **Code Review** - Smaller, focused changesets
5. **Parallel Work** - Multiple developers can work on different modules
6. **Performance** - Potential for lazy loading in the future
