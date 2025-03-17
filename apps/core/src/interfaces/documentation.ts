import { Document } from './retrieval';

export interface DocumentationProvider {
  getDocumentation(integration: string, version?: string): Promise<string>;
  searchDocumentation(integration: string, query: string): Promise<Document[]>;
}