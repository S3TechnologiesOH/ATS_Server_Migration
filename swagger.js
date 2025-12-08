const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

// Basic OpenAPI definition; servers will be set dynamically in app.js based on env
const baseOptions = {
  definition: {
    openapi: '3.0.3',
    info: {
  title: 'Application Management API',
      version: '1.0.0',
  description: 'API documentation for the multi-tenant backend',
    },
    components: {
      securitySchemes: {
        SessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sid',
          description: 'Session cookie set after Azure AD login',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Azure AD access token (client credentials). Audience must match the API App ID URI.'
        }
      },
    },
    security: [{ SessionCookie: [] }],
  },
};

function buildSpec() {
  const options = {
    ...baseOptions,
  // Global docs only include app-level endpoints, not per-app modules
  apis: [path.join(__dirname, 'app.js')],
  };
  return swaggerJsdoc(options);
}

function buildSpecForApp(appId) {
  const options = {
    ...baseOptions,
    apis: [
      path.join(__dirname, 'routes', 'apps', `${appId}.js`),
    ],
  };
  const spec = swaggerJsdoc(options);

  // Adjust title/description per app for clarity in Swagger UI
  spec.info = spec.info || {};
  spec.info.title = `${String(appId).toUpperCase()} API`;
  spec.info.description = `OpenAPI documentation for the '${appId}' application routes.`;

  // For ATS, provide top-level tag descriptions so the UI groups look nice
  if (appId === 'ats') {
    spec.tags = [
      { name: 'Departments', description: 'Manage departments and view their applicants' },
      { name: 'Applications', description: 'Application records and lifecycle operations' },
      { name: 'Candidates', description: 'Candidate profiles, stages, notes, and application mapping' },
      { name: 'Jobs', description: 'Job listings CRUD and related views' },
      { name: 'Skills', description: 'Skills catalog and candidate skill assignments' },
      { name: 'Admin', description: 'Administrative endpoints requiring elevated permissions' },
      { name: 'Graph', description: 'Microsoft Graph authentication and utilities' },
      { name: 'Dashboard', description: 'Aggregated stats and recent activity for ATS' },
    ];
  }

  return spec;
}

module.exports = { buildSpec, buildSpecForApp };
