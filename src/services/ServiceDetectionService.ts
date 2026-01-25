/**
 * ServiceDetectionService
 *
 * Detects external service dependencies (MongoDB, Redis, PostgreSQL, etc.)
 * from project files (package.json, docker-compose.yml, .env.example)
 */

export interface DetectedService {
  type: 'mongodb' | 'redis' | 'postgresql' | 'mysql' | 'elasticsearch' | 'rabbitmq';
  image: string;
  port: number;
  envVar: string;
  defaultUri: string;
}

export interface ServiceDetectionResult {
  services: DetectedService[];
  detectedFrom: string[];
}

// Service definitions
const SERVICE_CONFIGS: Record<string, Omit<DetectedService, 'type'> & { type: DetectedService['type'] }> = {
  mongodb: {
    type: 'mongodb',
    image: 'mongo:7',
    port: 27017,
    envVar: 'MONGODB_URI',
    defaultUri: 'mongodb://localhost:27017/app',
  },
  redis: {
    type: 'redis',
    image: 'redis:7-alpine',
    port: 6379,
    envVar: 'REDIS_URL',
    defaultUri: 'redis://localhost:6379',
  },
  postgresql: {
    type: 'postgresql',
    image: 'postgres:16-alpine',
    port: 5432,
    envVar: 'DATABASE_URL',
    defaultUri: 'postgresql://postgres:postgres@localhost:5432/app',
  },
  mysql: {
    type: 'mysql',
    image: 'mysql:8',
    port: 3306,
    envVar: 'MYSQL_URL',
    defaultUri: 'mysql://root:root@localhost:3306/app',
  },
  elasticsearch: {
    type: 'elasticsearch',
    image: 'elasticsearch:8.11.0',
    port: 9200,
    envVar: 'ELASTICSEARCH_URL',
    defaultUri: 'http://localhost:9200',
  },
  rabbitmq: {
    type: 'rabbitmq',
    image: 'rabbitmq:3-alpine',
    port: 5672,
    envVar: 'RABBITMQ_URL',
    defaultUri: 'amqp://localhost:5672',
  },
};

// Package.json dependency patterns
const PACKAGE_PATTERNS: Record<string, DetectedService['type']> = {
  // MongoDB
  'mongoose': 'mongodb',
  'mongodb': 'mongodb',
  'monk': 'mongodb',
  'mongoist': 'mongodb',
  // Redis
  'redis': 'redis',
  'ioredis': 'redis',
  'bull': 'redis',
  'bullmq': 'redis',
  'bee-queue': 'redis',
  // PostgreSQL
  'pg': 'postgresql',
  'postgres': 'postgresql',
  'sequelize': 'postgresql', // Could be others, but postgres is most common
  'typeorm': 'postgresql',
  'prisma': 'postgresql',
  'knex': 'postgresql',
  // MySQL
  'mysql': 'mysql',
  'mysql2': 'mysql',
  // Elasticsearch
  '@elastic/elasticsearch': 'elasticsearch',
  'elasticsearch': 'elasticsearch',
  // RabbitMQ
  'amqplib': 'rabbitmq',
  'amqp-connection-manager': 'rabbitmq',
};

// Docker-compose service patterns
const COMPOSE_PATTERNS: Record<string, DetectedService['type']> = {
  'mongo': 'mongodb',
  'mongodb': 'mongodb',
  'redis': 'redis',
  'postgres': 'postgresql',
  'postgresql': 'postgresql',
  'mysql': 'mysql',
  'mariadb': 'mysql',
  'elasticsearch': 'elasticsearch',
  'rabbitmq': 'rabbitmq',
};

class ServiceDetectionService {
  /**
   * Detect services from package.json content
   */
  detectFromPackageJson(packageJsonContent: string): DetectedService[] {
    const detected: Set<DetectedService['type']> = new Set();

    try {
      const pkg = JSON.parse(packageJsonContent);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      for (const dep of Object.keys(allDeps || {})) {
        const serviceType = PACKAGE_PATTERNS[dep.toLowerCase()];
        if (serviceType) {
          detected.add(serviceType);
        }
      }
    } catch {
      // Invalid JSON, ignore
    }

    return Array.from(detected).map(type => SERVICE_CONFIGS[type]);
  }

  /**
   * Detect services from docker-compose.yml content
   */
  detectFromDockerCompose(composeContent: string): DetectedService[] {
    const detected: Set<DetectedService['type']> = new Set();

    // Simple pattern matching (not full YAML parsing to keep it lightweight)
    const lines = composeContent.toLowerCase();

    for (const [pattern, serviceType] of Object.entries(COMPOSE_PATTERNS)) {
      // Look for image: mongo, image: redis, etc.
      if (lines.includes(`image: ${pattern}`) ||
          lines.includes(`image: "${pattern}`) ||
          lines.includes(`${pattern}:`)) {
        detected.add(serviceType);
      }
    }

    return Array.from(detected).map(type => SERVICE_CONFIGS[type]);
  }

  /**
   * Detect services from .env or .env.example content
   */
  detectFromEnvFile(envContent: string): DetectedService[] {
    const detected: Set<DetectedService['type']> = new Set();
    const lines = envContent.toUpperCase();

    // Check for common env var patterns
    if (lines.includes('MONGODB') || lines.includes('MONGO_URI')) {
      detected.add('mongodb');
    }
    if (lines.includes('REDIS')) {
      detected.add('redis');
    }
    if (lines.includes('POSTGRES') || lines.includes('DATABASE_URL')) {
      detected.add('postgresql');
    }
    if (lines.includes('MYSQL')) {
      detected.add('mysql');
    }
    if (lines.includes('ELASTICSEARCH') || lines.includes('ELASTIC_')) {
      detected.add('elasticsearch');
    }
    if (lines.includes('RABBITMQ') || lines.includes('AMQP')) {
      detected.add('rabbitmq');
    }

    return Array.from(detected).map(type => SERVICE_CONFIGS[type]);
  }

  /**
   * Detect services from Dockerfile content
   */
  detectFromDockerfile(dockerfileContent: string): DetectedService[] {
    // Dockerfile usually doesn't indicate services needed,
    // but we can check for wait scripts or environment variables
    const detected: Set<DetectedService['type']> = new Set();
    const content = dockerfileContent.toUpperCase();

    if (content.includes('MONGODB') || content.includes('MONGO')) {
      detected.add('mongodb');
    }
    if (content.includes('REDIS')) {
      detected.add('redis');
    }
    if (content.includes('POSTGRES')) {
      detected.add('postgresql');
    }

    return Array.from(detected).map(type => SERVICE_CONFIGS[type]);
  }

  /**
   * Combine detections from multiple sources
   */
  combineDetections(...detections: DetectedService[][]): DetectedService[] {
    const serviceMap = new Map<DetectedService['type'], DetectedService>();

    for (const detection of detections) {
      for (const service of detection) {
        if (!serviceMap.has(service.type)) {
          serviceMap.set(service.type, service);
        }
      }
    }

    return Array.from(serviceMap.values());
  }

  /**
   * Get service config by type
   */
  getServiceConfig(type: DetectedService['type']): DetectedService {
    return SERVICE_CONFIGS[type];
  }

  /**
   * Generate environment variables for detected services
   * @param services Detected services
   * @param portOffset Offset to add to default ports (for multiple sandboxes)
   */
  generateEnvVars(services: DetectedService[], portOffset: number = 0): Record<string, string> {
    const envVars: Record<string, string> = {};

    for (const service of services) {
      const port = service.port + portOffset;
      let uri = service.defaultUri;

      // Adjust port in URI
      uri = uri.replace(`:${service.port}`, `:${port}`);

      envVars[service.envVar] = uri;

      // Add common aliases
      switch (service.type) {
        case 'mongodb':
          envVars['MONGO_URI'] = uri;
          envVars['MONGO_URL'] = uri;
          break;
        case 'redis':
          envVars['REDIS_URI'] = uri;
          break;
        case 'postgresql':
          envVars['POSTGRES_URL'] = uri;
          envVars['PG_CONNECTION_STRING'] = uri;
          break;
      }
    }

    return envVars;
  }
}

export const serviceDetectionService = new ServiceDetectionService();
export default serviceDetectionService;
