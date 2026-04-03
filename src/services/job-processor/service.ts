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

    for (const [ix, event] of eventsForEject.entries()) {
      if (globalThis.processExitCount > ix) continue

      logger.info(`Handling exit ${ix + 1}/${eventsForEject.length}`, event)

      try {
        if (config.DRY_RUN) {
          logger.info('Not initiating an exit in dry run mode')
          globalThis.processExitCount = ix
          continue
        }

        if (config.VALIDATOR_EXIT_WEBHOOK) {
          await webhookProcessor.send(config.VALIDATOR_EXIT_WEBHOOK, event)
        } else {
          // 기존의 consensusApi.isExiting() 체크 로직 제거
          // 바로 전송 시도
          const result = await messagesProcessor.exit(messageStorage, event)
          
          if (result) {
            // 전송(또는 이미 처리됨) 성공 시 상태를 E(전송완료)로 즉시 변경
            await sendValidatorExitRequest(event.validatorPubkey)
            globalThis.processExitCount = ix
          } else {
            ++count
          }
        }
      } catch (e) {
        logger.error(`Unable to process exit for ${event.validatorPubkey}`, e)
        metrics.exitActions.inc({ result: 'error' })
      }
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
