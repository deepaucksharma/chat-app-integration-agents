import * as crypto from 'crypto';

export function maskSensitiveData(
  text: string, 
  sensitiveKeys: string[] = ['license_key', 'api_key', 'token', 'password', 'secret']
): string {
  if (!text) return text;
  
  let maskedText = text;
  
  // Mask sensitive keys
  for (const key of sensitiveKeys) {
    // Mask key-value patterns
    const pattern = new RegExp(`(${key}["'=:]{1,3})[^\\s"']+(['"\\s]|$)`, 'gi');
    maskedText = maskedText.replace(pattern, '$1***$2');
    
    // Mask export patterns
    const exportPattern = new RegExp(`(\\b(?:set|export)\\s+${key}\\s*[=:]\\s*)[^\\s;]+([;'"\\s]|$)`, 'gi');
    maskedText = maskedText.replace(exportPattern, '$1***$2');
  }
  
  return maskedText;
}

export function generateSecureId(length: number = 16): string {
  return crypto.randomBytes(length).toString('hex');
}

export function validateIntegrationName(name: string): boolean {
  // Allow only alphanumeric characters, dashes, and underscores
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

export function scanScriptForVulnerabilities(script: string): {
  valid: boolean; 
  issues: { severity: 'low' | 'medium' | 'high' | 'critical'; message: string }[]
} {
  const issues = [];
  
  // Check for potentially dangerous patterns
  const dangerousPatterns = [
    { pattern: /rm\s+(-r|-f|--force|--recursive)\s+\//, severity: 'critical', message: "Dangerous command: Remove from root directory" },
    { pattern: /dd\s+if=.*\s+of=\/dev\/([a-z]+)/, severity: 'critical', message: "Dangerous command: Writing to block device" },
    { pattern: /:(){ :|:& };:/g, severity: 'critical', message: "Dangerous command: Fork bomb detected" },
    { pattern: /wget.+\|\s*sh/, severity: 'high', message: "Dangerous command: Piping download directly to shell" },
    { pattern: /curl.+\|\s*sh/, severity: 'high', message: "Dangerous command: Piping download directly to shell" },
  ];
  
  for (const { pattern, severity, message } of dangerousPatterns) {
    if (pattern.test(script)) {
          issues.push({ severity: severity as 'low' | 'medium' | 'high' | 'critical', message });
        }
  }
  
  // Check for credentials in script
  const credentialPatterns = [
    { pattern: /([a-z0-9]{40})/i, severity: 'medium', message: "Possible API key or token in script" },
    { pattern: /(password|passwd|pwd)=(["'])(?!\*\*\*)([^'"]{4,})/, severity: 'medium', message: "Password found in script" }
  ];
  
  for (const { pattern, severity, message } of credentialPatterns) {
    if (pattern.test(script)) {
          issues.push({ severity: severity as 'low' | 'medium' | 'high' | 'critical', message });
        }
  }
  
  // Consider script safe if no critical issues
  const valid = !issues.some(issue => issue.severity === 'critical');
  
  return { valid, issues };
}