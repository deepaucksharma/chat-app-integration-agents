import * as cheerio from 'cheerio';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';
import { DocumentationProvider } from '../interfaces/documentation';
import { 
  DocumentationError, 
  DocumentationSearchError, 
  DocumentationExtractionError 
} from '../utils/error-handling';
import { logger } from '../utils/logging';

interface CacheEntry {
  content: string;
  timestamp: number;
}

export interface WebDocumentationProviderOptions {
  baseUrl: string;
  cacheDir?: string;
  cacheTtl?: number;
  maxCacheSize?: number;
}

export class WebDocumentationProvider implements DocumentationProvider {
  private baseUrl: string;
  private cacheDir: string;
  private cacheTtl: number; // in seconds
  private maxCacheSize: number;
  private memoryCache: Map<string, CacheEntry>;
  
  constructor(options: WebDocumentationProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.cacheDir = options.cacheDir || './cache/docs';
    this.cacheTtl = options.cacheTtl || 86400; // 24 hours in seconds
    this.maxCacheSize = options.maxCacheSize || 100;
    this.memoryCache = new Map();
    
    // Ensure cache directory exists
    fs.mkdir(this.cacheDir, { recursive: true }).catch(err => {
      logger.error('Failed to create cache directory', { error: err.message });
    });
  }
  
  async getDocumentation(integration: string): Promise<string> {
    try {
      const url = this.constructUrl(integration);
      const cacheKey = this.getCacheKey(url);
      
      // Check memory cache first
      const memCached = this.memoryCache.get(cacheKey);
      if (memCached && this.isCacheValid(memCached.timestamp)) {
        logger.debug('Documentation loaded from memory cache', { integration });
        return memCached.content;
      }
      
      // Check file cache
      const filePath = path.join(this.cacheDir, `${cacheKey}.html`);
      try {
        const stats = await fs.stat(filePath);
        
        if (this.isCacheValid(stats.mtimeMs / 1000)) {
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Update memory cache
          this.updateMemoryCache(cacheKey, content);
          
          logger.debug('Documentation loaded from file cache', { integration });
          return content;
        }
      } catch (err) {
        // File doesn't exist or other error, continue to fetch
      }
      
      // Fetch documentation from the web
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'New Relic Integration Installer'
        },
        timeout: 10000
      });
      
      const htmlContent = response.data;
      const extractedContent = await this.extractFromDocumentation(htmlContent);
      
      // Cache the content
      await fs.writeFile(filePath, extractedContent, 'utf-8');
      this.updateMemoryCache(cacheKey, extractedContent);
      
      logger.debug('Documentation fetched from web', { integration, url });
      return extractedContent;
    } catch (error: any) {
      logger.error('Error fetching documentation', { 
        integration, 
        error: error.message 
      });
      
      throw new DocumentationError(`Failed to get documentation for ${integration}: ${error.message}`, { cause: error });
    }
  }
  
  async searchDocumentation(
    integration: string,
    query: string
  ): Promise<Array<{ title: string, content: string, url: string }>> {
    try {
      // Note: In a real implementation, this would use a vector store retriever
      // This is a simple implementation for demonstration purposes
      
      // For now, just return an empty array
      logger.debug('Documentation search requested', { query });
      return [];
    } catch (error: any) {
      logger.error('Error searching documentation', {
        query,
        error: error.message
      });
      
      throw new DocumentationSearchError(`Failed to search documentation for "${query}": ${error.message}`, { cause: error });
    }
  }
  private async extractFromDocumentation(htmlContent: string): Promise<string> {
    try {
      const $ = cheerio.load(htmlContent);

      // Remove unwanted elements
      $('nav, header, footer, script, style, .navigation, .sidebar, .ads, .cookie-banner').remove();

      // Extract main content
      const mainContent = $('main, .content, article, .documentation, .docs').first();

      if (mainContent.length > 0) {
        // Clean up the content
        mainContent.find('a').each((index: number, el: cheerio.Element) => {
          $(el).replaceWith($(el).text());
        });

        // Replace multiple newlines with a single one
        const text = mainContent.text()
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        return text;
      } else {
        // Fallback to body content
        $('body').find('a').each((index: number, el: cheerio.Element) => {
          $(el).replaceWith($(el).text());
        });

        const text = $('body').text()
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        return text;
      }
    } catch (error: any) {
      logger.error('Error extracting content from documentation', {
        error: error.message
      });
      
      throw new DocumentationExtractionError(`Failed to extract content from documentation: ${error.message}`, { cause: error });
    }
  }
  
  private constructUrl(integration: string): string {
    return `${this.baseUrl}/docs/integrations/${integration}`;
  }
  
  private getCacheKey(url: string): string {
    return crypto.createHash('md5').update(url).digest('hex');
  }
  
  private isCacheValid(timestamp: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    return (now - timestamp) < this.cacheTtl;
  }
  
  private updateMemoryCache(key: string, content: string): void {
    // Enforce max cache size by removing oldest entries if needed
    if (this.memoryCache.size >= this.maxCacheSize) {
      let oldestKey: string | undefined = undefined;
      let oldestTimestamp = Number.MAX_SAFE_INTEGER;

      this.memoryCache.forEach((value, k) => {
        if (value.timestamp < oldestTimestamp) {
          oldestTimestamp = value.timestamp;
          oldestKey = k;
        }
      });

      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }

    this.memoryCache.set(key, {
      content,
      timestamp: Math.floor(Date.now() / 1000)
    });
  }
}