import { exec } from 'child_process';
import { promisify } from 'util';
import { ValidationError } from './error-handling';
import { logger } from './logging';

const execAsync = promisify(exec);

// Regular expressions for sensitive data
const SENSITIVE_PATTERNS = [
  /(?:API[_\s]?KEY|APIKEY|api[_\s]?key)['"]?\s*[:=]\s*['"]?([^'"]+?)['"]?(?:[,\s]|$)/gi,
  /(?:PASSWORD|password|PASS|pass)['"]?\s*[:=]\s*['"]?([^'"]+?)['"]?(?:[,\s]|$)/gi,
  /(?:SECRET|secret)['"]?\s*[:=]\s*['"]?([^'"]+?)['"]?(?:[,\s]|$)/gi,
  /(?:TOKEN|token)['"]?\s*[:=]\s*['"]?([^'"]+?)['"]?(?:[,\s]|$)/gi,
  /(?:KEY|key)['"]?\s*[:=]\s*['"]?([^'"]+?)['"]?(?:[,\s]|$)/gi,
  /(?:ACCESS[_\s]?KEY|access[_\s]?key)['"]?\s*[:=]\s*['"]?([^'"]+?)['"]?(?:[,\s]|$)/gi,
  /LICENSE[_\s]?KEY=['"]([^'"]+)['"]/gi
];

/**
 * Mask sensitive data in text
 */
export function maskSensitiveData(text: string): string {
  if (!text) return text;
  
  let maskedText = text;
  
  // Replace each sensitive pattern with a mask
  SENSITIVE_PATTERNS.forEach(pattern => {
    maskedText = maskedText.replace(pattern, (match, p1) => {
      if (!p1) return match;
      
      // Keep first and last character, mask the rest
      const firstChar = p1.charAt(0);
      const lastChar = p1.charAt(p1.length - 1);
      const maskLength = Math.max(p1.length - 2, 0);
      const mask = '*'.repeat(maskLength);
      
      return match.replace(p1, `${firstChar}${mask}${lastChar}`);
    });
  });
  
  return maskedText;
}

/**
 * Validate integration name to prevent command injection
 */
export function validateIntegrationName(name: string): boolean {
  // Allow only alphanumeric characters, hyphens, and underscores
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  return validPattern.test(name);
}

/**
 * Scan a shell script for potential vulnerabilities using shellcheck
 */
export async function scanScriptForVulnerabilities(
  script: string
): Promise<{ valid: boolean; issues: string[] }> {
  try {
    // Check if shellcheck is installed
    await execAsync('which shellcheck');
  } catch (error) {
    logger.warn('shellcheck not found, skipping script vulnerability scan');
    return { valid: true, issues: ['shellcheck not found, scan skipped'] };
  }
  
  try {
    // Create a temporary file with the script
    const tempFile = `/tmp/script_${Date.now()}.sh`;
    await promisify(require('fs').writeFile)(tempFile, script);
    
    // Run shellcheck with severity info
    const { stdout, stderr } = await execAsync(`shellcheck -f json ${tempFile}`);
    
    // Clean up temporary file
    await promisify(require('fs').unlink)(tempFile);
    
    if (stderr) {
      throw new Error(stderr);
    }
    
    // Parse shellcheck output
    const issues = JSON.parse(stdout);
    
    // Determine validity based on issue levels
    // Consider the script invalid if there are any error-level issues
    const hasErrors = issues.some((issue: any) => issue.level === 'error');
    
    return {
      valid: !hasErrors,
      issues: issues.map((issue: any) => `Line ${issue.line}: ${issue.message} [${issue.level}]`)
    };
  } catch (error: any) {
    logger.error('Error scanning script for vulnerabilities', { 
      error: error.message 
    });
    
    throw new ValidationError(`Failed to scan script: ${error.message}`, { cause: error });
  }
}