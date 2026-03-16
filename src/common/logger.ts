import pc from 'picocolors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  debug(message: string, ...args: any[]) {
    if (this.shouldLog('debug')) {
      console.log(pc.gray(`[DEBUG] ${message}`), ...args);
    }
  }

  info(message: string, ...args: any[]) {
    if (this.shouldLog('info')) {
      console.log(pc.blue(`[INFO] ${message}`), ...args);
    }
  }

  success(message: string, ...args: any[]) {
    if (this.shouldLog('info')) {
      console.log(pc.green(`[SUCCESS] ${message}`), ...args);
    }
  }

  warn(message: string, ...args: any[]) {
    if (this.shouldLog('warn')) {
      console.log(pc.yellow(`[WARN] ${message}`), ...args);
    }
  }

  error(message: string, error?: Error, ...args: any[]) {
    if (this.shouldLog('error')) {
      console.error(pc.red(`[ERROR] ${message}`), ...args);
      if (error && this.level === 'debug') {
        console.error(pc.red(error.stack));
      }
    }
  }
}

export const logger = new Logger();
