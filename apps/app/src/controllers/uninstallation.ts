import { Retriever } from '@core/interfaces/retrieval';
import { Executor } from '@core/interfaces/execution';
import { ScriptGenerator } from '@core/interfaces/generation';
import { ContainerProvider } from '@core/interfaces/container';
import { DocumentationProvider } from '@core/interfaces/documentation';
import { IntegrationError } from '@core/utils/error-handling';
import { logger } from '@core/utils/logging';
import { validateIntegrationName } from '@core/utils/security';

export interface UninstallationOptions {
  baseImage?: string;
  timeout?: number;
  verify?: boolean;
}

export class UninstallationController {
  constructor(
    private retriever: Retriever,
    private executor: Executor,
    private scriptGenerator: ScriptGenerator,
    private containerProvider: ContainerProvider,
    private docProvider: DocumentationProvider
  ) {}

  async uninstallIntegration(
    query: string,
    options: UninstallationOptions
  ): Promise<{
    success: boolean;
    message: string;
    logs: string[];
  }> {
    try {
      logger.info('Uninstalling integration', { query });
      
      // Extract integration name from query
      const integration = this.extractIntegrationName(query);
      
      // Validate integration name
      if (!validateIntegrationName(integration)) {
        throw new IntegrationError(`Invalid integration name: ${integration}`);
      }
      
      // Extract parameters from query
      const parameters = this.extractParameters(query);
      
      // Generate uninstallation script
      const script = await this.generateScript(integration, parameters);
      
      // Generate verification script
      const verificationScript = this.generateVerificationScript(integration);
      
      // Execute the uninstallation script
      const result = await this.executor.executeScript(script, {
        image: options.baseImage || 'ubuntu:22.04',
        timeout: options.timeout || 300
      });
      
      if (!result.success) {
        return {
          success: false,
          message: `Uninstallation failed with exit code ${result.exitCode}`,
          logs: [result.output]
        };
      }
      
      // Verify uninstallation if enabled
      if (options.verify !== false) {
        logger.info('Verifying uninstallation', { integration });
        
        const verificationResult = await this.executor.executeScript(verificationScript, {
          image: options.baseImage || 'ubuntu:22.04',
          timeout: 60  // Shorter timeout for verification
        });
        
        if (!verificationResult.success) {
          return {
            success: false,
            message: `Verification failed: ${verificationResult.output}`,
            logs: [result.output, verificationResult.output]
          };
        }
      }
      
      return {
        success: true,
        message: `Successfully uninstalled ${integration} integration`,
        logs: [result.output]
      };
    } catch (error: any) {
      logger.error('Uninstallation failed', {
        query,
        error: error.message
      });
      
      return {
        success: false,
        message: `Uninstallation failed: ${error.message}`,
        logs: []
      };
    }
  }

  private async generateScript(
    integration: string, 
    parameters: Record<string, any>
  ): Promise<string> {
    try {
      logger.debug('Generating uninstallation script', { integration, parameters });
      
      // Try to get a specific uninstallation template
      try {
        return await this.scriptGenerator.generateScript(`${integration}-uninstall`, parameters);
      } catch (error) {
        // Fall back to generic uninstallation script
        return `#!/bin/bash
set -e

echo "Uninstalling ${integration} integration..."

# Stop the service if running
systemctl stop newrelic-infra || true

# Remove configuration files
rm -f /etc/newrelic-infra/integrations.d/${integration}-config.yml

# Uninstall the package based on package manager
if command -v apt-get > /dev/null; then
  apt-get remove -y newrelic-infra-${integration}
elif command -v yum > /dev/null; then
  yum remove -y newrelic-infra-${integration}
else
  echo "Unsupported package manager"
  exit 1
fi

echo "${integration} integration uninstalled successfully"
exit 0
`;
      }
    } catch (error: any) {
      logger.error('Failed to generate uninstallation script', {
        integration,
        error: error.message
      });
      
      throw new IntegrationError(`Failed to generate uninstallation script for ${integration}: ${error.message}`, { cause: error });
    }
  }

  // Extract integration name from query
  private extractIntegrationName(query: string): string {
    // Simple regex to extract integration name
    const match = query.match(/uninstall\s+(?:the\s+)?([a-zA-Z0-9_-]+)/i);
    
    if (!match) {
      throw new IntegrationError(`Could not extract integration name from query: ${query}`);
    }
    
    return match[1].toLowerCase();
  }

  // Extract parameters from query
  private extractParameters(query: string): Record<string, any> {
    // Reuse the same parameter extraction logic as the installation controller
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
    
    return parameters;
  }

  // Generate verification script for the integration
  private generateVerificationScript(integration: string): string {
    return `#!/bin/bash
set -e

echo "Verifying ${integration} uninstallation..."

# Check if integration package is still installed
if command -v dpkg > /dev/null; then
  if dpkg -l | grep -q newrelic-infra-${integration}; then
    echo "${integration} integration package still installed"
    exit 1
  fi
elif command -v rpm > /dev/null; then
  if rpm -qa | grep -q newrelic-infra-${integration}; then
    echo "${integration} integration package still installed"
    exit 1
  fi
fi

# Check if integration configuration file still exists
if [ -f /etc/newrelic-infra/integrations.d/${integration}-config.yml ]; then
  echo "${integration} integration configuration file still exists"
  exit 1
fi

# Check if integration is still running
if ps aux | grep -v grep | grep -q "newrelic-infra-${integration}"; then
  echo "${integration} integration process still running"
  exit 1
fi

echo "${integration} uninstallation verified successfully"
exit 0
`;
  }
}