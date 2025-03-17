import * as winston from 'winston';
import { maskSensitiveData } from './security';

// Create a custom format that masks sensitive data
const maskFormat = winston.format((info) => {
  const maskedInfo = { ...info };
  
  if (typeof maskedInfo.message === 'string') {
    maskedInfo.message = maskSensitiveData(maskedInfo.message);
  }
  
  // Mask any sensitive data in objects
  if (maskedInfo.meta) {
    maskedInfo.meta = JSON.parse(maskSensitiveData(JSON.stringify(maskedInfo.meta)));
  }
  
  return maskedInfo;
});

// Create logger
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    maskFormat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'new-relic-installer' },
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    // Write all logs with level `error` and below to `error.log`
    new winston.transports.File({ 
      filename: 'logs/error.log',
      level: 'error' 
    }),
    // Write all logs to `combined.log`
    new winston.transports.File({ 
      filename: 'logs/combined.log' 
    })
  ]
});

// If we're not in production, also log to the console with colorized output
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Export a method to update the log level dynamically
export function setLogLevel(level: string): void {
  logger.level = level;
}