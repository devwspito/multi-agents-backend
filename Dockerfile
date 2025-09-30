# Educational Technology Development Backend
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies for educational compliance
RUN apk add --no-cache \
    git \
    curl \
    bash \
    openssl \
    ca-certificates

# Create app user for security
RUN addgroup -g 1001 -S educational && \
    adduser -S educational -u 1001

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application code
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /app/workspaces /app/logs /app/uploads && \
    chown -R educational:educational /app

# Set educational environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV FERPA_COMPLIANCE_MODE=strict
ENV COPPA_COMPLIANCE=enabled
ENV WCAG_COMPLIANCE_LEVEL=AA

# Switch to non-root user
USER educational

# Expose port
EXPOSE 3000

# Health check for educational continuity
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the educational application
CMD ["npm", "start"]