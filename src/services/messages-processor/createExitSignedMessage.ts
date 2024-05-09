import dotenv from 'dotenv'
import { makeLogger, makeRequest } from 'lido-nanolib'
import { logger as loggerMiddleware, retry, abort, prom } from 'lido-nanolib'
import { makeValidationConfig } from '../config/service.js'
import { makeConsensusApi } from '../consensus-api/service.js'
import { makeMetrics } from '../prom/service.js'
import { makeForkVersionResolver } from '../fork-version-resolver/service.js'
import { makeLocalFileReader } from '../local-file-reader/service.js'
import { makeS3Store } from '../s3-store/service.js'
import { makeGsStore } from '../gs-store/service.js'
import { makeMessagesProcessor } from './service.js'
import { MessageStorage } from '../job-processor/message-storage.js'

const prepareDeps = () => {
  const logger = makeLogger({
    level: 'error',
    format: 'simple',
  })

  const config = makeValidationConfig({ env: process.env })

  const metrics = makeMetrics({ PREFIX: 'validation_script' })
  const consensusApi = makeConsensusApi(
    makeRequest([
      retry(3),
      loggerMiddleware(logger),
      prom(metrics.consensusRequestDurationSeconds),
      abort(30_000),
    ]),
    logger,
    config
  )

  const forkVersionResolver = makeForkVersionResolver(consensusApi, logger, {
    FORCE_DENCUN_FORK_MODE: true,
  })

  const localFileReader = makeLocalFileReader({ logger })

  const s3Service = makeS3Store({ logger })
  const gsService = makeGsStore({ logger })

  const messagesProcessor = makeMessagesProcessor({
    logger,
    config,
    localFileReader,
    consensusApi,
    metrics,
    s3Service,
    gsService,
  })

  const infoLogger = makeLogger({
    level: 'info',
    format: 'simple',
  })

  return { messagesProcessor, logger: infoLogger, forkVersionResolver }
}

prepareDeps().messagesProcessor.createExitSignedMessage(
  '0x8525ba57b77e2812892268603828dfd3b5b69c11e3d86dd52ffb01d12b439aaedf9f6b65a29fcec37c7d42191876e30a'
)
