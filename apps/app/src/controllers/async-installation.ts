import { InstallationController } from './installation';

export class AsyncInstallationController {
  constructor(
    private installationController: InstallationController
  ) {}

  async installIntegrationAsync(query: string, options: any): Promise<any> {
    // Implementation for installing an integration asynchronously
    console.log(`Asynchronously installing integration with query: ${query} and options:`, options);
    return this.installationController.installIntegration(query, options);
  }
}