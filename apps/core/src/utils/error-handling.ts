// Custom error classes
export class IntegrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'IntegrationError';
  }
}

export class RetrievalError extends IntegrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'RetrievalError';
  }
}

export class DocumentationError extends IntegrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'DocumentationError';
  }
}

export class DocumentationSearchError extends DocumentationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'DocumentationSearchError';
  }
}

export class DocumentationExtractionError extends DocumentationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'DocumentationExtractionError';
  }
}

export class ValidationError extends IntegrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'ValidationError';
  }
}

export class ContainerError extends IntegrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'ContainerError';
  }
}

export class ExecutionError extends IntegrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'ExecutionError';
  }
}

export class ScriptGenerationError extends IntegrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'ScriptGenerationError';
  }
}

export class EmbeddingError extends IntegrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause as Error);
    this.name = 'EmbeddingError';
  }
}

// Error handling utility function with retry
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  options: {
    retries?: number,
    retryDelay?: number,
    onError?: (error: Error, attempt: number) => void,
    onRetry?: (attempt: number) => void,
    onSuccess?: (result: T) => void,
  } = {}
): Promise<T> {
  const {
    retries = 3,
    retryDelay = 1000,
    onError,
    onRetry,
    onSuccess
  } = options;

  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await operation();
      onSuccess?.(result);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      onError?.(lastError, attempt);
      
      if (attempt < retries) {
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, retryDelay * (2 ** attempt)));
        onRetry?.(attempt + 1);
      }
    }
  }
  
  throw lastError || new Error('Operation failed');
}