// In src/config.ts

import dotenv from 'dotenv';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- logger is used by helper functions
import logger from './logging.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- path is used for package.json resolution
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- fs is used for reading package.json
import fs from 'fs';

dotenv.config(); // Load .env file into process.env

let mcpNotariumVersion = 'unknown';
try {
  // Correctly locate package.json in ESM
  const currentFilePath = new URL(import.meta.url).pathname;
  // Assuming config.js is in src/, package.json is one level up.
  const packageJsonPath = path.resolve(path.dirname(currentFilePath), '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  mcpNotariumVersion = packageJson.version || 'unknown';
} catch (err) {
  logger.warn({ err }, 'Could not read package.json to determine MCP_NOTARIUM_VERSION. Defaulting to "unknown".');
}

const OWNER_IDENTITY_SALT_CONSTANT = 'MCPNotarium_SimplenoteUserSalt_v1_a7b3c9d8e2f1_ChangeMePlease';

// --- Temporary Hardcoded Credentials & Defaults for Testing Loop ---
// TODO: Remove hardcoded credentials before commit/production!
const TEMP_HARDCODED_USERNAME = "steipete+simpletest@gmail.com";
const TEMP_HARDCODED_PASSWORD = "MAbVuzegRZ2U9dz7wJHi";
const DEFAULT_LOG_FILE_PATH = "./notarium-server-debug.log"; // Default log file in CWD
const DEFAULT_LOG_LEVEL: AppConfig['LOG_LEVEL'] = 'debug';
// --- End Temporary ---

export interface AppConfig {
  SIMPLENOTE_USERNAME?: string;
  SIMPLENOTE_PASSWORD?: string;
  DB_ENCRYPTION_KEY?: string;
  DB_ENCRYPTION_KDF_ITERATIONS: number;
  SYNC_INTERVAL_SECONDS: number;
  API_TIMEOUT_SECONDS: number;
  LOG_LEVEL: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  LOG_FILE_PATH?: string;
  MCP_NOTARIUM_VERSION: string;
  NODE_VERSION: string;
  OWNER_IDENTITY_SALT: string;
}

function parseIntEnv(envVar: string | undefined, defaultValue: number, varName: string, min?: number, max?: number): number {
  if (envVar === undefined) return defaultValue;
  const parsed = parseInt(envVar, 10);
  if (isNaN(parsed)) {
    logger.warn(`Invalid value for ${varName}: "${envVar}". Using default: ${defaultValue}.`);
    return defaultValue;
  }
  if (min !== undefined && parsed < min) {
    logger.warn(`${varName} (${parsed}) is below minimum (${min}). Using minimum value.`);
    return min;
  }
  if (max !== undefined && parsed > max) {
    logger.warn(`${varName} (${parsed}) is above maximum (${max}). Using maximum value.`);
    return max;
  }
  return parsed;
}

function validateLogLevel(level: string | undefined, fallbackDefault: AppConfig['LOG_LEVEL'] = DEFAULT_LOG_LEVEL): AppConfig['LOG_LEVEL'] {
  const validLevels: AppConfig['LOG_LEVEL'][] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  if (level && validLevels.includes(level as AppConfig['LOG_LEVEL'])) {
    return level as AppConfig['LOG_LEVEL'];
  }
  if (level) { // Log only if an invalid level was actually provided
    logger.warn(`Invalid LOG_LEVEL: "${level}". Defaulting to '${fallbackDefault}'.`);
  }
  return fallbackDefault;
}

export const config: AppConfig = {
  SIMPLENOTE_USERNAME: (process.env.SIMPLENOTE_USERNAME && process.env.SIMPLENOTE_USERNAME.trim() !== "") 
                       ? process.env.SIMPLENOTE_USERNAME.trim() 
                       : TEMP_HARDCODED_USERNAME,
  SIMPLENOTE_PASSWORD: (process.env.SIMPLENOTE_PASSWORD && process.env.SIMPLENOTE_PASSWORD !== "") 
                       ? process.env.SIMPLENOTE_PASSWORD 
                       : TEMP_HARDCODED_PASSWORD,
  DB_ENCRYPTION_KEY: process.env.DB_ENCRYPTION_KEY,
  DB_ENCRYPTION_KDF_ITERATIONS: parseIntEnv(process.env.DB_ENCRYPTION_KDF_ITERATIONS, 310000, 'DB_ENCRYPTION_KDF_ITERATIONS', 10000),
  SYNC_INTERVAL_SECONDS: parseIntEnv(process.env.SYNC_INTERVAL_SECONDS, 300, 'SYNC_INTERVAL_SECONDS', 60),
  API_TIMEOUT_SECONDS: parseIntEnv(process.env.API_TIMEOUT_SECONDS, 30, 'API_TIMEOUT_SECONDS', 5),
  LOG_LEVEL: validateLogLevel(process.env.LOG_LEVEL), // Will use DEFAULT_LOG_LEVEL if env is not valid/set
  LOG_FILE_PATH: process.env.LOG_FILE_PATH || DEFAULT_LOG_FILE_PATH,
  MCP_NOTARIUM_VERSION: mcpNotariumVersion,
  NODE_VERSION: process.version,
  OWNER_IDENTITY_SALT: OWNER_IDENTITY_SALT_CONSTANT,
};

export function validateConfig(): void {
  // Check the final config object which includes hardcoded fallbacks
  if (!config.SIMPLENOTE_USERNAME || config.SIMPLENOTE_USERNAME.trim() === "") { 
    logger.fatal('FATAL: SIMPLENOTE_USERNAME is effectively missing. Ensure it is set in ENV or check hardcoded fallbacks in config.ts.');
    process.exit(1);
  }
  if (!config.SIMPLENOTE_PASSWORD || config.SIMPLENOTE_PASSWORD === "") {
    logger.fatal('FATAL: SIMPLENOTE_PASSWORD is effectively missing. Ensure it is set in ENV or check hardcoded fallbacks in config.ts.');
    process.exit(1);
  }

  if (config.DB_ENCRYPTION_KEY && config.DB_ENCRYPTION_KEY.length < 16) {
    logger.warn('DB_ENCRYPTION_KEY is set but appears to be short. A strong, unique passphrase of at least 16 characters is recommended.');
  }
  // Log the determined file path AFTER basic validation has passed (so logger is definitely working)
  logger.info(`Effective log level: ${config.LOG_LEVEL}. Log file path: ${config.LOG_FILE_PATH}`);
}

/* eslint-disable no-console */
export async function printConfigVars(): Promise<void> {
  console.log('Current MCP Notarium Configuration (NOTE: May show hardcoded test credentials if used):');
  console.log('------------------------------------------------------------------------------------');
  const toPrint = { ...config };

  const isUsernameHardcoded = toPrint.SIMPLENOTE_USERNAME === TEMP_HARDCODED_USERNAME && !process.env.SIMPLENOTE_USERNAME;
  const isPasswordHardcoded = toPrint.SIMPLENOTE_PASSWORD === TEMP_HARDCODED_PASSWORD && !process.env.SIMPLENOTE_PASSWORD;

  if (toPrint.SIMPLENOTE_PASSWORD) {
    toPrint.SIMPLENOTE_PASSWORD = isPasswordHardcoded ? '******** (using hardcoded test default)' : '******** (from ENV)';
  }
  if (toPrint.SIMPLENOTE_USERNAME) {
    toPrint.SIMPLENOTE_USERNAME = isUsernameHardcoded ? `${TEMP_HARDCODED_USERNAME} (using hardcoded test default)` : toPrint.SIMPLENOTE_USERNAME;
  } 

  if (toPrint.DB_ENCRYPTION_KEY) {
    toPrint.DB_ENCRYPTION_KEY = '********';
  }

  for (const [key, value] of Object.entries(toPrint)) {
    let source = '(value from ENV or derived)';
    if (!process.env[key as keyof NodeJS.ProcessEnv]) { // If not set in environment
        if (key === 'SIMPLENOTE_USERNAME' && isUsernameHardcoded) source = '(hardcoded test default)';
        else if (key === 'SIMPLENOTE_PASSWORD' && isPasswordHardcoded) source = '(hardcoded test default)';
        else if (key === 'LOG_LEVEL' && value === DEFAULT_LOG_LEVEL) source = '(config default)';
        else if (key === 'LOG_FILE_PATH' && value === DEFAULT_LOG_FILE_PATH) source = '(config default)';
        else if (key === 'DB_ENCRYPTION_KDF_ITERATIONS' && value === 310000) source = '(config default)';
        else if (key === 'SYNC_INTERVAL_SECONDS' && value === 300) source = '(config default)';
        else if (key === 'API_TIMEOUT_SECONDS' && value === 30) source = '(config default)';
        else if (key === 'MCP_NOTARIUM_VERSION' || key === 'NODE_VERSION' || key === 'OWNER_IDENTITY_SALT') source = '(derived/constant)';
        else source = '(config default or not set)';
    } else if (value === TEMP_HARDCODED_USERNAME || value === '******** (using hardcoded test default)') {
        // Already handled in value modification
        source = (value as string).includes('(using hardcoded test default)') ? '' : '(from ENV, matches hardcoded)';
    }

    console.log(`  ${key}: ${value === undefined ? '<Not Set>' : String(value).replace(TEMP_HARDCODED_PASSWORD, '******** (using hardcoded test default)')} ${source}`);
  }
  console.log('-----------------------------------');
  console.log('Purpose of variables:');
  console.log('  SIMPLENOTE_USERNAME: Your Simplenote email address.');
  console.log('  SIMPLENOTE_PASSWORD: Your Simplenote password.');
  console.log('  DB_ENCRYPTION_KEY: Passphrase to encrypt local cache.');
  console.log(`  DB_ENCRYPTION_KDF_ITERATIONS: PBKDF2 iterations (Default: ${config.DB_ENCRYPTION_KDF_ITERATIONS})`);
  console.log(`  SYNC_INTERVAL_SECONDS: Sync frequency (Default: ${config.SYNC_INTERVAL_SECONDS}s, Min: 60s)`);
  console.log(`  API_TIMEOUT_SECONDS: API call timeout (Default: ${config.API_TIMEOUT_SECONDS}s, Min: 5s)`);
  console.log(`  LOG_LEVEL: Logging verbosity (Default: ${DEFAULT_LOG_LEVEL})`);
  console.log(`  LOG_FILE_PATH: Path for logs (Default: ${DEFAULT_LOG_FILE_PATH})`);
  console.log('  OWNER_IDENTITY_SALT: Salt for DB owner verification (Internal Constant)');
  console.log('  MCP_NOTARIUM_VERSION: Application version (Derived from package.json)');
  console.log('  NODE_VERSION: Node.js version in use (Derived)');

  if (!process.env.SIMPLENOTE_USERNAME || !process.env.SIMPLENOTE_PASSWORD) {
    console.warn('WARNING: SIMPLENOTE_USERNAME or SIMPLENOTE_PASSWORD not set in environment. Using temporary hardcoded test credentials.');
  }
}
/* eslint-enable no-console */ 