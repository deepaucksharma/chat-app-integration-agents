import { Document, Retriever } from '@core/interfaces/retrieval';
import { DocumentationProvider } from '@core/interfaces/documentation';
import { logger } from '@core/utils/logging';
import { EmbeddingsProvider } from '@core/interfaces/embeddings';

export class DocumentationIndexer {
  constructor(
    private retriever: Retriever,
    private docProvider: DocumentationProvider,
    private embeddings: EmbeddingsProvider,
    private options: { chunkSize?: number } = {}
  ) {}

  async indexIntegration(integration: string): Promise<void> {
    try {
      logger.info('Indexing documentation', { integration });

      // Get documentation
      const content = await this.docProvider.getDocumentation(integration);

      if (!content) {
        logger.warn('Empty documentation content', { integration });
        return;
      }

      // Split into chunks
      const chunks = this.splitIntoChunks(content, this.options.chunkSize || 1000);

      // Prepare documents
      const documents: Document[] = chunks.map((chunk, index) => ({
        id: `${integration}-${index}`,
        pageContent: chunk,
        metadata: {
          integration,
          index,
          total: chunks.length,
        },
      }));

      // Store in retriever
      await this.retriever.addDocuments(documents, { integration });

      logger.info('Documentation indexed successfully', {
        integration,
        chunks: chunks.length,
      });
    } catch (error: any) {
      logger.error('Error indexing documentation', {
        integration,
        error: error.message,
      });

      throw error;
    }
  }

  private splitIntoChunks(text: string, chunkSize: number): string[] {
    // Split text into manageable chunks with semantic boundaries
    const paragraphs = text.split('\n\n');
    const chunks: string[] = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      const trimmedParagraph = paragraph.trim();

      if (!trimmedParagraph) continue;

      // If adding this paragraph would exceed chunk size, start a new chunk
      if (currentChunk && (currentChunk.length + trimmedParagraph.length > chunkSize)) {
        chunks.push(currentChunk);
        currentChunk = trimmedParagraph;
      } else {
        currentChunk = currentChunk
          ? `${currentChunk}\n\n${trimmedParagraph}`
          : trimmedParagraph;
      }
    }

    // Add the last chunk if not empty
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }
}