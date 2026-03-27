import { app } from 'electron';
import { join } from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const isDev = !app.isPackaged;
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');

const consoleFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf((info) => {
    const rawTag = info.tag;
    const tag = typeof rawTag === 'string' ? rawTag : '';
    const prefix = tag ? `[${tag}]` : '';
    const { timestamp, level: lvl, message, tag: _unusedTag, ...meta } = info;
    void _unusedTag;
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${String(timestamp)} ${prefix} ${String(lvl)}: ${String(message)}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp(),
  winston.format.json()
);

const logDir = join(app.getPath('home'), '.fleet', 'logs');

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: isDev
      ? winston.format.combine(winston.format.colorize({ all: true }), consoleFormat)
      : consoleFormat
  }),
  new DailyRotateFile({
    dirname: logDir,
    filename: 'fleet-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '7d',
    format: fileFormat
  })
];

export const logger = winston.createLogger({
  level,
  transports
});

export function createLogger(tag: string): winston.Logger {
  return logger.child({ tag });
}
