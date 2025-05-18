import pino from 'pino';
import os from 'os';

const logLevel = process.env.LOG_LEVEL || 'debug';
const logFilePath = process.env.LOG_FILE_PATH || "./notarium-debug.log";
const logFormat = process.env.LOG_FORMAT; // 'json' or 'text' (default via pino-pretty)
const isTTY = process.stdout.isTTY && process.stderr.isTTY;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const streams: any[] = [];

if (isTTY) {
  // Interactive session: log to stdout (pretty or json based on LOG_FORMAT)
  if (logFormat === 'json') {
    streams.push({ stream: process.stdout, level: logLevel });
  } else {
    try {
      const pretty = (await import('pino-pretty')).default;
      streams.push({ stream: pretty({ colorize: true, sync: true }), level: logLevel });
    } catch (err) {
      console.warn('pino-pretty failed to load, falling back to standard JSON stdout logging for TTY.', err);
      streams.push({ stream: process.stdout, level: logLevel }); 
    }
  }
} else {
  // Non-interactive session (e.g., run by MCP Inspector or as a service):
  // Priority 1: Log to LOG_FILE_PATH if specified.
  // Priority 2: Log JSON to stderr if LOG_FILE_PATH is not specified.
  // stdout should be kept clean for JSON-RPC communication.
  if (!logFilePath) {
    streams.push({ stream: process.stderr, level: logLevel }); 
    console.warn('MCP Notarium: Non-TTY environment and LOG_FILE_PATH not set. Logging JSON to stderr. Set LOG_FILE_PATH for dedicated log file.');
  }
}

// Always add file logging if LOG_FILE_PATH is set, regardless of TTY.
if (logFilePath) {
  try {
    // pino.destination is synchronous by default for files, which is good for process exit.
    // For high performance, async logging can be configured, but sync is safer for ensuring logs are written.
    streams.push({ stream: pino.destination({ dest: logFilePath, sync: true }), level: logLevel });
  } catch (err) {
    // If file logging fails, log an error to stderr (if possible) or console.
    const errorMsg = `Failed to create log file at ${logFilePath}. File logging disabled. Error: ${(err as Error).message}`;
    if (streams.some(s => s.stream === process.stderr)) {
        process.stderr.write(JSON.stringify({level: 50, time: Date.now(), pid: process.pid, hostname: os.hostname(), msg: errorMsg, err }) + '\n');
    } else {
        console.error(errorMsg, err);
    }
  }
}

// If no streams are configured (e.g., non-TTY, no LOG_FILE_PATH, and stderr logging was also disabled for some reason)
// then pino will not log anywhere. This should be avoided by the logic above.
if (streams.length === 0) {
    // This case should ideally not be reached if the logic above correctly defaults to stderr for non-TTY without a file.
    // As a last resort, if somehow no streams, log critical setup error to console.error.
    console.error('CRITICAL: No logging streams configured for Pino. Logging will be disabled.');
    // Fallback to a silent logger if no streams were successfully configured.
    // However, the goal is to always have at least one stream (stderr or file for non-TTY).
}

const pinoOptions: pino.LoggerOptions = {
  level: logLevel,
  base: { pid: process.pid, hostname: os.hostname() },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['SIMPLENOTE_PASSWORD', 'DB_ENCRYPTION_KEY', '*.password', '*.token', '*.secret'],
    censor: '[REDACTED]',
  }
};

const logger = streams.length > 0 
    ? pino(pinoOptions, pino.multistream(streams)) 
    : pino({...pinoOptions, level: 'silent'}); // Fallback to silent logger if no streams

// Initial log to confirm logger is working (will go to configured streams)
logger.info(`Pino logger initialized. Level: ${logLevel}. TTY: ${isTTY}. File: ${logFilePath || 'N/A'}. Streams configured: ${streams.length}`);
if (streams.length === 0) {
    logger.error('Logger initialized but no streams were configured. This is an unexpected state.');
}

export default logger;
