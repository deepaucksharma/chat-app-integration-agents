import Dockerode from 'dockerode';
import * as fs from 'fs';
import * as tar from 'tar-fs';
import { ContainerProvider } from '@core/interfaces/container';
import { ContainerError } from '@core/utils/error-handling';
import { logger } from '@core/utils/logging';

export interface DockerContainerProviderOptions {
  maxPoolSize?: number;
  socketPath?: string;
}

interface ContainerPoolItem {
  container: Dockerode.Container;
  busy: boolean;
  image: string;
  created: Date;
  lastUsed: Date;
}

export class DockerContainerProvider implements ContainerProvider {
  private docker: Dockerode;
  private pool: ContainerPoolItem[];
  private maxPoolSize: number;
  
  constructor(options: DockerContainerProviderOptions = {}) {
    this.docker = new Dockerode({
      socketPath: options.socketPath || '/var/run/docker.sock'
    });
    
    this.maxPoolSize = options.maxPoolSize || 5;
    this.pool = [];
  }
  
  async getContainer(image: string): Promise<string> {
    try {
      logger.debug('Getting container', { image });
      
      // Check if we have an available container in the pool
      const pooledContainer = this.getAvailableContainer(image);
      
      if (pooledContainer) {
        pooledContainer.busy = true;
        pooledContainer.lastUsed = new Date();
        
        return pooledContainer.container.id;
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
            AutoRemove: false
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
        throw new ContainerError('Failed to find a container to reuse');
      }
      
      // Stop and remove the container
      await lruContainer.container.stop();
      await lruContainer.container.remove();
      
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
          AutoRemove: false
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
      
      logger.debug('Container reused', { 
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
  
  async executeCommand(containerId: string, command: string): Promise<{
    exitCode: number;
    output: string;
  }> {
    try {
      logger.debug('Executing command', { containerId, command });
      
      const container = this.docker.getContainer(containerId);
      
      // Create exec instance
      const exec = await container.exec({
        Cmd: ['/bin/bash', '-c', command],
        AttachStdout: true,
        AttachStderr: true
      });
      
      // Start exec instance
      const stream = await exec.start({});
      
      // Collect output
      let output = '';
      
      return new Promise((resolve, reject) => {
        // Handle output
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        
        // Handle end of stream
        stream.on('end', async () => {
          try {
            // Get exit code
            const inspectData = await exec.inspect();
            const exitCode = inspectData.ExitCode;
            
            // Release the container
            this.releaseContainer(containerId);
            
            resolve({ exitCode, output });
          } catch (error: any) {
            reject(new ContainerError(`Failed to get exit code: ${error.message}`, { cause: error }));
          }
        });
        
        // Handle errors
        stream.on('error', (error: Error) => {
          this.releaseContainer(containerId);
          reject(new ContainerError(`Stream error: ${error.message}`, { cause: error }));
        });
      });
    } catch (error: any) {
      // Make sure to release the container even if an error occurs
      this.releaseContainer(containerId);
      
      logger.error('Error executing command', { 
        containerId, 
        command, 
        error: error.message 
      });
      
      throw new ContainerError(`Failed to execute command in container ${containerId}: ${error.message}`, { cause: error });
    }
  }
  
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
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      
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
            fs.promises.rename(extractedPath, localPath)
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
  
  async destroyContainer(containerId: string): Promise<void> {
    try {
      logger.debug('Destroying container', { containerId });
      
      // Find the container in the pool
      const poolIndex = this.pool.findIndex(item => item.container.id === containerId);
      
      if (poolIndex === -1) {
        logger.warn('Container not found in pool', { containerId });
        return;
      }
      
      const container = this.pool[poolIndex].container;
      
      // Stop and remove the container
      await container.stop();
      await container.remove();
      
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
  
  async isContainerHealthy(containerId: string): Promise<boolean> {
    try {
      logger.debug('Checking container health', { containerId });
      
      const container = this.docker.getContainer(containerId);
      
      // Get container info
      const info = await container.inspect();
      
      // Check if the container is running
      if (!info.State.Running) {
        return false;
      }
      
      // If the container has a health check, use that
      if (info.State.Health) {
        return info.State.Health.Status === 'healthy';
      }
      
      // Otherwise, just check if it's running
      return true;
    } catch (error: any) {
      logger.error('Error checking container health', { 
        containerId, 
        error: error.message 
      });
      
      return false;
    }
  }
  
  async cleanup(): Promise<void> {
    try {
      logger.debug('Cleaning up containers');
      
      // Create a copy of the pool
      const poolCopy = [...this.pool];
      
      // Stop and remove all containers
      for (const item of poolCopy) {
        try {
          await item.container.stop();
          await item.container.remove();
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
  
  private getAvailableContainer(image: string): ContainerPoolItem | undefined {
    // Find an available container with the same image
    return this.pool.find(item => !item.busy && item.image === image);
  }
  
  private findLeastRecentlyUsedContainer(): ContainerPoolItem | undefined {
    if (this.pool.length === 0) {
      return undefined;
    }
    
    // Sort by last used date, oldest first
    return this.pool.sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime())[0];
  }
  
  private releaseContainer(containerId: string): void {
    // Find the container in the pool
    const poolItem = this.pool.find(item => item.container.id === containerId);
    
    if (poolItem) {
      poolItem.busy = false;
      poolItem.lastUsed = new Date();
    }
  }
  
  private async pullImage(image: string): Promise<void> {
    try {
      logger.debug('Pulling image', { image });
      
      // Check if image exists locally
      const images = await this.docker.listImages();
      const imageExists = images.some(img => 
        img.RepoTags && img.RepoTags.includes(image)
      );
      
      if (imageExists) {
        logger.debug('Image already exists locally', { image });
        return;
      }
      
      // Parse image name and tag
      const [imageName, tag] = image.split(':');
      
      // Pull the image
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(`${imageName}:${tag || 'latest'}`, {}, (err, stream) => {
          if (err) {
            reject(new ContainerError(`Failed to pull image ${image}: ${err.message}`, { cause: err }));
            return;
          }
          
          this.docker.modem.followProgress(stream, (err) => {
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