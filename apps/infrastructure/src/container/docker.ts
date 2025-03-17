import Dockerode from 'dockerode';
import * as fs from 'fs/promises';
import * as tar from 'tar-fs';
import * as path from 'path';
import { ContainerProvider } from '@core/interfaces/container';
import { ContainerError } from '@core/utils/error-handling';
import { logger } from '@core/utils/logging';

/**
 * Options for configuring the Docker container provider
 */
export interface DockerContainerProviderOptions {
  /** Maximum number of containers to keep in the pool */
  maxPoolSize?: number;
  /** Docker socket path */
  socketPath?: string;
  /** Maximum container age in milliseconds before forced recycling */
  maxContainerAge?: number;
  /** Container timeout in milliseconds */
  containerTimeout?: number;
}

/**
 * Container pool item structure for tracking container state
 */
interface ContainerPoolItem {
  /** The Docker container instance */
  container: Dockerode.Container;
  /** Whether the container is currently in use */
  busy: boolean;
  /** The container's image */
  image: string;
  /** When the container was created */
  created: Date;
  /** When the container was last used */
  lastUsed: Date;
}

/**
 * Docker container provider that manages a pool of containers
 * for efficient reuse and resource management
 */
export class DockerContainerProvider implements ContainerProvider {
  private docker: Dockerode;
  private pool: ContainerPoolItem[];
  private maxPoolSize: number;
  private maxContainerAge: number;
  private containerTimeout: number;
  private cleanupIntervalId?: NodeJS.Timeout;
  
  /**
   * Creates a new Docker container provider
   * @param options - Configuration options for the provider
   */
 constructor(options: DockerContainerProviderOptions = {}) {
   logger.debug('DockerContainerProvider options', { options });
   this.docker = new Dockerode({
     socketPath: options.socketPath || '/var/run/docker.sock'
   });

    this.maxPoolSize = options.maxPoolSize || 5;
    this.maxContainerAge = options.maxContainerAge || 1000 * 60 * 60; // 1 hour default
    this.containerTimeout = options.containerTimeout || 1000 * 60 * 5; // 5 minutes default
    this.pool = [];
    
    // Set up periodic cleanup of idle containers
    this.startCleanupInterval();
  }
  
  /**
   * Starts the periodic cleanup of idle containers
   * @private
   */
  private startCleanupInterval(): void {
    // Clean up idle containers every 15 minutes
    const cleanupInterval = 15 * 60 * 1000; // 15 minutes
    
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupIdleContainers().catch(error => {
        logger.error('Error during idle container cleanup', { error });
      });
    }, cleanupInterval);
  }
  
  /**
   * Stops the periodic cleanup of idle containers
   * @private
   */
  private stopCleanupInterval(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = undefined;
    }
  }
  
  /**
   * Removes idle containers that haven't been used recently
   * @private
   */
  private async cleanupIdleContainers(): Promise<void> {
    logger.debug('Running idle container cleanup');
    
    const now = new Date();
    const idleThreshold = 30 * 60 * 1000; // 30 minutes
    
    // Find idle containers
    const idleContainers = this.pool.filter(item => {
      const idleTime = now.getTime() - item.lastUsed.getTime();
      return !item.busy && idleTime > idleThreshold;
    });
    
    // Remove oldest idle containers if we have more than necessary
    // Always keep at least one idle container of each image type if possible
    const imageCounts: Record<string, number> = {};
    
    // Count idle containers per image
    for (const item of idleContainers) {
      imageCounts[item.image] = (imageCounts[item.image] || 0) + 1;
    }
    
    // Sort idle containers by last used time (oldest first)
    idleContainers.sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime());
    
    // Remove excess idle containers
    for (const item of idleContainers) {
      // If this is the last idle container of this image type, keep it
      if (imageCounts[item.image] <= 1) {
        continue;
      }
      
      try {
        logger.debug('Removing idle container', { 
          containerId: item.container.id,
          image: item.image,
          idleTime: Math.round((now.getTime() - item.lastUsed.getTime()) / 1000) + 's'
        });
        
        await item.container.stop();
        await item.container.remove();
        
        // Remove from pool
        const index = this.pool.findIndex(poolItem => poolItem.container.id === item.container.id);
        if (index !== -1) {
          this.pool.splice(index, 1);
        }
        
        // Decrease count
        imageCounts[item.image]--;
      } catch (error: any) {
        logger.warn('Failed to remove idle container', {
          containerId: item.container.id,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Gets a container with the specified image
   * Will reuse an existing container or create a new one if needed
   * 
   * @param image - The Docker image to use
   * @returns A promise that resolves to the container ID
   */
  async getContainer(image: string): Promise<string> {
    try {
      logger.debug('Getting container', { image });
      
      // Check if we have an available container in the pool
      const pooledContainer = this.getAvailableContainer(image);
      
      if (pooledContainer) {
        // Check if container is healthy before using it
        const isHealthy = await this.isContainerHealthy(pooledContainer.container.id);
        
        if (isHealthy) {
          pooledContainer.busy = true;
          pooledContainer.lastUsed = new Date();
          
          logger.debug('Reusing existing container', { 
            containerId: pooledContainer.container.id, 
            image 
          });
          
          return pooledContainer.container.id;
        } else {
          // Container exists but is not healthy, remove it and create a new one
          logger.warn('Found unhealthy container, removing it', { 
            containerId: pooledContainer.container.id 
          });
          
          try {
            await pooledContainer.container.remove({ force: true });
          } catch (removeError) {
            logger.error('Failed to remove unhealthy container', { 
              containerId: pooledContainer.container.id,
              error: removeError
            });
          }
          
          // Remove from pool
          const index = this.pool.indexOf(pooledContainer);
          if (index !== -1) {
            this.pool.splice(index, 1);
          }
        }
      }
      
      // Create a new container if we have space in the pool
      if (this.pool.length < this.maxPoolSize) {
        logger.debug('Creating new container', { image });
        
        // Pull the image first
        await this.pullImage(image);
        
        // Create container
        const container = await this.docker.createContainer({
          Image: image,
          AttachStdin: false,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          OpenStdin: false,
          StdinOnce: false,
          Cmd: ['/bin/bash'],
          HostConfig: {
            AutoRemove: false,
            SecurityOpt: ['no-new-privileges:true'], // Security enhancement
            NetworkMode: 'bridge', // Ensure network isolation
          }
        });
        
        // Start the container
        await container.start();
        
        // Add to pool
        this.pool.push({
          container,
          busy: true,
          image,
          created: new Date(),
          lastUsed: new Date()
        });
        
        logger.debug('Container created and started', { 
          containerId: container.id, 
          image 
        });
        
        return container.id;
      }
      
      // If we reach here, the pool is full and all containers are busy
      // Find the least recently used container and reuse it
      const lruContainer = this.findLeastRecentlyUsedContainer();
      
      if (!lruContainer) {
        throw new ContainerError('Failed to find a container to reuse - pool is empty');
      }
      
      logger.debug('Reusing container by replacement', { 
        oldContainerId: lruContainer.container.id,
        oldImage: lruContainer.image,
        newImage: image 
      });
      
      // Stop and remove the container
      try {
        await lruContainer.container.stop();
      } catch (error) {
        logger.warn('Failed to stop container gracefully, forcing removal', {
          containerId: lruContainer.container.id
        });
      }
      
      try {
        await lruContainer.container.remove({ force: true });
      } catch (error) {
        logger.error('Failed to remove container', {
          containerId: lruContainer.container.id,
          error
        });
        throw new ContainerError(`Failed to remove container: ${error}`);
      }
      
      // Create a new container with the requested image
      await this.pullImage(image);
      
      const container = await this.docker.createContainer({
        Image: image,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        OpenStdin: false,
        StdinOnce: false,
        Cmd: ['/bin/bash'],
        HostConfig: {
          AutoRemove: false,
          SecurityOpt: ['no-new-privileges:true'],
          NetworkMode: 'bridge',
        }
      });
      
      // Start the container
      await container.start();
      
      // Update the pool item
      const index = this.pool.indexOf(lruContainer);
      this.pool[index] = {
        container,
        busy: true,
        image,
        created: new Date(),
        lastUsed: new Date()
      };
      
      logger.debug('Container replaced', { 
        oldContainerId: lruContainer.container.id,
        newContainerId: container.id, 
        image 
      });
      
      return container.id;
    } catch (error: any) {
      logger.error('Error getting container', { 
        image, 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to get container for image ${image}: ${error.message}`, { cause: error });
    }
  }
  
  /**
   * Executes a command in a container
   * 
   * @param containerId - The ID of the container to run the command in
   * @param command - The command to execute
   * @returns A promise that resolves to the execution result
   */
  async executeCommand(containerId: string, command: string): Promise<{
    exitCode: number;
    output: string;
  }> {
    try {
      logger.debug('Executing command', { 
        containerId, 
        command: command.length > 100 ? command.substring(0, 100) + '...' : command 
      });
      
      const container = this.docker.getContainer(containerId);
      
      // Create exec instance
      const exec = await container.exec({
        Cmd: ['/bin/bash', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
        // Don't allow command to manipulate tty
        Tty: false,
      });
      
      // Start exec instance
      const stream = await exec.start({});
      
      // Collect output
      let output = '';
      
      return new Promise((resolve, reject) => {
        // Set a timeout for the command execution
        const timeoutId = setTimeout(() => {
          this.releaseContainer(containerId);
          reject(new ContainerError(`Command execution timed out after ${this.containerTimeout / 1000} seconds`));
        }, this.containerTimeout);
        
        // Handle output
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        
        // Handle end of stream
        stream.on('end', async () => {
          clearTimeout(timeoutId);
          
          try {
            // Get exit code
            const inspectData = await exec.inspect();
            const exitCode = inspectData.ExitCode ?? -1;

            // Release the container
            this.releaseContainer(containerId);

            resolve({ exitCode, output });
          } catch (error: any) {
            reject(new ContainerError(`Failed to get exit code: ${error.message}`, { cause: error }));
          }
        });
        
        // Handle errors
        stream.on('error', (error: Error) => {
          clearTimeout(timeoutId);
          this.releaseContainer(containerId);
          reject(new ContainerError(`Stream error: ${error.message}`, { cause: error }));
        });
      });
    } catch (error: any) {
      // Make sure to release the container even if an error occurs
      this.releaseContainer(containerId);
      
      logger.error('Error executing command', { 
        containerId, 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to execute command in container ${containerId}: ${error.message}`, { cause: error });
    }
  }
  
  /**
   * Copies a file from the local filesystem to a container
   * 
   * @param containerId - The ID of the container
   * @param localPath - The path of the file on the local filesystem
   * @param containerPath - The destination path in the container
   * @returns A promise that resolves when the file is copied
   */
  async copyFileToContainer(
    containerId: string, 
    localPath: string, 
    containerPath: string
  ): Promise<void> {
    try {
      logger.debug('Copying file to container', { 
        containerId, 
        localPath, 
        containerPath 
      });
      
      // Ensure the file exists locally
      try {
        await fs.access(localPath, fs.constants.R_OK);
      } catch (error) {
        throw new ContainerError(`Local file not found or not readable: ${localPath}`);
      }
      
      const container = this.docker.getContainer(containerId);
      
      // Create a tar archive containing the file
      const tarStream = tar.pack(path.dirname(localPath), {
        entries: [path.basename(localPath)]
      });
      
      // Copy the tar archive to the container
      await container.putArchive(tarStream, {
        path: path.dirname(containerPath)
      });
      
      logger.debug('File copied to container', { 
        containerId, 
        localPath, 
        containerPath 
      });
    } catch (error: any) {
      logger.error('Error copying file to container', { 
        containerId, 
        localPath, 
        containerPath, 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to copy file to container ${containerId}: ${error.message}`, { cause: error });
    }
  }
  
  /**
   * Copies a file from the container to the local filesystem
   * 
   * @param containerId - The ID of the container
   * @param containerPath - The path of the file in the container
   * @param localPath - The destination path on the local filesystem
   * @returns A promise that resolves when the file is copied
   */
  async copyFileFromContainer(
    containerId: string, 
    containerPath: string, 
    localPath: string
  ): Promise<void> {
    try {
      logger.debug('Copying file from container', { 
        containerId, 
        containerPath, 
        localPath 
      });
      
      const container = this.docker.getContainer(containerId);
      
      // Get a tar archive containing the file
      const stream = await container.getArchive({
        path: containerPath
      });
      
      // Ensure the local directory exists
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      
      // Extract the tar archive
      const extractStream = tar.extract(path.dirname(localPath));
      
      return new Promise((resolve, reject) => {
        stream.pipe(extractStream);
        
        extractStream.on('error', (error: Error) => {
          reject(new ContainerError(`Extract error: ${error.message}`, { cause: error }));
        });
        
        extractStream.on('finish', () => {
          // The extracted file will have the same basename as in the container
          const extractedPath = path.join(
            path.dirname(localPath),
            path.basename(containerPath)
          );
          
          // Rename if necessary
          if (extractedPath !== localPath) {
            fs.rename(extractedPath, localPath)
              .then(() => resolve())
              .catch(reject);
          } else {
            resolve();
          }
        });
      });
    } catch (error: any) {
      logger.error('Error copying file from container', { 
        containerId, 
        containerPath, 
        localPath, 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to copy file from container ${containerId}: ${error.message}`, { cause: error });
    }
  }
  
  /**
   * Destroys a container, removing it from the pool
   * 
   * @param containerId - The ID of the container to destroy
   * @returns A promise that resolves when the container is destroyed
   */
  async destroyContainer(containerId: string): Promise<void> {
    try {
      logger.debug('Destroying container', { containerId });
      
      // Find the container in the pool
      const poolIndex = this.pool.findIndex(item => item.container.id === containerId);
      
      if (poolIndex === -1) {
        logger.warn('Container not found in pool', { containerId });
        
        // Try to remove it from Docker anyway
        try {
          const container = this.docker.getContainer(containerId);
          await container.remove({ force: true });
        } catch (error) {
          logger.debug('Could not remove unknown container from Docker', { 
            containerId, 
            error 
          });
        }
        
        return;
      }
      
      const container = this.pool[poolIndex].container;
      
      // Stop and remove the container
      try {
        await container.stop();
      } catch (error) {
        logger.warn('Failed to stop container gracefully, forcing removal', {
          containerId,
          error
        });
      }
      
      try {
        await container.remove({ force: true });
      } catch (error) {
        logger.warn('Failed to remove container', {
          containerId,
          error
        });
      }
      
      // Remove from pool
      this.pool.splice(poolIndex, 1);
      
      logger.debug('Container destroyed', { containerId });
    } catch (error: any) {
      logger.error('Error destroying container', { 
        containerId, 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to destroy container ${containerId}: ${error.message}`, { cause: error });
    }
  }
  
  /**
   * Checks if a container is healthy
   * 
   * @param containerId - The ID of the container to check
   * @returns A promise that resolves to a boolean indicating if the container is healthy
   */
  async isContainerHealthy(containerId: string): Promise<boolean> {
    try {
      logger.debug('Checking container health', { containerId });
      
      const container = this.docker.getContainer(containerId);
      
      // Get container info
      const info = await container.inspect();
      
      // Check if the container is running
      if (!info.State.Running) {
        logger.debug('Container is not running', { containerId });
        return false;
      }
      
      // If the container has a health check, use that
      if (info.State.Health) {
        const isHealthy = info.State.Health.Status === 'healthy';
        logger.debug('Container health check status', { 
          containerId, 
          status: info.State.Health.Status 
        });
        return isHealthy;
      }
      
      // Check if container has been running for too long (might be stuck)
      const startTime = new Date(info.State.StartedAt).getTime();
      const now = Date.now();
      const containerAge = now - startTime;
      
      if (containerAge > this.maxContainerAge) {
        logger.warn('Container has been running for too long', { 
          containerId, 
          ageInHours: Math.round(containerAge / (1000 * 60 * 60) * 10) / 10 
        });
        return false;
      }
      
      // Perform a basic check by running a simple command
      try {
        const exec = await container.exec({
          Cmd: ['echo', 'health check'],
          AttachStdout: true,
          AttachStderr: true
        });
        
        const stream = await exec.start({});
        
        await new Promise<void>((resolve) => {
          stream.on('end', () => resolve());
          stream.on('error', () => resolve());
        });
        
        const inspectData = await exec.inspect();
        return inspectData.ExitCode === 0;
      } catch (error) {
        logger.warn('Container health check command failed', { 
          containerId, 
          error 
        });
        return false;
      }
    } catch (error: any) {
      logger.error('Error checking container health', { 
        containerId, 
        error: error.message 
      });
      
      return false;
    }
  }
  
  /**
   * Cleans up all containers in the pool
   * 
   * @returns A promise that resolves when all containers are cleaned up
   */
  async cleanup(): Promise<void> {
    try {
      logger.debug('Cleaning up containers');
      
      // Stop cleanup interval
      this.stopCleanupInterval();
      
      // Create a copy of the pool to avoid issues while iterating
      const poolCopy = [...this.pool];
      
      // Stop and remove all containers
      for (const item of poolCopy) {
        try {
          await item.container.stop({ t: 10 }); // Give containers 10 seconds to stop
          await item.container.remove({ force: true });
          
          logger.debug('Container cleaned up', { containerId: item.container.id });
        } catch (error: any) {
          logger.warn('Error cleaning up container', {
            containerId: item.container.id,
            error: error.message
          });
        }
      }
      
      // Clear the pool
      this.pool = [];
      
      logger.debug('Container cleanup complete');
    } catch (error: any) {
      logger.error('Error cleaning up containers', { 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to clean up containers: ${error.message}`, { cause: error });
    }
  }
  
  /**
   * Gets an available container for the specified image
   * 
   * @param image - The Docker image to look for
   * @returns A container from the pool or undefined if none are available
   * @private
   */
  private getAvailableContainer(image: string): ContainerPoolItem | undefined {
    // Find an available container with the same image
    return this.pool.find(item => !item.busy && item.image === image);
  }
  
  /**
   * Finds the least recently used container
   * 
   * @returns The least recently used container or undefined if the pool is empty
   * @private
   */
  private findLeastRecentlyUsedContainer(): ContainerPoolItem | undefined {
    if (this.pool.length === 0) {
      return undefined;
    }
    
    // Sort by last used date, oldest first
    const sorted = [...this.pool].sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime());
    return sorted[0];
  }
  
  /**
   * Releases a container, marking it as not busy
   * 
   * @param containerId - The ID of the container to release
   * @private
   */
  private releaseContainer(containerId: string): void {
    // Find the container in the pool
    const poolItem = this.pool.find(item => item.container.id === containerId);
    
    if (poolItem) {
      poolItem.busy = false;
      poolItem.lastUsed = new Date();
      logger.debug('Container released back to pool', { containerId });
    } else {
      logger.warn('Attempted to release unknown container', { containerId });
    }
  }
  
  /**
   * Pulls a Docker image if it doesn't exist locally
   * 
   * @param image - The Docker image to pull
   * @returns A promise that resolves when the image is pulled
   * @private
   */
  private async pullImage(image: string): Promise<void> {
    try {
      logger.debug('Checking for image', { image });
      
      // Check if image exists locally
      const images = await this.docker.listImages();
      const imageExists = images.some(img => 
        img.RepoTags && img.RepoTags.includes(image)
      );
      
      if (imageExists) {
        logger.debug('Image already exists locally', { image });
        return;
      }
      
      logger.info('Pulling image', { image });
      
      // Parse image name and tag
      const [imageName, tag] = image.split(':');
      
      // Pull the image
      await new Promise<void>((resolve, reject) => {
        const pullTimeout = setTimeout(() => {
          reject(new ContainerError(`Image pull timed out after ${this.containerTimeout / 1000} seconds`));
        }, this.containerTimeout);
        
        this.docker.pull(`${imageName}:${tag || 'latest'}`, {}, (err, stream) => {
          if (err) {
            clearTimeout(pullTimeout);
            reject(new ContainerError(`Failed to pull image ${image}: ${err.message}`, { cause: err }));
            return;
          }
          
          if (!stream) {
            clearTimeout(pullTimeout);
            reject(new ContainerError(`Failed to get stream for image ${image}`));
            return;
          }
          
          this.docker.modem.followProgress(stream, (err: any) => {
            clearTimeout(pullTimeout);
            
            if (err) {
              reject(new ContainerError(`Failed to pull image ${image}: ${err.message}`, { cause: err }));
              return;
            }
            
            resolve();
          });
        });
      });
      
      logger.debug('Image pulled successfully', { image });
    } catch (error: any) {
      logger.error('Error pulling image', { 
        image, 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to pull image ${image}: ${error.message}`, { cause: error });
    }
  }
}