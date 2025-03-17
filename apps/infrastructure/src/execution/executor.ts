import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Executor, Container } from '@core/interfaces/execution';
import { ContainerProvider } from '@core/interfaces/container';
import { ExecutionError } from '@core/utils/error-handling';
import { maskSensitiveData, scanScriptForVulnerabilities } from '@core/utils/security';
import { logger } from '@core/utils/logging';
import { withErrorHandling } from '@core/utils/error-handling';

interface ExecutorOptions {
  scriptDir?: string;
  defaultTimeout?: number;
}

export class DockerExecutor implements Executor {
  private containerProvider: ContainerProvider;
  private scriptDir: string;
  private defaultTimeout: number;
  
  constructor(
    containerProvider: ContainerProvider,
    options: ExecutorOptions = {}
  ) {
    this.containerProvider = containerProvider;
    this.scriptDir = options.scriptDir || './scripts';
    this.defaultTimeout = options.defaultTimeout || 300; // 5 minutes
    
    // Ensure script directory exists
    fs.mkdir(this.scriptDir, { recursive: true }).catch(err => {
      logger.error('Failed to create script directory', { error: err.message });
    });
  }
  
  async executeScript(
      container: Container,
      script: string,
      timeout?: number
    ): Promise<{
      success: boolean;
      exitCode: number;
      output: string;
      duration: number;
    }> {
      // Create a temporary file for the script
      const tempFile = path.join(
        os.tmpdir(),
        `script_${Date.now()}_${Math.floor(Math.random() * 1000)}.sh`
      );
      
      try {
        // Scan script for vulnerabilities
        const scanResult = await scanScriptForVulnerabilities(script);
        
        if (!scanResult.valid) {
          throw new ExecutionError(`Script contains vulnerabilities: ${scanResult.issues.join(', ')}`);
        }
        
        // Write the script to the temporary file
        await fs.writeFile(tempFile, script, { mode: 0o755 });
        
        // Get container ID from the container object
        const containerId = container.id;
        
        // Copy the script to the container
        const containerScriptPath = '/tmp/script.sh';
        await this.containerProvider.copyFileToContainer(
          containerId,
          tempFile,
          containerScriptPath
        );
        
        // Prepare environment variables
        // let envCommand = '';
        // if (options.env) {
        //   envCommand = Object.entries(options.env)
        //     .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
        //     .join(' && ');
        //
        //   if (envCommand) {
        //     envCommand += ' && ';
        //   }
        // }
        
        // Execute the script
        const startTime = Date.now();
        const { exitCode, output } = await this.containerProvider.executeCommand(
          containerId,
          `chmod +x ${containerScriptPath} && ${containerScriptPath}`
        );
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        // Determine success
        const success = exitCode === 0;
        
        // Log the execution result
        logger.debug('Script execution completed', {
          success,
          exitCode,
          output: maskSensitiveData(output)
        });
        
        return {
          success,
          exitCode,
          output,
          duration
        };
      } catch (error: any) {
        logger.error('Error executing script', { error: error.message });
        
        throw new ExecutionError(`Failed to execute script: ${error.message}`, { cause: error });
      } finally {
        // Clean up temporary file
        try {
          await fs.unlink(tempFile);
        } catch (err) {
          logger.warn('Failed to delete temporary script file', {
            file: tempFile,
            error: err.message
          });
        }
      }
    }
  
  async verifyInstallation(
      container: Container,
      integration: string,
      verificationScript: string
    ): Promise<{
      success: boolean;
      output: string;
    }> {
      // const maxRetries = options.maxRetries || 3;
      // const retryDelay = options.retryDelay || 5000;
      
      // return withErrorHandling(
      //   async () => {
      //     // Execute the verification script
      //     const result = await this.executeScript(
      //       verificationScript,
      //       {
      //         image: options.image,
      //         timeout: options.timeout
      //       }
      //     );
          
      //     if (!result.success) {
      //       throw new ExecutionError(`Verification failed with exit code ${result.exitCode}: ${result.output}`);
      //     }
          
      //     return {
      //       success: true,
      //       output: result.output
      //     };
      //   },
      //   {
      //     retries: maxRetries,
      //     retryDelay,
      //     onError: (error, attempt) => {
      //       logger.warn(`Verification attempt ${attempt + 1} failed`, {
      //         integration,
      //         error: error.message
      //       });
      //     },
      //     onRetry: (attempt) => {
      //       logger.info(`Retrying verification (${attempt}/${maxRetries})`, {
      //         integration
      //       });
      //     }
      //   }
      // );
      return { success: false, output: "Not implemented" };
    }
  
  async executeRollback(
      container: Container,
      script: string
    ): Promise<boolean> {
      try {
        logger.info('Executing rollback script');
        
        // Execute the rollback script
        // const result = await this.executeScript(
        //   rollbackScript,
        //   {
        //     image: options.image,
        //     timeout: options.timeout
        //   }
        // );
        
        // return {
        //   success: result.success,
        //   output: result.output
        // };
        return false;
      } catch (error: any) {
        logger.error('Error executing rollback script', { error: error.message });
        
        // We don't throw here to avoid cascading failures
        return false;
      }
    }
  
  async collectDiagnostics(
      container: Container
    ): Promise<string> {
      try {
        logger.info('Collecting diagnostics');
        
        // Execute a diagnostics script
        const diagnosticScript = `
          #!/bin/bash
          set -e
          
          echo "=== System Information ==="
          uname -a
          
          echo "=== Distribution ==="
          cat /etc/*-release
          
          echo "=== Memory ==="
          free -h
          
          echo "=== Disk ==="
          df -h
          
          echo "=== Installed Packages ==="
          if command -v dpkg > /dev/null; then
            dpkg -l | grep  || echo "Package not found"
          elif command -v rpm > /dev/null; then
            rpm -qa | grep  || echo "Package not found"
          else
            echo "Package manager not found"
          fi
          
          echo "=== Services ==="
          if command -v systemctl > /dev/null; then
            systemctl status  || echo "Service not found"
          elif command -v service > /dev/null; then
            service  status || echo "Service not found"
          else
            echo "Service manager not found"
          fi
          
          echo "=== Logs ==="
          if [ -d /var/log/ ]; then
            ls -la /var/log/
            head -n 50 /var/log/*.log 2>/dev/null || echo "No log files found"
          elif [ -f /var/log/.log ]; then
            head -n 50 /var/log/.log
          else
            echo "No log files found"
          fi
        `;
        
        // const result = await this.executeScript(
        //   diagnosticScript,
        //   {
        //     image: options.image,
        //     timeout: options.timeout || 60
        //   }
        // );
        const result = {success: false, exitCode: 1, output: "Not implemented", duration: 0};
        
        return result.output;
      } catch (error: any) {
        logger.error('Error collecting diagnostics', {
          error: error.message
        });
        
        return `Failed to collect diagnostics: ${error.message}`;
      }
    }
}