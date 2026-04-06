import type { LoggerService } from 'lido-nanolib'
import type { ExecutionApiService } from '../execution-api/service.js'
import type { ConfigService } from '../config/service.js'
import type { MessagesProcessorService } from '../messages-processor/service.js'
import type { ConsensusApiService } from '../consensus-api/service.js'
import type { WebhookProcessorService } from '../webhook-caller/service.js'
import type { MetricsService } from '../prom/service.js'
import type { MessageStorage } from './message-storage.js'
import type { MessageReloader } from '../message-reloader/message-reloader.js'
import {
  makeRequest,
  logger as loggerMiddleware,
  notOkError,
  abort,
} from 'lido-nanolib'

export type ExitMessage = {
  message: {
    epoch: string
    validator_index: string
  }
  signature: string
}

export type ExitMessageWithMetadata = {
  data: ExitMessage
  meta: {
    fileChecksum: string
    filename: string
    forkVersion: string
  }
}

export type JobProcessorService = ReturnType<typeof makeJobProcessor>

export const makeJobProcessor = ({
  logger,
  config,
  messageReloader,
  executionApi,
  consensusApi,
  messagesProcessor,
  webhookProcessor,
  metrics,
}: {
  logger: LoggerService
  config: ConfigService
  messageReloader: MessageReloader
  executionApi: ExecutionApiService
  consensusApi: ConsensusApiService
  messagesProcessor: MessagesProcessorService
  webhookProcessor: WebhookProcessorService
  metrics: MetricsService
}) => {
  const middlewares = [loggerMiddleware(logger), notOkError(), abort(10000)]
  const request = makeRequest(middlewares)

  const sendValidatorExitRequest = async (validatorPubkey: string) => {
    return await request(
      process.env.VALIDATOR_API + '/validator/exit-message/' + validatorPubkey + '/sent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  const handleJob = async ({
    eventsNumber,
    messageStorage,
  }: {
    eventsNumber: number
    messageStorage: MessageStorage
  }) => {
    logger.info('Job started', {
      operatorId: config.OPERATOR_ID,
      stakingModuleId: config.STAKING_MODULE_ID,
    })

    await messageReloader.reloadAndVerifyMessages(messageStorage)

    // Resolving contract addresses on each job to automatically pick up changes without requiring a restart
    await executionApi.resolveExitBusAddress()
    await executionApi.resolveConsensusAddress()

    const toBlock = await executionApi.latestBlockNumber()
    const fromBlock = toBlock - eventsNumber
    logger.info('Fetched the latest block from EL', { latestBlock: toBlock })

    logger.info('Fetching request events from the Exit Bus', {
      eventsNumber,
      fromBlock,
      toBlock,
    })

    interface ValidatorEvent {
      validatorPubkey: string
      validatorIndex: string
    }

    const eventsForEject = (await executionApi.logs(
      fromBlock,
      toBlock
    )) as ValidatorEvent[]

    logger.info('Handling ejection requests', {
      amount: eventsForEject.length,
    })

    let count = 0

    // 배열을 일정 크기(batchSize)로 나누는 헬퍼 함수
    const chunkArray = <T>(array: T[], size: number): T[][] => {
      const chunked: T[][] = []
      for (let i = 0; i < array.length; i += size) {
        chunked.push(array.slice(i, i + size))
      }
      return chunked
    }

    // N건씩 병렬 처리 설정 (예: 10건씩 묶어서 동시 처리)
    const BATCH_SIZE = 10
    const eventChunks = chunkArray(eventsForEject, BATCH_SIZE)
    let processedCount = 0

    for (const [chunkIndex, chunk] of eventChunks.entries()) {
      logger.info(`Processing batch ${chunkIndex + 1}/${eventChunks.length} (size: ${chunk.length})`)

      // 한 청크 내의 이벤트들은 Promise.all 로 동시(병렬)에 실행
      await Promise.all(
        chunk.map(async (event, idxInChunk) => {
          const absoluteIx = chunkIndex * BATCH_SIZE + idxInChunk

          if (globalThis.processExitCount > absoluteIx) return

          logger.info(`Handling exit ${absoluteIx + 1}/${eventsForEject.length}`, event)

          try {
            if (await consensusApi.isExiting(event.validatorPubkey)) {
              await sendValidatorExitRequest(event.validatorPubkey)
              logger.info('Validator is already exiting(ed) or withdrawal_done, skipping & updated to E')
              globalThis.processExitCount = absoluteIx
              return
            }

            if (config.DRY_RUN) {
              logger.info('Not initiating an exit in dry run mode')
              globalThis.processExitCount = absoluteIx
              return
            }

            if (config.VALIDATOR_EXIT_WEBHOOK) {
              await webhookProcessor.send(config.VALIDATOR_EXIT_WEBHOOK, event)
            } else {
              const result = await messagesProcessor.exit(messageStorage, event)
              
              if (result) {
                await sendValidatorExitRequest(event.validatorPubkey)
                globalThis.processExitCount = absoluteIx
              } else {
                count++
              }
            }
          } catch (e) {
            logger.error(`Unable to process exit for ${event.validatorPubkey}`, e)
            metrics.exitActions.inc({ result: 'error' })
          }
        })
      )
    }

    logger.info('Updating exit messages left metrics from contract state')
    try {
      const lastRequestedValIx =
        await executionApi.lastRequestedValidatorIndex()
      metrics.updateLeftMessages(messageStorage, lastRequestedValIx)
    } catch {
      logger.error(
        'Unable to update exit messages left metrics from contract state'
      )
    }

    logger.info('Job finished')
  }

  return { handleJob }
}
