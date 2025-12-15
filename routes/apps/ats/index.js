/**
 * ATS Routes Orchestrator
 *
 * This is the new modular entry point for the ATS API routes.
 * It imports individual route modules and mounts them on the main router.
 *
 * Route Structure:
 *   /candidates/*    -> candidates.js
 *   /jobs/*          -> jobs.js
 *   /applications/*  -> applications.js
 *   /admin/*         -> admin.js
 *   /graph/*         -> graph.js (also /meetings, /emails/*)
 *   /reports/*       -> reports.js
 *   /skills/*        -> skills.js
 *   /preferences/*   -> preferences.js
 *   /dashboard/*     -> dashboard.js
 *   /public/*        -> public.js
 *   /rejection-*     -> rejection.js
 *   /health, /departments, /applicants/*, /debug/* -> misc.js
 *
 * Migration Status:
 *   [x] helpers.js      - Shared utilities, constants, middleware
 *   [x] candidates.js   - Candidate CRUD, search, scoring
 *   [x] jobs.js         - Job listings CRUD, AI assist
 *   [x] applications.js - Application management, file uploads, attachments
 *   [x] admin.js        - Admin operations (departments, users, roles, flags, notes, ideas)
 *   [x] graph.js        - MS Graph integration (auth, meetings, emails, users, scheduling)
 *   [x] reports.js      - Report generation (pipeline, recruiter, time-to-hire, source)
 *   [x] skills.js       - Skills management, candidate skills
 *   [x] preferences.js  - User preferences
 *   [x] dashboard.js    - Dashboard statistics and activity
 *   [x] public.js       - Public applications, LinkedIn OAuth
 *   [x] rejection.js    - Rejection emails and feedback
 *   [x] misc.js         - Health checks, departments, debug, duplicates, reactivation
 */

const express = require("express");
const router = express.Router();

// Import route modules
const candidatesRouter = require("./candidates");
const jobsRouter = require("./jobs");
const applicationsRouter = require("./applications");
const adminRouter = require("./admin");
const graphRouter = require("./graph");
const reportsRouter = require("./reports");
const skillsRouter = require("./skills");
const preferencesRouter = require("./preferences");
const dashboardRouter = require("./dashboard");
const publicRouter = require("./public");
const rejectionRouter = require("./rejection");
const miscRouter = require("./misc");

// Import helpers for initialization
const helpers = require("./helpers");

// Mount route modules immediately on require (not deferred to createRouter)
// This ensures routes work when app.js does: const rtr = require('./routes/apps/ats/index.js')
router.use("/candidates", candidatesRouter);
router.use("/jobs", jobsRouter);
router.use("/applications", applicationsRouter);
router.use("/admin", adminRouter);
router.use("/", graphRouter); // Graph routes have their own prefixes (/graph/*, /meetings, /emails)
router.use("/reports", reportsRouter);
router.use("/skills", skillsRouter);  // Skills CRUD routes (/skills)
router.use("/", skillsRouter);  // Also mount at root for /candidates/:id/skills routes (backward compat)
router.use("/preferences", preferencesRouter);
router.use("/dashboard", dashboardRouter);
router.use("/public", publicRouter);
router.use("/", rejectionRouter); // Rejection routes (/send-rejection-email, /rejection-feedback/*, /public/rejection-feedback/*)
router.use("/", miscRouter); // Misc routes (/health, /departments, /applicants/*, /debug/*, /candidates/:id/duplicate-applications, etc.)

/**
 * Initialize routers with dependencies (optional - for dependency injection)
 * This can be called after mounting if routers need external dependencies
 */
function initRouters(dependencies = {}) {
  const {
    buildCandidateVM,
    buildCandidateScoringContext,
    getLatestCandidateScore,
    generateAndStoreCandidateScore,
    enqueueCandidateScore,
    getExtractedTextForUrl,
    mapStatusToStage,
    titleCase,
    emailService,
  } = dependencies;

  // Initialize candidates router with required functions
  if (candidatesRouter.initCandidates) {
    candidatesRouter.initCandidates({
      buildCandidateVM,
      buildCandidateScoringContext,
      getLatestCandidateScore,
      generateAndStoreCandidateScore,
      enqueueCandidateScore,
      getExtractedTextForUrl,
      mapStatusToStage,
      titleCase,
    });
  }

  // Initialize applications router with required functions
  if (applicationsRouter.initApplications) {
    applicationsRouter.initApplications({
      enqueueCandidateScore,
      buildSignedUrl: dependencies.buildSignedUrl,
    });
  }

  // Initialize jobs router with scoring functions
  if (jobsRouter.initJobs) {
    jobsRouter.initJobs({
      getLatestCandidateScore,
      generateAndStoreCandidateScore,
    });
  }

  // Initialize graph router with MSAL client
  if (graphRouter.initGraph) {
    graphRouter.initGraph({
      graphMsal: dependencies.graphMsal,
    });
  }

  // Initialize public router with email service
  if (publicRouter.initPublic) {
    publicRouter.initPublic({
      emailService,
    });
  }

  // Initialize rejection router with email service
  if (rejectionRouter.initRejection) {
    rejectionRouter.initRejection({
      emailService,
    });
  }

  // Initialize misc router
  if (miscRouter.initMisc) {
    miscRouter.initMisc({
      buildCandidateVM,
      emailService,
    });
  }
}

// Export the router and init function
module.exports = router;
module.exports.initRouters = initRouters;
module.exports.helpers = helpers;
