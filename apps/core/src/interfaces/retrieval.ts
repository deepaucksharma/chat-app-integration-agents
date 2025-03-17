export interface Document {
  id?: string;
  content: string;
  metadata?: Record<string, any>;
}

export interface Retriever<T = Document> {
  retrieve(query: string, config?: Record<string, any>): Promise<T[]>;
  addDocuments(docs: T[], config?: Record<string, any>): Promise<void>;
}