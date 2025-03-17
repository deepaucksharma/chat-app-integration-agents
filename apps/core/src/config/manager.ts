import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as dotenv from 'dotenv';
import { logger } from '../utils/logging';
import { validateConfig } from './validator';

export interface ConfigOptions {
  configPath?: string;
  envPrefix?: string;
  defaults?: Record<string, any>;
}

export class ConfigManager {
  private config: Record<string, any> = {};
  private options: ConfigOptions;
  
  constructor(options: ConfigOptions = {}) {
    this.options = {
      configPath: options.configPath || './config.yaml',
      envPrefix: options.envPrefix || 'NR_',
      defaults: options.defaults || {}
    };
    
    // Load dotenv if available
    dotenv.config();
    
    // Initialize with defaults
    this.config = { ...this.options.defaults };
  }
  
  async load(): Promise<Record<string, any>> {
    try {
      // Load from file
      await this.loadFromFile();
      
      // Override with environment variables
      this.loadFromEnv();
      
      // Validate config
      const validationResult = await validateConfig(this.config);
      
      if (!validationResult.valid) {
        logger.warn('Configuration validation issues', { issues: validationResult.issues });
      }
      
      return this.config;
    } catch (error: any) {
      logger.error('Error loading configuration', { error: error.message });
      throw error;
    }
  }
  
  private async loadFromFile(): Promise<void> {
    const { configPath } = this.options;
    
    if (!configPath || !fs.existsSync(configPath)) {
      logger.debug('Configuration file not found', { path: configPath });
      return;
    }
    
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      
      if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
        const yamlConfig = yaml.load(content) as Record<string, any>;
        this.mergeConfig(yamlConfig);
      } else if (configPath.endsWith('.json')) {
        const jsonConfig = JSON.parse(content);
        this.mergeConfig(jsonConfig);
      } else {
        logger.warn('Unsupported configuration file format', { path: configPath });
      }
      
      logger.debug('Loaded configuration from file', { path: configPath });
    } catch (error: any) {
      logger.error('Error loading configuration file', { 
        path: configPath, 
        error: error.message 
      });
      
      throw error;
    }
  }
  
  private loadFromEnv(): void {
    const { envPrefix } = this.options;
    
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(envPrefix)) {
        const configKey = this.envKeyToConfigKey(key, envPrefix);
        this.setNestedProperty(this.config, configKey, value);
      }
    }
    
    logger.debug('Loaded configuration from environment variables');
  }
  
  private envKeyToConfigKey(envKey: string, prefix: string): string[] {
    // Remove prefix and convert to lowercase
    const keyWithoutPrefix = envKey.substring(prefix.length).toLowerCase();
    
    // Split by double underscore for nested properties
    return keyWithoutPrefix.split('__');
  }
  
  private setNestedProperty(obj: Record<string, any>, path: string[], value: any): void {
    let parsedValue = value;
    
    // Try to parse the value
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') {
        parsedValue = true;
      } else if (value.toLowerCase() === 'false') {
        parsedValue = false;
      } else if (!isNaN(Number(value)) && value.trim() !== '') {
        parsedValue = Number(value);
      }
    }
    
    // Handle array notation [index]
    const result = /^([^[]+)(?:\[(\d+)\])?$/.exec(path[0]);
    
    if (result) {
      const [, key, index] = result;
      
      if (path.length === 1) {
        if (index !== undefined) {
          if (!Array.isArray(obj[key])) {
            obj[key] = [];
          }
          obj[key][parseInt(index, 10)] = parsedValue;
        } else {
          obj[key] = parsedValue;
        }
      } else {
        if (index !== undefined) {
          if (!Array.isArray(obj[key])) {
            obj[key] = [];
          }
          if (!obj[key][parseInt(index, 10)]) {
            obj[key][parseInt(index, 10)] = {};
          }
          this.setNestedProperty(obj[key][parseInt(index, 10)], path.slice(1), parsedValue);
        } else {
          if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
            obj[key] = {};
          }
          this.setNestedProperty(obj[key], path.slice(1), parsedValue);
        }
      }
    }
  }
  
  private mergeConfig(source: Record<string, any>, target: Record<string, any> = this.config): void {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
          target[key] = {};
        }
        this.mergeConfig(value, target[key]);
      } else {
        target[key] = value;
      }
    }
  }
  
  get<T>(key: string, defaultValue?: T): T {
    const parts = key.split('.');
    let current: any = this.config;
    
    for (const part of parts) {
      if (current === undefined || current === null) {
        return defaultValue as T;
      }
      
      current = current[part];
    }
    
    return (current === undefined) ? defaultValue as T : current as T;
  }
  
  set(key: string, value: any): void {
    const parts = key.split('.');
    let current = this.config;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      
      current = current[part];
    }
    
    current[parts[parts.length - 1]] = value;
  }
}