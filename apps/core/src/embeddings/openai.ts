import { EmbeddingsProvider } from '../interfaces/embeddings';
import { EmbeddingError } from '../utils/error-handling';
import { logger } from '../utils/logging';
import axios from 'axios';

export interface OpenAIEmbeddingsOptions {
  apiKey?: string;
  model?: string;
  batchSize?: number;
  maxRetries?: number;
  timeout?: number;
}

export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly timeout: number;

  constructor(options: OpenAIEmbeddingsOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = options.model || 'text-embedding-3-small';
    this.batchSize = options.batchSize || 1000;
    this.maxRetries = options.maxRetries || 3;
    this.timeout = options.timeout || 60000;
    
    if (!this.apiKey) {
      throw new EmbeddingError('OpenAI API key is required. Provide it via options or OPENAI_API_KEY environment variable.');
    }
  }

  async embedQuery(text: string): Promise<number[]> {
    const vectors = await this.embedDocuments([text]);
    return vectors[0];
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const batches = this.batchTexts(texts);
    
    const embeddings: number[][] = [];
    
    for (const batch of batches) {
      const batchEmbeddings = await this.embedBatch(batch);
      embeddings.push(...batchEmbeddings);
    }
    
    return embeddings;
  }

  private batchTexts(texts: string[]): string[][] {
    const batches: string[][] = [];
    
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      batches.push(batch);
    }
    
    return batches;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    let attempt = 0;
    
    while (attempt < this.maxRetries) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/embeddings',
          {
            model: this.model,
            input: texts
          },
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: this.timeout
          }
        );
        
        return response.data.data.map((item: any) => item.embedding);
      } catch (error: any) {
        attempt++;
        
        logger.warn('Error embedding batch', {
          attempt,
          error: error.message,
          status: error.response?.status,
        });
        
        if (attempt >= this.maxRetries) {
          throw new EmbeddingError(`Failed to embed texts after ${this.maxRetries} attempts: ${error.message}`, { cause: error });
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
      }
    }
    
    throw new EmbeddingError('Failed to embed texts - max retries exceeded');
  }
}