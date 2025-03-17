import * as Docker from 'dockerode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { Container, CommandOptions, CommandResult, ContainerProvider } from '@core/interfaces/execution';
import { generateSecureId } from '@core/utils/security';
import { logger } from '@core/utils/logging';

export class DockerContainer implements Container {
  public id: string;
  public status: string;
  
  constructor(private docker: Docker, private containerId: string) {
    this.id = containerId;
    this.status = 'created';
  }
  
  async executeCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const container = this.docker.getContainer(this.containerId);
    const startTime = Date.now();
    
    try {
      const exec = await container.exec({
        Cmd: ['bash', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
        Env: options.env ? Object.entries(options.env).map(([key, value]) => `${key}=${value}`) : undefined
      });
      
      const stream = await exec.start({});
      
      return new Promise<CommandResult>((resolve, reject) => {
        const timeout = options.timeout ? 
          setTimeout(() => {
            reject(new Error(`Command execution timed out after ${options.timeout} seconds`));
          }, options.timeout * 1000) 
          : null;
        
        let stdout = '';
        let stderr = '';
        
        stream.on('data', (chunk) => {
          const data = chunk.toString();
          stdout += data;
        });
        
        stream.on('error', (err) => {
          if (timeout) clearTimeout(timeout);
          reject(err);
        });
        
        stream.on('end', async () => {
          if (timeout) clearTimeout(timeout);
          const inspect = await exec.inspect();
          const exitCode = inspect.ExitCode;
          
          resolve({
            exitCode,
            stdout,
            stderr,
            duration: Date.now() - startTime
          });
        });
      });
    } catch (error: any) {
      logger.error('Error executing command in container', { 
        containerId: this.containerId, 
        command, 
        error: error.message 
      });
      
      throw error;
    }
  }
  
  async copyFile(source: string, destination: string): Promise<void> {
    const container = this.docker.getContainer(this.containerId);
    
    try {
      // Create a tar file containing the source file
      const dirName = path.dirname(destination);
      const fileName = path.basename(destination);
      const tarPath = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.tar`);
      
      // Create tar with proper permissions
      const tarCmd = `tar -cf ${tarPath} -C ${path.dirname(source)} ${path.basename(source)}`;
      await new Promise<void>((resolve, reject) => {
        exec(tarCmd, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      
      // Ensure directory exists in container
      await this.executeCommand(`mkdir -p ${dirName}`);
      
      // Copy tar file to container
      const tarStream = fs.createReadStream(tarPath);
      await container.putArchive(tarStream, { path: dirName });
      
      // Rename the file if necessary
      if (path.basename(source) !== fileName) {
        await this.executeCommand(`mv ${dirName}/${path.basename(source)} ${destination}`);
      }
      
      // Cleanup
      fs.unlinkSync(tarPath);
    } catch (error: any) {
      logger.error('Error copying file to container', { 
        containerId: this.containerId, 
        source, 
        destination, 
        error: error.message 
      });
      
      throw error;
    }
  }
  
  async destroy(): Promise<void> {
    try {
      const container = this.docker.getContainer(this.containerId);
      await container.stop();
      await container.remove();
      this.status = 'destroyed';
    } catch (error: any) {
      logger.error('Error destroying container', { 
        containerId: this.containerId, 
        error: error.message 
      });
      
      throw error;
    }
  }
}

export class DockerContainerProvider implements ContainerProvider {
  private docker: Docker;
  private containerPool: ContainerPool;
  
  constructor(options: { maxPoolSize?: number } = {}) {
    this.docker = new Docker();
    this.containerPool = new ContainerPool({
      maxPoolSize: options.maxPoolSize || 5,
      minPoolSize: 1,
      createContainer: this.createNewContainer.bind(this)
    });
    
    // Initialize pool in background
    this.containerPool.initialize().catch(error => {
      logger.error('Error initializing container pool', { error: error.message });
    });
  }
  
  async createContainer(image: string, options: Record<string, any> = {}): Promise<Container> {
    return this.containerPool.getContainer(image);
  }
  
  async getContainer(id: string): Promise<Container> {
    try {
      const container = this.docker.getContainer(id);
      await container.inspect(); // Make sure it exists
      
      return new DockerContainer(this.docker, id);
    } catch (error: any) {
      logger.error('Error getting container', { id, error: error.message });
      throw error;
    }
  }
  
  async removeContainer(id: string): Promise<void> {
    try {
      const container = this.docker.getContainer(id);
      await container.stop();
      await container.remove();
    } catch (error: any) {
      logger.error('Error removing container', { id, error: error.message });
      throw error;
    }
  }
  
  private async createNewContainer(image: string): Promise<Container> {
    try {
      logger.debug('Creating new container', { image });
      
      // Create a new container
      const container = await this.docker.createContainer({
        Image: image,
        Cmd: ['/bin/bash'],
        Tty: true,
        OpenStdin: true,
        StdinOnce: false
      });
      
      await container.start();
      
      return new DockerContainer(this.docker, container.id);
    } catch (error: any) {
      logger.error('Error creating container', { image, error: error.message });
      throw error;
    }
  }
}

// Container Pool Implementation
export class ContainerPool {
  private pools: Map<string, Container[]> = new Map();
  private maxPoolSize: number;
  private minPoolSize: number;
  private createContainerFn: (image: string) => Promise<Container>;
  
  constructor(
    options: {
      maxPoolSize?: number;
      minPoolSize?: number;
      createContainer: (image: string) => Promise<Container>;
    }
  ) {
    this.maxPoolSize = options.maxPoolSize || 5;
    this.minPoolSize = options.minPoolSize || 1;
    this.createContainerFn = options.createContainer;
  }
  
  async initialize(): Promise<void> {
    // Pre-warm pools for common images
    const commonImages = ['ubuntu:22.04', 'centos:7'];
    
    for (const image of commonImages) {
      await this.warmPool(image, this.minPoolSize);
    }
  }
  
  async getContainer(image: string): Promise<Container> {
    // Get or create pool for this image
    let pool = this.pools.get(image);
    if (!pool) {
      pool = [];
      this.pools.set(image, pool);
      
      // Pre-warm the pool
      await this.warmPool(image, this.minPoolSize);
    }
    
    // Get container from pool or create new one
    if (pool.length > 0) {
      return pool.pop()!;
    }
    
    // Create new container if pool is empty
    return this.createContainerFn(image);
  }
  
  async returnContainer(container: Container, image: string): Promise<void> {
    const pool = this.pools.get(image) || [];
    
    // Check if pool has space and container is healthy
    if (pool.length < this.maxPoolSize && await this.isContainerHealthy(container)) {
      pool.push(container);
    } else {
      // Destroy container if pool is full or container is unhealthy
      await container.destroy().catch(err => {
        logger.error(`Error destroying container: ${err.message}`);
      });
    }
  }
  
  async warmPool(image: string, count: number): Promise<void> {
    const pool = this.pools.get(image) || [];
    this.pools.set(image, pool);
    
    // Create containers up to the desired count
    const toCreate = Math.max(0, count - pool.length);
    
    const creationPromises = Array(toCreate)
      .fill(null)
      .map(() => this.createContainerFn(image).then(container => {
        pool.push(container);
      }).catch(err => {
        logger.error(`Error pre-warming container: ${err.message}`);
      }));
    
    await Promise.all(creationPromises);
  }
  
  private async isContainerHealthy(container: Container): Promise<boolean> {
    try {
      const result = await container.executeCommand('echo "healthcheck"');
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
  
  async cleanup(): Promise<void> {
    // Destroy all containers in all pools
    const cleanupPromises: Promise<void>[] = [];
    
    for (const [image, pool] of this.pools.entries()) {
      while (pool.length > 0) {
        const container = pool.pop();
        if (container) {
          cleanupPromises.push(container.destroy().catch(err => {
            logger.error(`Error destroying container during cleanup: ${err.message}`);
          }));
        }
      }
    }
    
    await Promise.all(cleanupPromises);
    this.pools.clear();
  }
}