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
import { logger, setLogLevel } from '@core/utils/logging';
import { createCli } from './cli';

async function main() {
  try {
    logger.info('Starting New Relic Integration System');
    
    // Load configuration
    const configManager = new ConfigManager();
    const appConfig = await configManager.load();
    
    // Set log level based on configuration
    if (appConfig.logLevel) {
      setLogLevel(appConfig.logLevel);
    }
    
    // Initialize core components
    const elasticClient = new Client({
      node: appConfig.elasticsearch?.url || 'http://localhost:9200',
      auth: appConfig.elasticsearch?.apiKey 
        ? { apiKey: appConfig.elasticsearch.apiKey }
        : { 
            username: appConfig.elasticsearch?.username || 'elastic',
            password: appConfig.elasticsearch?.password || 'changeme'
          }
    });
    
    const embeddingsProvider = new OpenAIEmbeddingsProvider({
      model: appConfig.embeddings?.model || 'text-embedding-3-small',
      apiKey: appConfig.embeddings?.apiKey || process.env.OPENAI_API_KEY
    });
    
    const retriever = new ElasticRetriever(
      elasticClient,
      embeddingsProvider,
      { 
        indexName: appConfig.elasticsearch?.index || 'newrelic_docs',
        dimensions: 1536
      }
    );
    
    const docProvider = new WebDocumentationProvider({
      baseUrl: appConfig.documentation?.baseUrl || 'https://docs.newrelic.com',
      cacheDir: appConfig.documentation?.cacheDir || './cache/docs',
      cacheTtl: appConfig.documentation?.cacheTtl || 86400,
      maxCacheSize: appConfig.documentation?.maxCacheSize || 100
    });
    
    // Initialize infrastructure components
    const containerProvider = new DockerContainerProvider({
      maxPoolSize: appConfig.docker?.poolSize || 5
    });
    
    const scriptGenerator = new TemplateScriptGenerator({
      templatesDir: appConfig.templates?.dir || './templates',
      cacheSize: appConfig.templates?.cacheSize || 100
    });
    
    const executor = new DockerExecutor(
      containerProvider,
      {
        scriptDir: appConfig.execution?.scriptDir || './scripts',
        defaultTimeout: appConfig.execution?.timeout || 300
      }
    );
    
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