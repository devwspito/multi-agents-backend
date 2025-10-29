import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // MongoDB
  MONGODB_URI: z.string().url(),

  // Claude API
  ANTHROPIC_API_KEY: z.string().min(1),

  // GitHub OAuth (OPTIONAL - only needed for GitHub login)
  GITHUB_CLIENT_ID: z.string().min(1).default('not-configured'),
  GITHUB_CLIENT_SECRET: z.string().min(1).default('not-configured'),

  // Security
  JWT_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),

  // Frontend
  FRONTEND_URL: z.string().url(),

  // Server
  PORT: z.string().default('3001').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Redis (OPTIONAL - falls back to in-memory if not provided)
  REDIS_URL: z.string().url().optional(),

  // GitHub Token (OPTIONAL - for private repos)
  GITHUB_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Invalid environment variables:');
      error.errors.forEach((err) => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
    }
    process.exit(1);
  }
}

export const env = validateEnv();
