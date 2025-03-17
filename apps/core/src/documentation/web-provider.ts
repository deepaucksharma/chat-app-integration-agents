import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { DocumentationProvider } from '@core/interfaces/documentation';
import { Document } from '@core/interfaces/retrieval';
import { logger } from '@core/utils/logging';

interface CacheEntry {
  content: string;
  timestamp: number;
}

export class WebDocumentationProvider implements DocumentationProvider {
  private baseUrl: string;
  private cacheDir: string;
  private cacheTtl: number; // in milliseconds
  private cache: Map<string, CacheEntry> = new Map();

  constructor(options: {
    baseUrl?: string;
    cacheDir?: string;
    cacheTtl?: number;
  } = {}) {
    this.baseUrl = options.baseUrl || 'https://docs.newrelic.com/docs/integrations';
    this.cacheDir = options.cacheDir || path.join(process.cwd(), '.cache', 'docs');
    this.cacheTtl = options.cacheTtl || 24 * 60 * 60 * 1000; // 24 hours

    // Create cache directory if it doesn't exist
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    // Load cached documentation
    this.loadCache();
  }

  async getDocumentation(integration: string, version?: string): Promise<string> {
    const cacheKey = this.getCacheKey(integration, version);

    // Check memory cache first
    const cachedEntry = this.cache.get(cacheKey);
    if (cachedEntry &amp;&amp; Date.now() - cachedEntry.timestamp < this.cacheTtl) {
      logger.debug('Using cached documentation from memory', { integration });
      return cachedEntry.content;
    }

    // Check file cache
    const filePath = path.join(this.cacheDir, `${cacheKey}.html`);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (Date.now() - stats.mtimeMs < this.cacheTtl) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          this.cache.set(cacheKey, {
            content,
            timestamp: stats.mtimeMs,
          });
          logger.debug('Using cached documentation from file', { integration, path: filePath });
          return content;
        } catch (error) {
          logger.warn('Error reading cached documentation', {
            integration,
            path: filePath,
            error,
          });
        }
      }
    }

    // Fetch from web
    try {
      const url = this.getDocumentationUrl(integration, version);
      logger.info('Fetching documentation', { integration, url });

      const response = await axios.get(url);
      const content = response.data;

      // Cache content
      this.cache.set(cacheKey, {
        content,
        timestamp: Date.now(),
      });

      // Save to file cache
      fs.writeFileSync(filePath, content);

      return content;
    } catch (error: any) {
      logger.error('Error fetching documentation', {
        integration,
        error: error.message,
      });

      // Return empty document if fetching fails
      return '';
    }
  }

  async searchDocumentation(integration: string, query: string): Promise<Document[]> {
    // This would typically use a retriever/vector store, but for simplicity
    // we'll just do basic text search in this implementation
    try {
      const documentation = await this.getDocumentation(integration);

      // Very simple search implementation
      // In a real system, this would use the vector search capabilities
      const paragraphs = documentation
        .split('\n\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);

      const results: Document[] = [];
      const terms = query.toLowerCase().split(' ');

      for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];
        const matches = terms.filter(term =>
          paragraph.toLowerCase().includes(term)
        );

        if (matches.length > 0) {
          results.push({
            id: `${integration}-${i}`,
            content: paragraph,
            metadata: {
              integration,
              matchScore: matches.length / terms.length,
              position: i,
            },
          });
        }
      }

      // Sort by relevance
      return results.sort((a, b) =>
        (b.metadata.matchScore as number) - (a.metadata.matchScore as number)
      );
    } catch (error: any) {
      logger.error('Error searching documentation', {
        integration,
        query,
        error: error.message,
      });

      return [];
    }
  }

  private getDocumentationUrl(integration: string, version?: string): string {
    // Construct the documentation URL based on integration and version
    let url = `${this.baseUrl}/host-integrations/host-integrations-list/${integration}-monitoring-integration`;

    if (version) {
      url += `/${version}`;
    }

    return url;
  }

  private getCacheKey(integration: string, version?: string): string {
    return version ? `${integration}-${version}` : integration;
  }

  private loadCache(): void {
    try {
      const files = fs.readdirSync(this.cacheDir);

      for (const file of files) {
        if (!file.endsWith('.html')) continue;

        const filePath = path.join(this.cacheDir, file);
        const stats = fs.statSync(filePath);

        // Skip expired cache entries
        if (Date.now() - stats.mtimeMs >= this.cacheTtl) continue;

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const cacheKey = file.slice(0, -5); // Remove .html suffix

          this.cache.set(cacheKey, {
            content,
            timestamp: stats.mtimeMs,
          });
        } catch (error) {
          logger.warn('Error loading cached documentation', {
            file,
            error,
          });
        }
      }

      logger.debug('Loaded documentation cache', {
        entries: this.cache.size,
      });
    } catch (error) {
      logger.warn('Error loading documentation cache', { error });
    }
  }
}