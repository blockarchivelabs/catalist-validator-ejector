import {  makeLogger } from './lib/logger/index.js'
import { makeRequest } from './lib/request/index.js'
import {
  logger as loggerMiddleware,
  notOkError,
  retry,
  abort,
} from './lib/request/middlewares.js'
import { makeConfig, makeLoggerConfig } from './lib/config/index.js'

export * from './lib/prom/index.js'

export const loggerConfig = makeLoggerConfig()

export const logger = makeLogger({
  // @ts-ignore
  // TODO: fix types
  level: loggerConfig.LOGGER_LEVEL,
  pretty: loggerConfig.LOGGER_PRETTY,
})

export const config = makeConfig()

export const request = makeRequest([
  retry(3),
  loggerMiddleware(logger),
  notOkError(),
  abort(5000),
])
