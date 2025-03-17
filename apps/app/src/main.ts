import { Client } from '@elastic/elasticsearch';
import { OpenAIEmbeddingsProvider } from '@core/embeddings/openai';
import { ElasticRetriever } from '@core/retrieval/elastic';
import { WebDocumentationProvider } from '@core/documentation/web-provider';
import { DockerContainerProvider } from '@infrastructure/container/docker';
import { DockerExecutor } from '@infrastructure/execution/executor';
import { TemplateScriptGenerator } from '@infrastructure/generation/template';
import { InstallationController } from './controllers/installation';
import { UninstallationController } from './controllers/uninstallation';
import { ResearchController } from './controllers/research';
import { AsyncInstallationController } from './controllers/async-installation';
import { ConfigManager } from '@core/config/manager';
import { logger } from '@core/utils/logging';
import { createCli } from './cli';

async function main() {
  try {
    logger.info('Starting New Relic Integration System');
    
    // Load configuration
    const configManager = new ConfigManager();
    const appConfig = await configManager.load();
    
    // Initialize core components
    const elasticClient = new Client({
      node: appConfig.elasticsearch?.url || 'http://localhost:9200',
      auth: {
        username: appConfig.elasticsearch?.username,
        password: appConfig.elasticsearch?.password
      }
    });
    
    const embeddingsProvider = new OpenAIEmbeddingsProvider(
      appConfig.embeddings?.model || 'text-embedding-3-small'
    );
    
    const retriever = new ElasticRetriever(
      elasticClient,
      embeddingsProvider,
      { indexName: appConfig.elasticsearch?.index || 'newrelic_docs' }
    );
    
    const docProvider = new WebDocumentationProvider({
      baseUrl: appConfig.documentation?.baseUrl,
      cacheDir: appConfig.documentation?.cacheDir,
      cacheTtl: appConfig.documentation?.cacheTtl
    });
    
    // Initialize infrastructure components
    const containerProvider = new DockerContainerProvider({
      maxPoolSize: appConfig.docker?.poolSize || 5
    });
    
    const executor = new DockerExecutor({
      scriptDir: appConfig.execution?.scriptDir
    });
    
    const scriptGenerator = new TemplateScriptGenerator({
      templatesDir: appConfig.templates?.dir,
      cacheSize: appConfig.templates?.cacheSize
    });
    
    // Initialize controllers
    const installationController = new InstallationController(
      retriever,
      executor,
      scriptGenerator,
      containerProvider,
      docProvider
    );
    
    const uninstallationController = new UninstallationController(
      retriever,
      executor,
      scriptGenerator,
      containerProvider,
      docProvider
    );
    
    const researchController = new ResearchController(
      retriever,
      docProvider
    );
    
    const asyncInstallationController = new AsyncInstallationController(
      installationController
    );
    
    // Create and run CLI
    const program = await createCli({
      installationController,
      uninstallationController,
      researchController
    });
    
    await program.parseAsync(process.argv);
  } catch (error: any) {
    logger.error('System initialization error', { 
      error: error.message, 
      stack: error.stack 
    });
    
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}