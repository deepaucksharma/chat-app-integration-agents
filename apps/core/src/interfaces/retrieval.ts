export interface Document {
  id: string;
  content: string;
  metadata: Record<string, any>;
}

export interface Retriever {
  retrieve(query: string, config: Record<string, any>): Promise<Document[]>;
  addDocuments(docs: Document[], config: Record<string, any>): Promise<void>;
}