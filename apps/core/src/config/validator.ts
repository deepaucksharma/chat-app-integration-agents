export interface ValidationResult {
  valid: boolean;
  issues: {
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    line?: number;
  }[];
}

export async function validateConfig(config: any): Promise<ValidationResult> {
  // Dummy implementation for now
  return { valid: true, issues: [] };
}