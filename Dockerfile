# ============================================================================
# Multi-Agent Platform - Production Dockerfile
# ============================================================================
# Multi-stage build for optimal image size and security
#
# Build: docker build -t multi-agents-backend .
# Run:   docker-compose -f docker-compose.prod.yml up -d
# ============================================================================

# ============================================================================
# Stage 1: Build
# ============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies (needed for bcrypt native module)
RUN apk add --no-cache python3 make g++ git

# Copy package files first for better caching
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Prune devDependencies for production
RUN npm prune --production

# ============================================================================
# Stage 2: Production Runtime
# ============================================================================
FROM node:20-alpine AS production

# Labels for image metadata
LABEL org.opencontainers.image.title="Multi-Agent Platform Backend"
LABEL org.opencontainers.image.description="Autonomous software development with Claude Agent SDK"
LABEL org.opencontainers.image.version="2.0.0"

WORKDIR /app

# Install runtime dependencies only
# - git: Required for agent git operations
# - openssh-client: For git SSH operations (optional)
RUN apk add --no-cache git openssh-client

# Create non-root user for security
RUN addgroup -g 1001 -S agents && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G agents agents

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy any additional required files
COPY --from=builder /app/CLAUDE.md ./CLAUDE.md

# Create workspace directory with correct permissions
RUN mkdir -p /mnt/data/agent-workspace && \
    chown -R agents:agents /mnt/data/agent-workspace

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV AGENT_WORKSPACE_DIR=/mnt/data/agent-workspace

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Switch to non-root user
USER agents

# Start application
CMD ["node", "dist/index.js"]
