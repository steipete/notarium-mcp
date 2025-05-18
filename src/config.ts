//import dotenv from 'dotenv';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import logger from './logging.js'; // Logger is used by helper functions, so import is not unused
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import fs from 'fs';
import { z } from 'zod';

//dotenv.config(); // Load .env file into process.env

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let mcpNotariumVersion = 'unknown';

// MCP_NOTARIUM_VERSION is read from package.json
// The import.meta.url check is for ESM environments to correctly locate package.json relative to the current module.
try {
  const currentFilePath = new URL(import.meta.url).pathname;
  const packageJsonPath = path.resolve(path.dirname(currentFilePath), '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  mcpNotariumVersion = packageJson.version || 'unknown';
} catch (err) {
  logger.warn(
    { err },
    'Could not read package.json to determine MCP_NOTARIUM_VERSION. Defaulting to "unknown".',
  );
}

// As per spec 5. Salt for Owner Identity Hash: A hard-coded, unique, long, random string constant.
// Replace this placeholder with a newly generated, truly random string for any production-like deployment.
const OWNER_IDENTITY_SALT_CONSTANT =
  'GENERATED_RANDOM_HEX_STRING_REPLACE_ME_32_CHARS'; // IMPORTANT: Replace with a unique, cryptographically secure random 32-character hex string

const DEFAULT_LOG_FILE_PATH = "./notarium-debug.log"; // Default log file

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

function parseIntEnv(
  envVar: string | undefined,
  defaultValue: number,
  varName: string,
  min?: number,
  max?: number,
): number {
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

function validateLogLevel(
  level: string | undefined,
  defaultValue: AppConfig['LOG_LEVEL'] = 'debug',
): AppConfig['LOG_LEVEL'] {
  const validLevels: AppConfig['LOG_LEVEL'][] = [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
  ];
  const lowerCaseLevel = level?.toLowerCase();
  if (lowerCaseLevel && validLevels.includes(lowerCaseLevel as AppConfig['LOG_LEVEL'])) {
    return lowerCaseLevel as AppConfig['LOG_LEVEL'];
  }
  if (level) {
    logger.warn(`Invalid LOG_LEVEL: "${level}". Defaulting to '${defaultValue}'.`);
  }
  return defaultValue;
}

export const config: AppConfig = {
  SIMPLENOTE_USERNAME: process.env.SIMPLENOTE_USERNAME,
  SIMPLENOTE_PASSWORD: process.env.SIMPLENOTE_PASSWORD,
  DB_ENCRYPTION_KEY: process.env.DB_ENCRYPTION_KEY,
  DB_ENCRYPTION_KDF_ITERATIONS: parseIntEnv(
    process.env.DB_ENCRYPTION_KDF_ITERATIONS,
    310000,
    'DB_ENCRYPTION_KDF_ITERATIONS',
    10000,
  ),
  SYNC_INTERVAL_SECONDS: parseIntEnv(
    process.env.SYNC_INTERVAL_SECONDS,
    300,
    'SYNC_INTERVAL_SECONDS',
    60,
  ),
  API_TIMEOUT_SECONDS: parseIntEnv(process.env.API_TIMEOUT_SECONDS, 30, 'API_TIMEOUT_SECONDS', 5),
  LOG_LEVEL: validateLogLevel(process.env.LOG_LEVEL, 'debug'),
  LOG_FILE_PATH: process.env.LOG_FILE_PATH || DEFAULT_LOG_FILE_PATH,
  MCP_NOTARIUM_VERSION: mcpNotariumVersion,
  NODE_VERSION: process.version,
  OWNER_IDENTITY_SALT: OWNER_IDENTITY_SALT_CONSTANT,
};

export function validateConfig(): void {
  if (!config.SIMPLENOTE_USERNAME) {
    logger.fatal('Missing SIMPLENOTE_USERNAME in environment variables. This is a required configuration.');
    process.exit(1);
  }
  if (!config.SIMPLENOTE_PASSWORD) {
    logger.fatal('Missing SIMPLENOTE_PASSWORD in environment variables. This is a required configuration.');
    process.exit(1);
  }

  if (config.DB_ENCRYPTION_KEY && config.DB_ENCRYPTION_KEY.length < 16) {
    logger.warn(
      'DB_ENCRYPTION_KEY is set but appears to be short. A strong, unique passphrase of at least 16 characters is recommended.',
    );
  }
  logger.info(`Logging to file: ${config.LOG_FILE_PATH} (Level: ${config.LOG_LEVEL})`);
}

/* eslint-disable no-console */
export async function printConfigVars(): Promise<void> {
  console.log('Current MCP Notarium Configuration:');
  console.log('------------------------------------------------------------------------------------');
  const toPrint = { ...config };

  if (toPrint.SIMPLENOTE_PASSWORD) {
    toPrint.SIMPLENOTE_PASSWORD = '******** (from ENV)';
  } else {
    toPrint.SIMPLENOTE_PASSWORD = '<Not Set - Required>';
  }
  if (toPrint.SIMPLENOTE_USERNAME) {
    toPrint.SIMPLENOTE_USERNAME = `${toPrint.SIMPLENOTE_USERNAME} (from ENV)`;
  } else {
    toPrint.SIMPLENOTE_USERNAME = '<Not Set - Required>';
  }

  if (toPrint.DB_ENCRYPTION_KEY) {
    toPrint.DB_ENCRYPTION_KEY = '********';
  }

  for (const [key, value] of Object.entries(toPrint)) {
    let source = '(derived or default)'; // Simplified source
    if (process.env[key as keyof NodeJS.ProcessEnv] !== undefined) {
      source = `(from ENV: ${key})`;
    } else if (key === 'MCP_NOTARIUM_VERSION' || key === 'NODE_VERSION') {
      source = '(derived)';
    } else if (key === 'OWNER_IDENTITY_SALT') {
      source = '(hardcoded constant)';
    } else if (key === 'LOG_FILE_PATH' && value === DEFAULT_LOG_FILE_PATH && !process.env.LOG_FILE_PATH) {
      source = '(default path)';
    } else if (key === 'LOG_LEVEL' && value === 'debug' && !process.env.LOG_LEVEL) {
      source = '(default level)';
    } else if (value === undefined && (key === 'SIMPLENOTE_USERNAME' || key === 'SIMPLENOTE_PASSWORD')) {
      source = '(Required, Not Set!)';
    } else if (value === undefined) {
      source = '(default or not set)';
    }

    console.log(`  ${key}: ${value === undefined ? '<Not Set>' : value} ${source}`);
  }
  console.log('-----------------------------------');
  console.log('Purpose of variables:');
  console.log('  SIMPLENOTE_USERNAME: Your Simplenote email address. (Required)');
  console.log('  SIMPLENOTE_PASSWORD: Your Simplenote password. (Required)');
  console.log('  DB_ENCRYPTION_KEY: Passphrase to encrypt local cache. (Optional)');
  console.log('  DB_ENCRYPTION_KDF_ITERATIONS: PBKDF2 iterations. (Default: 310000)');
  console.log('  SYNC_INTERVAL_SECONDS: Sync frequency. (Default: 300s, Min: 60s)');
  console.log('  API_TIMEOUT_SECONDS: API call timeout. (Default: 30s, Min: 5s)');
  console.log('  LOG_LEVEL: Logging verbosity. (Default: debug)');
  console.log(`  LOG_FILE_PATH: Path for logs. (Default: ${DEFAULT_LOG_FILE_PATH})`);
  console.log(`  OWNER_IDENTITY_SALT: Salt for DB owner verification. (Internal Constant - Ensure this is unique and secret!)`);
  console.log('  MCP_NOTARIUM_VERSION: Application version. (Derived)');
  console.log('  NODE_VERSION: Node.js version. (Derived)');

  if (!config.SIMPLENOTE_USERNAME || !config.SIMPLENOTE_PASSWORD) {
    console.warn('WARNING: Critical Simplenote credentials (SIMPLENOTE_USERNAME, SIMPLENOTE_PASSWORD) are missing from environment variables. The application will not start.');
  }
}
/* eslint-enable no-console */

// Initial validation call when module is loaded, typically after logger is available if imported elsewhere.
// This ensures that if any part of the app imports `config`, it's validated.
// However, this can be problematic if logger itself depends on config for log level during its own init.
// A common pattern is to have a dedicated init function called by main.
// For now, let's assume logger is minimally available for fatal errors if config validation fails here.
// Or, defer validateConfig() to be called explicitly in main() after logger is fully set up.
// The spec states: "If required variables are missing, the server MUST log a CRITICAL error and EXIT 1."
// This should happen early in startup. So, validateConfig() will be called in `main()` in `index.ts`.
