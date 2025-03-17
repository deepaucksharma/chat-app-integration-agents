import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { 
  Container,
  ExecutionResult,
  Executor,
  VerificationCheck,
  VerificationResult
} from '@core/interfaces/execution';
import { maskSensitiveData } from '@core/utils/security';
import { logger } from '@core/utils/logging';
import { withErrorHandling } from '@core/utils/error-handling';

export class DockerExecutor implements Executor {
  private scriptDir: string;
  private sensitiveKeys: string[];
  
  constructor(options: { scriptDir?: string, sensitiveKeys?: string[] } = {}) {
    this.scriptDir = options.scriptDir || os.tmpdir();
    this.sensitiveKeys = options.sensitiveKeys || [
      'license_key', 'api_key', 'token', 'password', 
      'secret', 'credential', 'auth', 'key', 'cert'
    ];
    
    // Ensure script directory exists
    if (!fs.existsSync(this.scriptDir)) {
      fs.mkdirSync(this.scriptDir, { recursive: true });
    }
  }
  
  async executeScript(
    container: Container, 
    script: string, 
    timeout: number = 300
  ): Promise<ExecutionResult> {
    try {
      // Generate a unique script ID
      const scriptId = `script_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const scriptPath = path.join(this.scriptDir, `${scriptId}.sh`);
      const containerScriptPath = `/tmp/${scriptId}.sh`;
      
      // Write script to local file
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      
      try {
        // Copy script to container
        await container.copyFile(scriptPath, containerScriptPath);
        
        // Make script executable
        await container.executeCommand(`chmod +x ${containerScriptPath}`);
        
        // Execute script
        logger.info('Executing script in container', { scriptId, containerId: container.id });
        const result = await container.executeCommand(containerScriptPath, { timeout });
        
        // Mask sensitive data in output
        const maskedOutput = this.maskSensitiveData(result.stdout + '\\n' + result.stderr);
        
        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          output: maskedOutput,
          duration: result.duration
        };
      } finally {
        // Clean up local script file
        if (fs.existsSync(scriptPath)) {
          fs.unlinkSync(scriptPath);
        }
        
        // Clean up container script file
        try {
          await container.executeCommand(`rm -f ${containerScriptPath}`);
        } catch (error) {
          logger.warn('Failed to remove script from container', { 
            scriptId, 
            containerId: container.id 
          });
        }
      }
    } catch (error: any) {
      if (error.message.includes('timed out')) {
        return {
          success: false,
          exitCode: -1,
          output: 'Script execution timed out',
          error: `Execution timed out after ${timeout} seconds`,
          duration: timeout * 1000
        };
      }
      
      logger.error('Error executing script', { error: error.message });
      
      return {
        success: false,
        exitCode: -1,
        output: '',
        error: error.message,
        duration: 0
      };
    }
  }
  
  async verifyInstallation(
    container: Container, 
    checks: VerificationCheck[]
  ): Promise<VerificationResult> {
    const results: VerificationResult = {
      success: true,
      checks: [],
    };

    for (const check of checks) {
      const { command, expectedExitCode, description, retryCount = 0, retryDelay = 5, timeout = 30 } = check;
      
      try {
        const result = await withErrorHandling(
          async () => {
            return await container.executeCommand(command, { timeout });
          },
          {
            retries: retryCount,
            retryDelay: retryDelay * 1000,
            errorHandler: async (error: any) => {
              logger.warn(`Verification check failed, retrying: ${description}`, {
                error: error.message,
                command,
              });
            },
          }
        );

        const passed = result.exitCode === expectedExitCode;

        if (!passed) {
          results.success = false;
        }

        results.checks.push({
          description,
          passed,
          output: result.stdout,
          error: passed ? undefined : result.stderr,
        } as any);

        logger.info(`Verification check ${passed ? 'passed' : 'failed'}: ${description}`, {
          command,
          exitCode: result.exitCode,
          expectedExitCode,
        });
      } catch (error: any) {
        results.success = false;

        results.checks.push({
          description,
          passed: false,
          error: error.message,
        } as any);
        
        logger.error(`Verification check error: ${description}`, { 
          error: error.message, 
          command 
        });
      }
    }
    
    return results;
  }
  
  async executeRollback(
    container: Container, 
    script: string
  ): Promise<boolean> {
    try {
      logger.info('Executing rollback script', { containerId: container.id });
      
      const result = await this.executeScript(container, script, 300);
      
      return result.success;
    } catch (error: any) {
      logger.error('Rollback failed', { error: error.message });
      return false;
    }
  }
  
  private maskSensitiveData(text: string): string {
    return maskSensitiveData(text, this.sensitiveKeys);
  }
}