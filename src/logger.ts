import pino from 'pino';

const transport =
  process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined;

const rootLogger = pino({ level: 'info', transport });

export function createComponentLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}
