import { Retriever } from '@core/interfaces/retrieval';
import { Executor } from '@core/interfaces/execution';
import { ScriptGenerator } from '@core/interfaces/generation';
import { ContainerProvider } from '@core/interfaces/container';
import { DocumentationProvider } from '@core/interfaces/documentation';
import { IntegrationError, withErrorHandling } from '@core/utils/error-handling';
import { logger } from '@core/utils/logging';
import { validateIntegrationName } from '@core/utils/security';

export interface InstallationOptions {
  licenseKey: string;
  baseImage?: string;
  timeout?: number;
  verify?: boolean;
  rollbackOnError?: boolean;
  dryRun?: boolean;
  env?: Record<string, string>;
}

export class InstallationController {
  constructor(
    private retriever: Retriever,
    private executor: Executor,
    private scriptGenerator: ScriptGenerator,
    private containerProvider: ContainerProvider,
    private docProvider: DocumentationProvider
  ) {}

  async installIntegration(
      query: string,
      options: InstallationOptions
    ): Promise<{
      success: boolean;
      message: string;
      logs: string[];
    }> {
      try {
        logger.info('Installing integration', { query });
        
        // Extract integration name from query
        const integration = this.extractIntegrationName(query);
        
        // Validate integration name
        if (!validateIntegrationName(integration)) {
          throw new IntegrationError(`Invalid integration name: ${integration}`);
        }
        
        // Extract parameters from query
        const parameters = this.extractParameters(query);
        
        // Add license key and environment parameters
        parameters.licenseKey = options.licenseKey;
        parameters.env = options.env || {};
        
        // Get a container
        const image = options.baseImage || 'ubuntu:22.04';
        const container = await this.containerProvider.getContainer(image);
  
        // Generate installation script
        const script = await this.generateScript(integration, parameters);
        
        // In dry run mode, just return the script
        if (options.dryRun) {
          return {
            success: true,
            message: 'Installation script generated successfully (dry run)',
            logs: [script]
          };
        }
        
        // Generate verification script
        const verificationScript = this.generateVerificationScript(integration, parameters);
        
        // Generate rollback script
        const rollbackScript = this.generateRollbackScript(integration, parameters);
        
        // Execute the installation script
        const result = await withErrorHandling(
          async () => {
            const executionResult = await this.executor.executeScript(container, script);
            
            if (!executionResult.success) {
              throw new IntegrationError(`Installation failed with exit code ${executionResult.exitCode}: ${executionResult.output}`);
            }
            
            return executionResult;
          },
          {
            // On error, execute rollback script if enabled
            onError: async (error) => {
              if (options.rollbackOnError !== false) {
                logger.warn('Installation failed, executing rollback', { integration, error: error.message });
                
                await this.executor.executeRollback(container, rollbackScript);
              }
            }
          }
        );
        
        // Verify installation if enabled
        if (options.verify !== false) {
          logger.info('Verifying installation', { integration });
          
          const verificationScript = this.generateVerificationScript(integration, parameters);
          const verificationResult = await this.executor.verifyInstallation(
            container,
            integration,
            verificationScript
          );
          
          if (!verificationResult.success) {
            if (options.rollbackOnError !== false) {
              logger.warn('Verification failed, executing rollback', { integration });
              
              await this.executor.executeRollback(container, rollbackScript);
            }
            
            return {
              success: false,
              message: `Verification failed: ${verificationResult.output}`,
              logs: [result.output, verificationResult.output]
            };
          }
        }
        
        return {
          success: true,
          message: `Successfully installed ${integration} integration`,
          logs: [result.output]
        };
      } catch (error: any) {
        logger.error('Installation failed', {
          query,
          error: error.message
        });
        
        return {
          success: false,
          message: `Installation failed: ${error.message}`,
          logs: []
        };
      }
    }

  async generateScript(
    integration: string,
    parameters: Record<string, any>
  ): Promise<string> {
    try {
      logger.debug('Generating installation script', { integration, parameters });

      // Get the installation script from the script generator
      const script = await this.scriptGenerator.generateScript(container, integration, parameters);

      return script;
    } catch (error: any) {
      logger.error('Failed to generate script', {
        integration,
        error: error.message
      });

      throw new IntegrationError(`Failed to generate script for ${integration}: ${error.message}`, { cause: error });
    }
  }

  // Extract integration name from query
  private extractIntegrationName(query: string): string {
    // Simple regex to extract integration name
    const match = query.match(/install\s+(?:the\s+)?([a-zA-Z0-9_-]+)/i);
    
    if (!match) {
      throw new IntegrationError(`Could not extract integration name from query: ${query}`);
    }
    
    return match[1].toLowerCase();
  }

  // Extract parameters from query
  private extractParameters(query: string): Record<string, any> {
    const parameters: Record<string, any> = {};
    
    // Extract host parameter
    const hostMatch = query.match(/(?:host|server|address|url)(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
    if (hostMatch) {
      parameters.host = hostMatch[1];
    }
    
    // Extract port parameter
    const portMatch = query.match(/port(?:\s+)?[=:](?:\s+)?(\d+)/i);
    if (portMatch) {
      parameters.port = parseInt(portMatch[1], 10);
    }
    
    // Extract username parameter
    const userMatch = query.match(/(?:user|username)(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
    if (userMatch) {
      parameters.username = userMatch[1];
    }
    
    // Extract password parameter
    const passMatch = query.match(/(?:pass|password)(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
    if (passMatch) {
      parameters.password = passMatch[1];
    }
    
    // Extract version parameter
    const versionMatch = query.match(/version(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
    if (versionMatch) {
      parameters.version = versionMatch[1];
    }
    
    return parameters;
  }

  // Generate verification script for the integration
  private generateVerificationScript(
    integration: string,
    parameters: Record<string, any>
  ): string {
    // Define some common verification checks based on integration type
    const checks = this.getVerificationChecks(integration, parameters);
    
    return `#!/bin/bash
set -e

echo "Verifying ${integration} installation..."

${checks.join('\n\n')}

echo "${integration} verification successful"
exit 0
`;
  }

  // Get verification checks for the integration
  private getVerificationChecks(
    integration: string,
    parameters: Record<string, any>
  ): string[] {
    const checks: string[] = [];
    
    // Common checks for all integrations
    checks.push(`# Check if New Relic infrastructure agent is installed
if ! command -v newrelic-infra > /dev/null; then
  echo "New Relic infrastructure agent not found"
  exit 1
fi`);
    
    // Integration-specific checks
    switch (integration) {
      case 'mysql':
        checks.push(`# Check if MySQL integration is installed
if [ ! -f /etc/newrelic-infra/integrations.d/mysql-config.yml ]; then
  echo "MySQL integration configuration not found"
  exit 1
fi

# Check if MySQL integration is running
ps aux | grep -v grep | grep -q "newrelic-infra-mysql" || {
  echo "MySQL integration process not running"
  exit 1
}`);
        break;
        
      case 'postgresql':
        checks.push(`# Check if PostgreSQL integration is installed
if [ ! -f /etc/newrelic-infra/integrations.d/postgres-config.yml ]; then
  echo "PostgreSQL integration configuration not found"
  exit 1
fi

# Check if PostgreSQL integration is running
ps aux | grep -v grep | grep -q "newrelic-infra-postgres" || {
  echo "PostgreSQL integration process not running"
  exit 1
}`);
        break;
        
      case 'nginx':
        checks.push(`# Check if Nginx integration is installed
if [ ! -f /etc/newrelic-infra/integrations.d/nginx-config.yml ]; then
  echo "Nginx integration configuration not found"
  exit 1
fi

# Check if Nginx integration is running
ps aux | grep -v grep | grep -q "newrelic-infra-nginx" || {
  echo "Nginx integration process not running"
  exit 1
}`);
        break;
        
      default:
        // Generic checks for other integrations
        checks.push(`# Check if ${integration} integration is installed
if [ ! -f /etc/newrelic-infra/integrations.d/${integration}-config.yml ]; then
  echo "${integration} integration configuration not found"
  exit 1
fi`);
        break;
    }
    
    return checks;
  }

  // Generate rollback script for the integration
  private generateRollbackScript(
    integration: string,
    parameters: Record<string, any>
  ): string {
    return `#!/bin/bash
set -e

echo "Rolling back ${integration} installation..."

# Stop the service if running
systemctl stop newrelic-infra || true

# Remove configuration
rm -f /etc/newrelic-infra/integrations.d/${integration}-config.yml

# Depending on the package manager, remove packages
if command -v apt-get > /dev/null; then
  apt-get remove -y newrelic-infra-${integration} || true
elif command -v yum > /dev/null; then
  yum remove -y newrelic-infra-${integration} || true
fi

echo "${integration} rollback completed"
exit 0
`;
  }
}