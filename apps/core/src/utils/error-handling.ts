import { logger } from './logging';

export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

export class ResourceError extends IntegrationError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'RESOURCE_ERROR', details);
    this.name = 'ResourceError';
  }
}

export class ScriptGenerationError extends IntegrationError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'SCRIPT_GENERATION_ERROR', details);
    this.name = 'ScriptGenerationError';
  }
}

export class ExecutionError extends IntegrationError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'EXECUTION_ERROR', details);
    this.name = 'ExecutionError';
  }
}

export class ValidationError extends IntegrationError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  options: {
    retries?: number;
    retryDelay?: number;
    rollback?: () => Promise<void>;
    errorHandler?: (error: Error) => Promise<void>;
  } = {}
): Promise<T> {
  const { retries = 0, retryDelay = 1000, rollback, errorHandler } = options;
  
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      if (errorHandler) {
        await errorHandler(error);
      }
      
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  // All retries failed
  if (rollback) {
    try {
      await rollback();
    } catch (rollbackError) {
      logger.error('Rollback failed', { 
        error: rollbackError 
      });
    }
  }
  
  throw lastError;
}