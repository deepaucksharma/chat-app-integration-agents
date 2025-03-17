import { Client } from '@elastic/elasticsearch';
import { Retriever } from '../interfaces/retrieval';
import { Document } from '../interfaces/retrieval';
import { EmbeddingsProvider } from '../interfaces/embeddings';
import { RetrievalError } from '../utils/error-handling';
import { logger } from '../utils/logging';

export interface ElasticRetrieverOptions {
  indexName: string;
  dimensions?: number;
  similarity?: 'cosine' | 'dot_product' | 'l2_norm';
}

interface Hit {
  _id: string;
  content: string;
  metadata?: Record<string, any>;
}

export class ElasticRetriever implements Retriever {
  private client: Client;
  private embeddings: EmbeddingsProvider;
  private indexName: string;
  private dimensions: number;
  private similarity: string;

  constructor(
    client: Client,
    embeddings: EmbeddingsProvider,
    options: ElasticRetrieverOptions
  ) {
    this.client = client;
    this.embeddings = embeddings;
    this.indexName = options.indexName;
    this.dimensions = options.dimensions || 1536; // Default for OpenAI embeddings
    this.similarity = options.similarity || 'cosine';
  }

  async retrieve(query: string, config: Record<string, any> = {}): Promise<Document[]> {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.embeddings.embedQuery(query);
      
      // Prepare the search parameters
      const searchParams = {
        index: this.indexName,
        size: config.limit || 10,
        _source: {
          excludes: ['embedding']
        },
        body: {
          query: {
            script_score: {
              query: config.filter
                ? { bool: { filter: config.filter } }
                : { match_all: {} },
              script: {
                source: `cosineSimilarity(params.query_vector, 'embedding') + 1.0`,
                params: { query_vector: queryEmbedding }
              }
            }
          }
        }
      };
      
      // Execute the search
      const response = await this.client.search<Hit>(searchParams);
      
      // Transform the results into documents
      return response.hits.hits.map(hit => ({
        id: hit._id,
        content: hit._source?.content || '',
        metadata: hit._source?.metadata || {}
      }));
    } catch (error: any) {
      logger.error('Error retrieving documents from Elasticsearch', {
        error: error.message,
        index: this.indexName,
        query
      });
      
      throw new RetrievalError(`Failed to retrieve documents: ${error.message}`, { cause: error });
    }
  }

  async addDocuments(docs: Document[], config: Record<string, any> = {}): Promise<void> {
    try {
      // Check if index exists first
      const indexExists = await this.client.indices.exists({ index: this.indexName });
      
      if (!indexExists) {
        await this.initializeIndex();
      }
      
      // Generate embeddings for all documents
      const texts = docs.map(doc => doc.content);
      const embeddings = await this.embeddings.embedDocuments(texts);
      
      // Prepare bulk operations
      const operations = docs.flatMap((doc, i) => {
        const id = doc.id || `doc_${Date.now()}_${i}`;
        
        return [
          { index: { _index: this.indexName, _id: id } },
          {
            content: doc.content,
            embedding: embeddings[i],
            metadata: doc.metadata || {}
          }
        ];
      });
      
      // Execute bulk indexing
      const bulkResponse = await this.client.bulk({ refresh: true, operations });
      
      if (bulkResponse.errors) {
        const errorItems = bulkResponse.items.filter(item => item.index?.error);
        throw new RetrievalError(`Failed to index some documents: ${JSON.stringify(errorItems)}`);
      }
      
      logger.debug('Successfully indexed documents', { count: docs.length, index: this.indexName });
    } catch (error: any) {
      logger.error('Error adding documents to Elasticsearch', { 
        error: error.message, 
        index: this.indexName,
        docCount: docs.length 
      });
      
      throw new RetrievalError(`Failed to add documents: ${error.message}`, { cause: error });
    }
  }

  private async initializeIndex(): Promise<void> {
    try {
      await this.client.indices.create({
        index: this.indexName,
        body: {
          mappings: {
            properties: {
              content: { type: 'text' },
              embedding: {
                type: 'dense_vector',
                dims: this.dimensions,
                index: true,
                similarity: this.similarity
              },
              metadata: { type: 'object', enabled: true }
            }
          }
        }
      });
      
      logger.info('Created Elasticsearch index', { index: this.indexName });
    } catch (error: any) {
      if (error.message.includes('resource_already_exists_exception')) {
        logger.debug('Index already exists', { index: this.indexName });
        return;
      }
      
      logger.error('Failed to create Elasticsearch index', { 
        error: error.message, 
        index: this.indexName 
      });
      
      throw new RetrievalError(`Failed to create index: ${error.message}`, { cause: error });
    }
  }
}