FROM node:18-alpine

WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package*.json ./

# Install dependencies including PostgreSQL client
RUN npm install

# Copy the rest of the application
COPY . .

# Runtime environment defaults (overridden by compose/env at run-time)
ENV NODE_ENV=production \
	OAUTH_TENANT_ID= \
	OAUTH_API_AUDIENCE= \
	OAUTH_REQUIRED_ROLE=

# Expose port
EXPOSE 3000

# Start command
CMD ["npm", "start"]