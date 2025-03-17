export interface ValidationResult {
  valid: boolean;
  issues: {
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    line?: number;
  }[];
}

export interface ScriptGenerator {
  generateScript(integration: string, operation: string, params: Record<string, any>): Promise<string>;
}