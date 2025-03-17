import { Retriever } from '@core/interfaces/retrieval';
import { Executor } from '@core/interfaces/execution';
import { ScriptGenerator } from '@core/interfaces/generation';
import { ContainerProvider } from '@core/interfaces/execution';
import { DocumentationProvider } from '@core/interfaces/documentation';
import { IntegrationError, withErrorHandling } from '@core/utils/error-handling';
import { logger } from '@core/utils/logging';
import { validateIntegrationName, escapeShellArg } from '@core/utils/security';

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

  /**
   * Install a New Relic integration.
   * 
   * @param query - The user query describing the installation
   * @param options - Installation options including license key and configuration
   * @returns Object with success status, message and logs
   */
  async installIntegration(
      query: string,
      options: InstallationOptions
    ): Promise<{
      success: boolean;
      message: string;
      logs: string[];
    }> {
      try {
        // Validate input length to prevent DOS
        if (query.length > 1000) {
          throw new IntegrationError("Query is too long");
        }
        
        logger.info('Installing integration', { query });
        
        // Extract and validate integration name
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
        
        // Get a container
        const image = options.baseImage || 'ubuntu:22.04';
        const container = await this.containerProvider.getContainer(image);
        
        // Generate verification and rollback scripts
        const verificationScript = this.generateVerificationScript(integration, parameters);
        const rollbackScript = this.generateRollbackScript(integration, parameters);
        
        // Execute the installation script
        const result = await this.executeInstallation(
          container, 
          script, 
          verificationScript, 
          rollbackScript,
          integration,
          options
        );
        
        return result;
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

  /**
   * Execute the installation with error handling, verification and rollback.
   */
  private async executeInstallation(
    container: any, 
    script: string,
    verificationScript: string,
    rollbackScript: string,
    integration: string,
    options: InstallationOptions
  ): Promise<{
    success: boolean;
    message: string;
    logs: string[];
  }> {
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
  }

  /**
   * Generate an installation script for the specified integration.
   * 
   * @param integration - Name of the integration
   * @param parameters - Parameters for the installation
   * @returns Installation script as a string
   */
  async generateScript(
    integration: string,
    parameters: Record<string, any>
  ): Promise<string> {
    try {
      logger.debug('Generating installation script', { integration, parameters });

      // Get the installation script from the script generator
      const script = await this.scriptGenerator.generateScript(integration, "install", parameters);

      return script;
    } catch (error: any) {
      logger.error('Failed to generate script', {
        integration,
        error: error.message
      });

      throw new IntegrationError(`Failed to generate script for ${integration}: ${error.message}`, { cause: error });
    }
  }

  /**
   * Extract integration name from a user query.
   * 
   * @param query - The user query
   * @returns Extracted integration name
   */
  private extractIntegrationName(query: string): string {
    // Simple regex to extract integration name
    const match = query.match(/install\s+(?:the\s+)?([a-zA-Z0-9_-]+)/i);
    
    if (!match) {
      throw new IntegrationError(`Could not extract integration name from query: ${query}`);
    }
    
    return match[1].toLowerCase();
  }

  /**
   * Extract parameters from a user query.
   * 
   * @param query - The user query
   * @returns Object containing extracted parameters
   */
  private extractParameters(query: string): Record<string, any> {
    const parameters: Record<string, any> = {};
    
    // Check query length to prevent ReDoS attacks
    if (query.length > 1000) {
      logger.warn('Query too long, limiting parameter extraction');
      return parameters;
    }
    
    // Use a time limit for regex operations to prevent ReDoS
    const startTime = Date.now();
    const timeLimit = 500; // 500ms
    
    try {
      // Extract host parameter
      const hostMatch = query.match(/(?:host|server|address|url)(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
      if (hostMatch && Date.now() - startTime < timeLimit) {
        parameters.host = hostMatch[1];
      }
      
      // Extract port parameter
      const portMatch = query.match(/port(?:\s+)?[=:](?:\s+)?(\d+)/i);
      if (portMatch && Date.now() - startTime < timeLimit) {
        const port = parseInt(portMatch[1], 10);
        if (!isNaN(port) && port > 0 && port < 65536) {
          parameters.port = port;
        }
      }
      
      // Extract username parameter
      const userMatch = query.match(/(?:user|username)(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
      if (userMatch && Date.now() - startTime < timeLimit) {
        parameters.username = userMatch[1];
      }
      
      // Extract password parameter
      const passMatch = query.match(/(?:pass|password)(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
      if (passMatch && Date.now() - startTime < timeLimit) {
        parameters.password = passMatch[1];
      }
      
      // Extract version parameter
      const versionMatch = query.match(/version(?:\s+)?[=:](?:\s+)?([^\s,]+)/i);
      if (versionMatch && Date.now() - startTime < timeLimit) {
        parameters.version = versionMatch[1];
      }
    } catch (error) {
      logger.warn('Error extracting parameters from query', { error });
    }
    
    return parameters;
  }

  /**
   * Generate a verification script for the integration.
   * 
   * @param integration - Name of the integration
   * @param parameters - Parameters for verification
   * @returns Verification script as a string
   */
  private generateVerificationScript(
    integration: string,
    parameters: Record<string, any>
  ): string {
    // Safely escape the integration name for use in shell commands
    const safeIntegrationName = escapeShellArg(integration);
    
    // Define some common verification checks based on integration type
    const checks = this.getVerificationChecks(integration, parameters);
    
    return `#!/bin/bash
set -e

echo "Verifying ${safeIntegrationName} installation..."

${checks.join('\n\n')}

echo "${safeIntegrationName} verification successful"
exit 0
`;
  }

  /**
   * Get verification checks specific to an integration.
   * 
   * @param integration - Name of the integration
   * @param parameters - Parameters for verification
   * @returns Array of verification check scripts
   */
  private getVerificationChecks(
    integration: string,
    parameters: Record<string, any>
  ): string[] {
    // Safely escape the integration name for use in shell commands
    const safeIntegrationName = escapeShellArg(integration);
    
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
        checks.push(`# Check if ${safeIntegrationName} integration is installed
if [ ! -f /etc/newrelic-infra/integrations.d/${safeIntegrationName}-config.yml ]; then
  echo "${safeIntegrationName} integration configuration not found"
  exit 1
fi`);
        break;
    }
    
    return checks;
  }

  /**
   * Generate a rollback script for the integration.
   * 
   * @param integration - Name of the integration
   * @param parameters - Parameters for rollback
   * @returns Rollback script as a string
   */
  private generateRollbackScript(
    integration: string,
    parameters: Record<string, any>
  ): string {
    // Safely escape the integration name for use in shell commands
    const safeIntegrationName = escapeShellArg(integration);
    
    return `#!/bin/bash
set -e

echo "Rolling back ${safeIntegrationName} installation..."

# Stop the service if running
systemctl stop newrelic-infra || true

# Remove configuration
rm -f /etc/newrelic-infra/integrations.d/${safeIntegrationName}-config.yml

# Depending on the package manager, remove packages
if command -v apt-get > /dev/null; then
  apt-get remove -y newrelic-infra-${safeIntegrationName} || true
elif command -v yum > /dev/null; then
  yum remove -y newrelic-infra-${safeIntegrationName} || true
fi

echo "${safeIntegrationName} rollback completed"
exit 0
`;
  }
}