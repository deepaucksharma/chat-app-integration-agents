import * as fs from 'fs';
import * as path from 'path';
import { ScriptGenerator, ValidationResult } from '@core/interfaces/generation';
import { logger } from '@core/utils/logging';
import { scanScriptForVulnerabilities } from '@core/utils/security';

export class TemplateScriptGenerator implements ScriptGenerator {
  private templatesDir: string;
  private scriptCache: Map<string, string> = new Map();
  private maxCacheSize: number;
  
  constructor(options: { templatesDir?: string, cacheSize?: number } = {}) {
    this.templatesDir = options.templatesDir || path.join(process.cwd(), 'templates');
    this.maxCacheSize = options.cacheSize || 100;
    
    // Ensure templates directory exists
    if (!fs.existsSync(this.templatesDir)) {
      fs.mkdirSync(this.templatesDir, { recursive: true });
    }
  }
  
  async generateScript(
    integration: string,
    operation: string,
    params: Record<string, any>
  ): Promise<string> {
    const cacheKey = this.getCacheKey(integration, operation, params);
    
    // Check cache first
    if (this.scriptCache.has(cacheKey)) {
      logger.debug('Using cached script', { integration, operation });
      return this.scriptCache.get(cacheKey)!;
    }
    
    // Find appropriate template
    const templatePath = this.findTemplate(integration, operation, params.os);
    
    if (!templatePath) {
      throw new Error(`Template not found for ${integration} ${operation} on ${params.os}`);
    }
    
    // Read template
    const template = fs.readFileSync(templatePath, 'utf8');
    
    // Replace placeholders
    let script = template;
    
    // Simple placeholder replacement
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        script = script.replace(regex, String(value));
      }
    }
    
    // Handle conditional blocks
    script = this.processConditionals(script, params);
    
    // Cache script
    this.cacheScript(cacheKey, script);
    
    return script;
  }
  
  validateScript(script: string): ValidationResult {
    return scanScriptForVulnerabilities(script);
  }
  
  private findTemplate(integration: string, operation: string, os?: string): string | null {
    const possiblePaths = [];
    
    if (os) {
      // Try OS-specific template first
      possiblePaths.push(
        path.join(this.templatesDir, integration, os, `${operation}.sh.template`),
        path.join(this.templatesDir, integration, os.split('-')[0], `${operation}.sh.template`)
      );
    }
    
    // Then integration-specific
    possiblePaths.push(
      path.join(this.templatesDir, integration, `${operation}.sh.template`)
    );
    
    // Generic fallback
    possiblePaths.push(
      path.join(this.templatesDir, 'generic', `${operation}.sh.template`)
    );
    
    for (const templatePath of possiblePaths) {
      if (fs.existsSync(templatePath)) {
        logger.debug('Found template', { path: templatePath });
        return templatePath;
      }
    }
    
    return null;
  }
  
  private processConditionals(script: string, params: Record<string, any>): string {
    // Process if-else blocks
    const ifRegex = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
    
    return script.replace(ifRegex, (match, condition, ifBlock, elseBlock = '') => {
      const conditionResult = this.evaluateCondition(condition, params);
      return conditionResult ? ifBlock : elseBlock;
    });
  }
  
  private evaluateCondition(condition: string, params: Record<string, any>): boolean {
    // Simple condition evaluation
    try {
      // Handle direct property check (e.g., debian_based)
      if (condition in params) {
        return Boolean(params[condition]);
      }
      
      // Handle comparison (e.g., mysql_port > 3306)
      if (condition.includes('==')) {
        const [left, right] = condition.split('==').map(s => s.trim());
        return this.getParamValue(left, params) == this.getParamValue(right, params);
      }
      
      if (condition.includes('!=')) {
        const [left, right] = condition.split('!=').map(s => s.trim());
        return this.getParamValue(left, params) != this.getParamValue(right, params);
      }
      
      if (condition.includes('>')) {
        const [left, right] = condition.split('>').map(s => s.trim());
        return this.getParamValue(left, params) > this.getParamValue(right, params);
      }
      
      if (condition.includes('<')) {
        const [left, right] = condition.split('<').map(s => s.trim());
        return this.getParamValue(left, params) < this.getParamValue(right, params);
      }
      
      // Default to false for unknown conditions
      return false;
    } catch (error) {
      logger.warn('Error evaluating condition', { condition, error });
      return false;
    }
  }
  
  private getParamValue(expr: string, params: Record<string, any>): any {
    // If it's a parameter reference
    if (expr.startsWith('params.')) {
      const key = expr.substring(7);
      return params[key];
    }
    
    // If it's a literal
    if (expr.startsWith('"') && expr.endsWith('"')) {
      return expr.substring(1, expr.length - 1);
    }
    
    if (expr.startsWith("'") && expr.endsWith("'")) {
      return expr.substring(1, expr.length - 1);
    }
    
    if (!isNaN(Number(expr))) {
      return Number(expr);
    }
    
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    
    // Otherwise, treat as a parameter key
    return params[expr];
  }
  
  private getCacheKey(integration: string, operation: string, params: Record<string, any>): string {
    const relevantParams = { ...params };
    delete relevantParams.license_key; // Don't include sensitive data in cache key
    
    return `${integration}:${operation}:${JSON.stringify(relevantParams)}`;
  }
  
  private cacheScript(key: string, script: string): void {
    // Implement LRU cache behavior
    if (this.scriptCache.size >= this.maxCacheSize) {
      // Remove oldest entry
      const firstKey = this.scriptCache.keys().next().value;
      if (firstKey) {
        this.scriptCache.delete(firstKey);
      }
    }
    
    this.scriptCache.set(key, script);
  }
}