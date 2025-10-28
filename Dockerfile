# Multi-Agent Platform - Production Dockerfile
# Multi-stage build for smaller final image

# Stage 1: Build
FROM node:20-alpine AS builder

# Install git (required for GitHub operations)
RUN apk add --no-cache git

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

# Install git (required for GitHub operations at runtime)
RUN apk add --no-cache git

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built code from builder stage
COPY --from=builder /app/dist ./dist

# Copy necessary runtime files (if any .env files exist, they'll be copied)
COPY --from=builder /app/.env* ./ 2>/dev/null || true

# Create workspaces directory
RUN mkdir -p /app/workspaces

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["npm", "start"]
