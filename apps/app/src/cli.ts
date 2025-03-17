import { Command } from 'commander';
import { InstallationController } from './controllers/installation';
import { UninstallationController } from './controllers/uninstallation';
import { ResearchController } from './controllers/research';
import { ConfigManager } from '@core/config/manager';
import { logger } from '@core/utils/logging';

interface CliOptions {
  installationController: InstallationController;
  uninstallationController: UninstallationController;
  researchController: ResearchController;
}

export async function createCli(options: CliOptions): Promise<Command> {
  const { 
    installationController, 
    uninstallationController, 
    researchController 
  } = options;
  
  const program = new Command();
  
  program
    .name('nr-install')
    .description('New Relic Integration Installation System')
    .version('1.0.0');
  
  // Install command
  program
    .command('install <integration>')
    .description('Install a New Relic integration')
    .option('-k, --license-key <key>', 'New Relic license key')
    .option('-c, --config <path>', 'Path to config file')
    .option('-i, --image <image>', 'Docker base image', 'ubuntu:22.04')
    .option('-t, --timeout <seconds>', 'Script execution timeout in seconds', '300')
    .option('--no-verify', 'Skip verification checks')
    .option('--no-rollback', 'Disable automatic rollback on error')
    .option('-v, --verbose', 'Enable verbose logging')
    .option('--dry-run', 'Show script without executing')
    .action(async (integration, cmdOptions) => {
      // Set log level based on verbose flag
      if (cmdOptions.verbose) {
        logger.level = 'debug';
      }
      
      // Load config
      const configManager = new ConfigManager({
        configPath: cmdOptions.config
      });
      await configManager.load();
      
      // Get license key with precedence: command line > env var > config file
      const licenseKey = cmdOptions.licenseKey || 
                         process.env.NEW_RELIC_LICENSE_KEY ||
                         configManager.get<string>('license_key');
      
      if (!licenseKey) {
        console.error('Error: New Relic license key is required. Provide it with --license-key option or set NEW_RELIC_LICENSE_KEY environment variable.');
        process.exit(1);
      }
      
      try {
        const query = `Install the ${integration} integration`;
        
        // Prepare installation options
        const options = {
          licenseKey,
          verify: cmdOptions.verify !== false,
          rollbackOnError: cmdOptions.rollback !== false,
          timeout: parseInt(cmdOptions.timeout, 10),
          baseImage: cmdOptions.image,
          dryRun: cmdOptions.dryRun || false
        };
        
        // Display what we're about to do
        console.log(`Starting installation of ${integration} integration...`);
        
        if (cmdOptions.dryRun) {
          // In dry-run mode, just generate the script and display it
          const script = await installationController.generateScript(integration, options);
          
          console.log('\n--- Installation Script (Dry Run) ---\n');
          console.log(script);
          console.log('\n--- End Script ---\n');
          console.log('Dry run completed. No changes were made.');
          return;
        }
        
        // Execute installation
        const result = await installationController.installIntegration(query, options);
        
        if (result.success) {
          console.log(`✓ ${result.message}`);
          if (result.logs.length > 0) {
            console.log('\nInstallation logs:');
            result.logs.forEach(log => {
              if (log.trim()) console.log(`  ${log}`);
            });
          }
        } else {
          console.error(`✗ ${result.message}`);
          if (result.logs.length > 0) {
            console.error('\nInstallation logs:');
            result.logs.forEach(log => {
              if (log.trim()) console.error(`  ${log}`);
            });
          }
          process.exit(1);
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
  
  // Uninstall command
  program
    .command('uninstall <integration>')
    .description('Uninstall a New Relic integration')
    .option('-c, --config <path>', 'Path to config file')
    .option('-i, --image <image>', 'Docker base image', 'ubuntu:22.04')
    .option('-t, --timeout <seconds>', 'Script execution timeout in seconds', '300')
    .option('--no-verify', 'Skip verification checks')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (integration, cmdOptions) => {
      // Set log level based on verbose flag
      if (cmdOptions.verbose) {
        logger.level = 'debug';
      }
      
      try {
        const query = `Uninstall the ${integration} integration`;
        
        // Prepare uninstallation options
        const options = {
          verify: cmdOptions.verify !== false,
          timeout: parseInt(cmdOptions.timeout, 10),
          baseImage: cmdOptions.image
        };
        
        // Display what we're about to do
        console.log(`Starting uninstallation of ${integration} integration...`);
        
        // Execute uninstallation
        const result = await uninstallationController.uninstallIntegration(query, options);
        
        if (result.success) {
          console.log(`✓ ${result.message}`);
          if (result.logs.length > 0) {
            console.log('\nUninstallation logs:');
            result.logs.forEach(log => {
              if (log.trim()) console.log(`  ${log}`);
            });
          }
        } else {
          console.error(`✗ ${result.message}`);
          if (result.logs.length > 0) {
            console.error('\nUninstallation logs:');
            result.logs.forEach(log => {
              if (log.trim()) console.error(`  ${log}`);
            });
          }
          process.exit(1);
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
  
  // Docs command
  program
    .command('docs <integration> [query]')
    .description('Search documentation for a New Relic integration')
    .option('-f, --format <format>', 'Output format (text, json, markdown)', 'text')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (integration, query, cmdOptions) => {
      // Set log level based on verbose flag
      if (cmdOptions.verbose) {
        logger.level = 'debug';
      }
      
      try {
        const searchQuery = query || `How to use the ${integration} integration`;
        
        // Execute research
        const result = await researchController.research(searchQuery, {
          maxDocumentsPerStep: 5
        });
        
        // Format output based on requested format
        switch (cmdOptions.format) {
          case 'json':
            console.log(JSON.stringify(result, null, 2));
            break;
          case 'markdown':
            console.log(`# ${integration} Integration Documentation\n\n${result.response}\n`);
            if (result.citations && result.citations.length > 0) {
              console.log('\n## References\n');
              result.citations.forEach((citation, index) => {
                console.log(`${index + 1}. [${citation.title}](${citation.url})\n   ${citation.content}\n`);
              });
            }
            break;
          default: // text
            console.log(result.response);
            if (result.citations && result.citations.length > 0) {
              console.log('\nReferences:');
              result.citations.forEach((citation, index) => {
                console.log(`${index + 1}. ${citation.title} - ${citation.url}`);
              });
            }
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
  
  // List command
  program
    .command('list')
    .description('List available New Relic integrations')
    .option('-f, --format <format>', 'Output format (text, json)', 'text')
    .option('-c, --category <category>', 'Filter by category', 'all')
    .action(async (cmdOptions) => {
      // Define available integrations
      const integrations = [
        { name: 'mysql', category: 'database', description: 'MySQL database monitoring' },
        { name: 'postgresql', category: 'database', description: 'PostgreSQL database monitoring' },
        { name: 'redis', category: 'database', description: 'Redis monitoring' },
        { name: 'mongodb', category: 'database', description: 'MongoDB monitoring' },
        { name: 'cassandra', category: 'database', description: 'Cassandra monitoring' },
        { name: 'apache', category: 'web', description: 'Apache HTTP Server monitoring' },
        { name: 'nginx', category: 'web', description: 'Nginx web server monitoring' },
        { name: 'kafka', category: 'messaging', description: 'Apache Kafka monitoring' },
        { name: 'rabbitmq', category: 'messaging', description: 'RabbitMQ monitoring' },
        { name: 'elasticsearch', category: 'database', description: 'Elasticsearch monitoring' },
        { name: 'jmx', category: 'infrastructure', description: 'Java application monitoring via JMX' },
        { name: 'flex', category: 'infrastructure', description: 'Flexible custom integration' }
      ];
      
      // Filter by category if specified
      const filteredIntegrations = cmdOptions.category === 'all' 
        ? integrations
        : integrations.filter(i => i.category === cmdOptions.category);
      
      // Format output based on requested format
      if (cmdOptions.format === 'json') {
        console.log(JSON.stringify(filteredIntegrations, null, 2));
      } else {
        console.log('Available New Relic Integrations:\n');
        
        // Group by category
        const byCategory: Record<string, typeof integrations> = {};
        
        for (const integration of filteredIntegrations) {
          const category = integration.category.charAt(0).toUpperCase() + integration.category.slice(1);
          if (!byCategory[category]) {
            byCategory[category] = [];
          }
          byCategory[category].push(integration);
        }
        
        // Print grouped integrations
        for (const [category, items] of Object.entries(byCategory)) {
          console.log(`${category}:`);
          for (const item of items) {
            console.log(`- ${item.name.padEnd(12)} ${item.description}`);
          }
          console.log('');
        }
        
        console.log('Use \'install <integration>\' to install a specific integration.');
        console.log('Use \'docs <integration>\' to get detailed documentation.');
      }
    });
  
  return program;
}