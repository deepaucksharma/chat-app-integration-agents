export interface CommandOptions {
  timeout?: number;
  env?: Record<string, string>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface Container {
  id: string;
  status: string;
  executeCommand(command: string, options?: CommandOptions): Promise<CommandResult>;
  copyFile(source: string, destination: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface ContainerProvider {
  createContainer(image: string, options?: Record<string, any>): Promise<Container>;
  getContainer(id: string): Promise<Container>;
  removeContainer(id: string): Promise<void>;
}

export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  output: string;
  error?: string;
  duration: number;
}

export interface VerificationCheck {
  command: string;
  expectedExitCode: number;
  description: string;
  retryCount?: number;
  retryDelay?: number;
  timeout?: number;
}

export interface VerificationResult {
  success: boolean;
  checks: {
    description: string;
    passed: boolean;
    output?: string;
    error?: string;
  }[];
}

export interface Executor {
  executeScript(container: Container, script: string, timeout?: number): Promise<ExecutionResult>;
  verifyInstallation(container: Container, integration: string, verificationScript: string): Promise<{ success: boolean; output: string; }>;
  executeRollback(container: Container, script: string): Promise<boolean>;
}