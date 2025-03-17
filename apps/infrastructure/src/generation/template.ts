import * as fs from 'fs/promises';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { ScriptGenerator } from '@core/interfaces/generation';
import { ScriptGenerationError } from '@core/utils/error-handling';
import { logger } from '@core/utils/logging';

export interface TemplateScriptGeneratorOptions {
  templatesDir: string;
  cacheSize?: number;
}

export class TemplateScriptGenerator {
  private templatesDir: string;
  private templateCache: Map<string, Handlebars.TemplateDelegate>;
  private maxCacheSize: number;

  constructor(options: TemplateScriptGeneratorOptions) {
    this.templatesDir = options.templatesDir;
    this.maxCacheSize = options.cacheSize || 100;
    this.templateCache = new Map();

    // Register Handlebars helpers
    this.registerHelpers();
  }

  async generateScript(
    container: any,
    integration: string,
    parameters: Record<string, any>
  ): Promise<string> {
    try {
      logger.debug('Generating script', { container, integration, parameters });
      
      // Find the appropriate template
      const templatePath = await this.findTemplate(integration, parameters);
      
      if (!templatePath) {
        throw new ScriptGenerationError(`No template found for integration: ${integration}`);
      }
      
      // Get compiled template
      const template = await this.getCompiledTemplate(templatePath);
      
      // Render template with parameters
      const script = template(parameters);
      
      logger.debug('Script generated successfully', { 
        integration, 
        templatePath 
      });
      
      return script;
    } catch (error: any) {
      logger.error('Error generating script', { 
        integration, 
        error: error.message 
      });
      
      throw new ScriptGenerationError(`Failed to generate script for ${integration}: ${error.message}`, { cause: error });
    }
  }
  
  private async findTemplate(
    integration: string, 
    parameters: Record<string, any>
  ): Promise<string> {
    const os = parameters.os || 'ubuntu';
    const version = parameters.version || 'latest';
    
    // Define potential template paths in order of specificity
    const templatePaths = [
      // OS + version specific template
      path.join(this.templatesDir, integration, os, `${version}.hbs`),
      // OS specific template
      path.join(this.templatesDir, integration, `${os}.hbs`),
      // Default template
      path.join(this.templatesDir, integration, 'default.hbs'),
      // Generic template
      path.join(this.templatesDir, 'generic.hbs')
    ];
    
    // Find the first template that exists
    for (const templatePath of templatePaths) {
      try {
        await fs.access(templatePath);
        return templatePath;
      } catch (err) {
        // Template doesn't exist, try next one
      }
    }
    
    throw new ScriptGenerationError(`No template found for integration: ${integration}`);
  }
  
  private async getCompiledTemplate(
    templatePath: string
  ): Promise<Handlebars.TemplateDelegate> {
    // Check cache first
    if (this.templateCache.has(templatePath)) {
      return this.templateCache.get(templatePath)!;
    }
    
    try {
      const templateContent = await fs.readFile(templatePath, 'utf-8');
      const compiledTemplate = Handlebars.compile(templateContent);
      
      // Update cache, removing oldest entry if needed
      this.updateCache(templatePath, compiledTemplate);
      
      return compiledTemplate;
    } catch (error: any) {
      throw new ScriptGenerationError(`Failed to load template: ${error.message}`, { cause: error });
    }
  }
  
  private updateCache(
    key: string, 
    template: Handlebars.TemplateDelegate
  ): void {
    // Enforce maximum cache size
    if (this.templateCache.size >= this.maxCacheSize) {
      // Remove the oldest entry (first key)
      const oldestKey = this.templateCache.keys().next().value;
      this.templateCache.delete(oldestKey);
    }
    
    this.templateCache.set(key, template);
  }
  
  private registerHelpers(): void {
    // Register if helper
    Handlebars.registerHelper('if_eq', function(a, b, opts) {
      if (a === b) {
        return opts.fn(this);
      } else {
        return opts.inverse(this);
      }
    });
    
    // Register if not helper
    Handlebars.registerHelper('if_not_eq', function(a, b, opts) {
      if (a !== b) {
        return opts.fn(this);
      } else {
        return opts.inverse(this);
      }
    });
    
    // Register if contains helper
    Handlebars.registerHelper('if_contains', function(arr, value, opts) {
      if (Array.isArray(arr) && arr.includes(value)) {
        return opts.fn(this);
      } else {
        return opts.inverse(this);
      }
    });
    
    // Register join helper
    Handlebars.registerHelper('join', function(arr, separator) {
      if (!Array.isArray(arr)) {
        return '';
      }
      return arr.join(separator);
    });
    
    // Register lowercase helper
    Handlebars.registerHelper('lowercase', function(str) {
      return String(str).toLowerCase();
    });
    
    // Register uppercase helper
    Handlebars.registerHelper('uppercase', function(str) {
      return String(str).toUpperCase();
    });
  }
}

validateScript(script: string): { valid: boolean; issues: { severity: "low" | "medium" | "high" | "critical"; message: string; line?: number | undefined; }[]; } {
  return { valid: true, issues: [] };
}