import * as z from 'zod';
import { logger } from '../utils/logging';

export interface ValidationResult {
  valid: boolean;
  issues: {
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    line?: number;
  }[];
}

// Define schema for the configuration
const ElasticsearchConfigSchema = z.object({
  url: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
  apiKey: z.string().optional(),
  index: z.string().default('newrelic_docs')
}).refine(data => {
  // Either username+password or apiKey should be provided
  return (data.username && data.password) || data.apiKey;
}, {
  message: "Either 'username' and 'password' or 'apiKey' must be provided for Elasticsearch"
});

const EmbeddingsConfigSchema = z.object({
  model: z.string().default('text-embedding-3-small'),
  apiKey: z.string().optional()
});

const DocumentationConfigSchema = z.object({
  baseUrl: z.string().url(),
  cacheDir: z.string().default('./cache/docs'),
  cacheTtl: z.number().int().positive().default(86400) // 24 hours in seconds
});

const DockerConfigSchema = z.object({
  poolSize: z.number().int().positive().default(5),
  baseImage: z.string().default('ubuntu:22.04')
});

const ExecutionConfigSchema = z.object({
  scriptDir: z.string().default('./scripts'),
  timeout: z.number().int().positive().default(300) // 5 minutes in seconds
});

const TemplatesConfigSchema = z.object({
  dir: z.string().default('./templates'),
  cacheSize: z.number().int().positive().default(100)
});

// Main configuration schema
const ConfigSchema = z.object({
  elasticsearch: ElasticsearchConfigSchema.optional(),
  embeddings: EmbeddingsConfigSchema.optional(),
  documentation: DocumentationConfigSchema.optional(),
  docker: DockerConfigSchema.optional(),
  execution: ExecutionConfigSchema.optional(),
  templates: TemplatesConfigSchema.optional(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info')
});

export async function validateConfig(config: any): Promise<ValidationResult> {
  try {
    // Parse and validate the configuration
    ConfigSchema.parse(config);
    
    return { valid: true, issues: [] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Configuration validation failed', { error });
      
      // Convert Zod errors to our validation issues format
      const issues = error.errors.map(err => ({
        severity: determineSeverity(err),
        message: `${err.path.join('.')}: ${err.message}`
      }));
      
      return { valid: false, issues };
    }
    
    // Handle unexpected errors
    logger.error('Unexpected error during configuration validation', { error });
    
    return {
      valid: false,
      issues: [{
        severity: 'critical',
        message: `Unexpected validation error: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

// Helper function to determine the severity of a validation issue
function determineSeverity(error: z.ZodIssue): 'low' | 'medium' | 'high' | 'critical' {
  // Map Zod error codes to our severity levels
  switch (error.code) {
    case 'invalid_type':
      return 'high';
    case 'custom':
      return 'critical';
    case 'invalid_literal':
      return 'medium';
    default:
      return 'low';
  }
}