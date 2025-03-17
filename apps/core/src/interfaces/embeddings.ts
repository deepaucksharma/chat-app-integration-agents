export interface EmbeddingsProvider {
  embedQuery(query: string): Promise<number[]>;
  embedDocuments(documents: string[]): Promise<number[][]>;
}