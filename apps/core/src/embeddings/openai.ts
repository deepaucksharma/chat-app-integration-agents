import OpenAI from 'openai';
import { EmbeddingsProvider } from '@core/interfaces/embeddings';
import { logger } from '@core/utils/logging';

export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  private openai: OpenAI;
  private model: string;

  constructor(model: string = 'text-embedding-3-small', apiKey?: string) {
    this.model = model;
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: query,
      });

      return response.data[0].embedding;
    } catch (error: any) {
      logger.error('Error creating embedding for query', {
        error: error.message,
      });

      throw error;
    }
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    try {
      // Process in batches to avoid rate limits
      const batchSize = 20;
      const batches = [];

      for (let i = 0; i < documents.length; i += batchSize) {
        batches.push(documents.slice(i, i + batchSize));
      }

      const allEmbeddings: number[][] = [];

      for (const batch of batches) {
        const response = await this.openai.embeddings.create({
          model: this.model,
          input: batch,
        });

        const embeddings = response.data.map(item => item.embedding);
        allEmbeddings.push(...embeddings);
      }

      return allEmbeddings;
    } catch (error: any) {
      logger.error('Error creating embeddings for documents', {
        error: error.message,
      });

      throw error;
    }
  }
}