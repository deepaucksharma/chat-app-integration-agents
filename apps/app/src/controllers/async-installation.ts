import { InstallationController } from './installation';
import { logger } from '@core/utils/logging';

interface AsyncInstallationRequest {
  query: string;
  options: any;
  callbackUrl?: string;
}

interface AsyncInstallationResult {
  requestId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message: string;
}

export class AsyncInstallationController {
  private installationRequests: Map<string, AsyncInstallationResult>;
  
  constructor(
    private installationController: InstallationController
  ) {
    this.installationRequests = new Map();
  }

  async installIntegrationAsync(
    query: string,
    options: any,
    callbackUrl?: string
  ): Promise<AsyncInstallationResult> {
    try {
      logger.info('Starting async installation', { query });
      
      // Generate a unique request ID
      const requestId = this.generateRequestId();
      
      // Create a pending result
      const result: AsyncInstallationResult = {
        requestId,
        status: 'pending',
        message: 'Installation request accepted and queued.'
      };
      
      // Store the result
      this.installationRequests.set(requestId, result);
      
      // Start the installation process asynchronously
      this.processInstallationAsync(requestId, query, options, callbackUrl);
      
      return result;
    } catch (error: any) {
      logger.error('Failed to start async installation', {
        query,
        error: error.message
      });
      
      return {
        requestId: this.generateRequestId(),
        status: 'failed',
        message: `Failed to start installation: ${error.message}`
      };
    }
  }

  async getInstallationStatus(requestId: string): Promise<AsyncInstallationResult | null> {
    return this.installationRequests.get(requestId) || null;
  }

  private async processInstallationAsync(
    requestId: string,
    query: string,
    options: any,
    callbackUrl?: string
  ): Promise<void> {
    try {
      // Update status to in_progress
      this.updateInstallationStatus(requestId, 'in_progress', 'Installation in progress...');
      
      // Perform the installation
      const result = await this.installationController.installIntegration(query, options);
      
      // Update the status based on the result
      if (result.success) {
        this.updateInstallationStatus(requestId, 'completed', result.message);
      } else {
        this.updateInstallationStatus(requestId, 'failed', result.message);
      }
      
      // Call the callback URL if provided
      if (callbackUrl) {
        await this.notifyCallback(callbackUrl, this.installationRequests.get(requestId)!);
      }
    } catch (error: any) {
      logger.error('Error in async installation', {
        requestId,
        query,
        error: error.message
      });
      
      // Update status to failed
      this.updateInstallationStatus(requestId, 'failed', `Installation failed: ${error.message}`);
      
      // Call the callback URL if provided
      if (callbackUrl) {
        await this.notifyCallback(callbackUrl, this.installationRequests.get(requestId)!);
      }
    }
  }

  private updateInstallationStatus(
    requestId: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
    message: string
  ): void {
    const result = this.installationRequests.get(requestId);
    
    if (result) {
      result.status = status;
      result.message = message;
      this.installationRequests.set(requestId, result);
    }
  }

  private async notifyCallback(
    callbackUrl: string,
    result: AsyncInstallationResult
  ): Promise<void> {
    try {
      // Simple implementation using fetch API
      await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(result)
      });
    } catch (error: any) {
      logger.error('Failed to notify callback URL', {
        callbackUrl,
        error: error.message
      });
    }
  }

  private generateRequestId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 15);
  }
}