import bls from '@chainsafe/bls'
import { decrypt, create } from '@chainsafe/bls-keystore'
import { createHash } from 'crypto'

import { ssz } from '@lodestar/types'
import { fromHex, toHexString } from '@lodestar/utils'
import { DOMAIN_VOLUNTARY_EXIT } from '@lodestar/params'
import { computeDomain, computeSigningRoot } from '@lodestar/state-transition'
import { promises as fs } from 'fs'
import { argv, question, $, glob } from 'zx'
import { readdir, readFile, writeFile } from 'fs/promises'
import { utils } from 'ethers'
import { encryptedMessageDTO, exitOrEthDoExitDTO } from './dto.js'

import type {
  LocalFileReaderService,
  MessageFile,
} from '../local-file-reader/service.js'
import type { ConsensusApiService } from '../consensus-api/service.js'
import type { MetricsService } from '../prom/service.js'
import type { S3StoreService } from '../s3-store/service.js'
import type { GsStoreService } from '../gs-store/service.js'
import type { MessageStorage } from '../job-processor/message-storage.js'
import type { ExitMessageWithMetadata } from '../job-processor/service.js'
import {
  LoggerService,
  makeRequest,
  logger as loggerMiddleware,
  abort,
  notOkError,
  retry,
} from 'lido-nanolib'

import type { ForkVersionResolverService } from '../fork-version-resolver/service.js'

type ExitMessage = {
  message: {
    epoch: string
    validator_index: string
  }
  signature: string
}

type EthDoExitMessage = {
  exit: ExitMessage
  fork_version: string
}

export type MessagesProcessorService = ReturnType<typeof makeMessagesProcessor>

export const makeMessagesProcessor = ({
  logger,
  config,
  localFileReader,
  consensusApi,
  metrics,
  s3Service,
  gsService,
  forkVersionResolver,
}: {
  logger: LoggerService
  config: { MESSAGES_LOCATION?: string | undefined; MESSAGES_PASSWORD?: string }
  localFileReader: LocalFileReaderService
  consensusApi: ConsensusApiService
  metrics: MetricsService
  s3Service: S3StoreService
  gsService: GsStoreService
  forkVersionResolver: ForkVersionResolverService
}) => {
  const invalidExitMessageFiles = new Set<string>()

  const loadNewMessages = async (
    messagesStorage: MessageStorage,
    forkVersion: string
  ) => {
    if (!config.MESSAGES_LOCATION) {
      logger.debug('Skipping loading messages in webhook mode')
      return []
    }

    logger.info(`Loading messages from '${config.MESSAGES_LOCATION}' folder`)

    const folder = await readFolder(config.MESSAGES_LOCATION)

    const messagesWithMetadata: ExitMessageWithMetadata[] = []

    logger.info('Parsing loaded messages')

    for (const [ix, messageFile] of folder.entries()) {
      logger.info(`Parsing loaded messages - ${ix + 1}/${folder.length}`)

      // skipping empty files
      if (messageFile.content === '') {
        logger.warn(`Empty file. Skipping...`)
        invalidExitMessageFiles.add(messageFile.filename)
        continue
      }

      // used for uniqueness of file contents
      const fileChecksum = createHash('sha256')
        .update(messageFile.content)
        .digest('hex')

      if (messagesStorage.touchMessageWithChecksum(fileChecksum)) {
        logger.info(`File already loaded`)

        continue
      }

      let json: Record<string, unknown>
      try {
        json = JSON.parse(messageFile.content)
      } catch (error) {
        logger.warn(`Unparseable JSON in file ${messageFile.filename}`, error)
        invalidExitMessageFiles.add(messageFile.filename)
        continue
      }

      if ('crypto' in json) {
        try {
          json = await decryptMessage(json)
        } catch (e) {
          logger.warn(
            `Unable to decrypt encrypted file: ${messageFile.filename}`
          )
          invalidExitMessageFiles.add(messageFile.filename)
          continue
        }
      }

      let validated: ExitMessage | EthDoExitMessage

      try {
        validated = exitOrEthDoExitDTO(json)
      } catch (e) {
        logger.error(`${messageFile.filename} failed validation:`, e)
        invalidExitMessageFiles.add(messageFile.filename)
        continue
      }

      const message = 'exit' in validated ? validated.exit : validated
      messagesWithMetadata.push({
        data: message,
        meta: {
          fileChecksum: fileChecksum,
          filename: messageFile.filename,
          forkVersion,
        },
      })

      // Unblock event loop for http server responses
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    logger.info(`Loaded ${messagesWithMetadata.length} new messages`)

    return messagesWithMetadata
  }

  const decryptMessage = async (input: Record<string, unknown>) => {
    if (!config.MESSAGES_PASSWORD) {
      throw new Error('Password was not supplied')
    }

    const checked = encryptedMessageDTO(input)

    const content = await decrypt(checked, config.MESSAGES_PASSWORD)

    const stringed = new TextDecoder().decode(content)

    let json: Record<string, unknown>
    try {
      json = JSON.parse(stringed)
    } catch {
      throw new Error('Unparseable JSON after decryption')
    }

    return json
  }

  const verify = async (
    messages: ExitMessageWithMetadata[],
    isDencun: boolean,
    capellaForkVersion: string
  ): Promise<ExitMessageWithMetadata[]> => {
    if (!config.MESSAGES_LOCATION) {
      logger.debug('Skipping messages validation in webhook mode')
      return []
    }

    logger.info('Validating messages')

    const genesis = await consensusApi.genesis()
    const state = await consensusApi.state()

    const validMessagesWithMetadata: ExitMessageWithMetadata[] = []

    for (const [ix, m] of messages.entries()) {
      logger.info(`Validating messages - ${ix + 1}/${messages.length}`)

      const { message, signature: rawSignature } = m.data
      const { validator_index: validatorIndex, epoch } = message

      let validatorInfo: { pubKey: string; isExiting: boolean }
      try {
        validatorInfo = await consensusApi.validatorInfo(validatorIndex)
      } catch (e) {
        logger.error(
          `Failed to get validator info for index ${validatorIndex}`,
          e
        )
        invalidExitMessageFiles.add(m.meta.filename)
        continue
      }

      if (validatorInfo.isExiting) {
        logger.debug(`${validatorInfo.pubKey} exiting(ed), skipping validation`)
        // Assuming here in order to make this optimisation work
        // (if val exited this message had to be valid)
        continue
      }

      const pubKey = fromHex(validatorInfo.pubKey)
      const signature = fromHex(rawSignature)

      const GENESIS_VALIDATORS_ROOT = fromHex(genesis.genesis_validators_root)
      const CURRENT_FORK = fromHex(state.current_version)
      const PREVIOUS_FORK = fromHex(state.previous_version)
      const CAPELLA_FORK_VERSION = fromHex(capellaForkVersion)

      const verifyFork = (fork: Uint8Array) => {
        const domain = computeDomain(
          DOMAIN_VOLUNTARY_EXIT,
          fork,
          GENESIS_VALIDATORS_ROOT
        )

        const parsedExit = {
          epoch: parseInt(epoch, 10),
          validatorIndex: parseInt(validatorIndex, 10),
        }

        const signingRoot = computeSigningRoot(
          ssz.phase0.VoluntaryExit,
          parsedExit,
          domain
        )

        const isValid = bls.verify(pubKey, signingRoot, signature)

        logger.debug(
          `Singature ${
            isValid ? 'valid' : 'invalid'
          } for validator ${validatorIndex} for fork ${toHexString(fork)}`
        )

        return isValid
      }

      let isValid = false

      if (!isDencun) {
        isValid = verifyFork(CURRENT_FORK)
        if (!isValid) isValid = verifyFork(PREVIOUS_FORK)
      } else {
        isValid = verifyFork(CAPELLA_FORK_VERSION)
      }

      // 2025. 9. 18. Harry, Endurance Pectra 업데이트 이후 Validation 부분 비활성화
      // if (!isValid) {
      //   logger.error(`Invalid signature for validator ${validatorIndex}`)
      //   invalidExitMessageFiles.add(m.meta.filename)
      //   continue
      // }

      validMessagesWithMetadata.push(m)
    }

    logger.info('Finished validation', {
      validAmount: validMessagesWithMetadata.length,
    })

    return validMessagesWithMetadata
  }

  const readFolder = async (uri: string): Promise<MessageFile[]> => {
    if (uri.startsWith('s3://')) return s3Service.read(uri)
    if (uri.startsWith('gs://')) return gsService.read(uri)
    return localFileReader.readFilesFromFolder(uri)
  }

  const exit = async (
    messageStorage: MessageStorage,
    event: { validatorPubkey: string; validatorIndex: string }
  ) => {
    let message = messageStorage.findByValidatorIndex(event.validatorIndex)

    if (!message) {
      logger.info(
        `Validator needs to be exited but message was not found. Generating a new one for ${event.validatorPubkey}`
      )

      try {
        // 메시지를 생성하고 생성된 메시지 객체를 곧바로 반환받음
        const newlyCreatedMessage = await createExitSignedMessage(event.validatorPubkey)
        
        if (!newlyCreatedMessage) {
           logger.error(`Failed to generate new exit message for ${event.validatorPubkey}`)
           return false
        }
        
        // 반환받은 단일 메시지를 바로 할당하여 전송 준비
        message = newlyCreatedMessage
      } catch (e) {
        logger.error('[Message Create] Exception', e)
        return false
      }
    }

    try {
      await consensusApi.exitRequest(message)
      logger.info(
        'Voluntary exit message sent successfully to Consensus Layer',
        event
      )
      metrics.exitActions.inc({ result: 'success' })
      // 전송 성공 시 백업 폴더로 이동 처리 (이미 백업 폴더가 있는지 체크하는 게 좋지만 $`mv`로 진행)
      await $`mv ${process.env.MESSAGES_LOCATION}/${event.validatorPubkey}.json ${process.env.MESSAGES_LOCATION}_bak 2>/dev/null || true`
    } catch (e) {
      logger.error(
        'Failed to send out exit message',
        e instanceof Error ? e.message : e
      )
      metrics.exitActions.inc({ result: 'error' })
      return false
    }
    return true
  }

  const createExitSignedMessage = async (validatorPubkey: string): Promise<Readonly<ExitMessage> | null> => {
    const folder = await readFolder('keystore')
    let keystoreFileName: string | null = null

    for (const [ix, keystoreFile] of folder.entries()) {
      let json: Record<string, unknown>
      try {
        json = JSON.parse(keystoreFile.content)
        if ('0x' + json.pubkey === validatorPubkey) {
          keystoreFileName = keystoreFile.filename
          break
        }
      } catch (error) {
        logger.warn(`Unparseable JSON in file ${keystoreFile.filename}`, error)
        continue
      }
    }

    if (keystoreFileName) {
      const tempDir = `./temp_${validatorPubkey}`
      const offlineFile = `offline-preparation_${validatorPubkey}.json`

      try {
        const ETHDO_PATH = process.env.ETHDO_PATH as string
        const resolvedEthdoPath = ETHDO_PATH.startsWith('./') ? `../${ETHDO_PATH}` : ETHDO_PATH

        if (!process.env.KEYSTORE_PASSWARD) {
          console.error('Please set encryption password in .env')
          return null
        }

        if (!process.env.MESSAGES_PASSWORD) {
          console.error('Please set massage password in .env')
          return null
        }

        if (!process.env.CONSENSUS_NODE) {
          console.error('Please set node url in .env')
          return null
        }

        await $`mkdir -p ${tempDir}`

        logger.info(`[Message Create] Fetching network state (create ${offlineFile})`)
        await $`cd ${tempDir} && ${resolvedEthdoPath} validator exit --prepare-offline --connection=${process.env.CONSENSUS_NODE} --timeout=300s --verbose --debug`
        logger.info(`[Message Create] Network state fetched for ${validatorPubkey}`)

        await $`${ETHDO_PATH} --base-dir=${tempDir} wallet create --wallet=wallet`
        await $`cp keystore/${keystoreFileName} ${tempDir}/`
        await $`${ETHDO_PATH} --base-dir=${tempDir} account import --account=wallet/account --keystore="${tempDir}/${keystoreFileName}" --keystore-passphrase="${process.env.KEYSTORE_PASSWARD}" --passphrase=pass --allow-weak-passphrases`

        const output = await $`cd ${tempDir} && ${resolvedEthdoPath} --base-dir=. validator exit --account=wallet/account --passphrase=pass --json --verbose --debug --offline`
        await fs.writeFile(`${tempDir}/${validatorPubkey}.json`, output.stdout)

        await $`${ETHDO_PATH} --base-dir=${tempDir} wallet delete --wallet=wallet`
        logger.info('[Message Create] Done with', validatorPubkey)

        const original = (await readFile(`${tempDir}/${validatorPubkey}.json`)).toString()

        // 파일 쓰기 전에 바로 JSON 파싱하여 반환 객체 생성
        let parsedMessage: ExitMessage | EthDoExitMessage
        try {
          parsedMessage = exitOrEthDoExitDTO(JSON.parse(original))
        } catch (e) {
          logger.error(`Failed validation for generated message for ${validatorPubkey}`, e)
          await $`rm -rf ${tempDir}`
          return null
        }

        const messageData = 'exit' in parsedMessage ? parsedMessage.exit : parsedMessage
        
        // 메모리에 굳이 안 담아도 되게 메타데이터와 함께 리턴
        const forkInfo = await forkVersionResolver.getForkVersionInfo()
        const resultObject = messageData

        // 혹시 나중에 데몬이 뻗었다가 다시 켜질 때를 대비해서(혹은 백업용) messages 폴더에 저장
        const messageBytes = utils.toUtf8Bytes(original)
        const pubkeyBytes = new Uint8Array()
        const store = await create(process.env.MESSAGES_PASSWORD, messageBytes, pubkeyBytes, '')

        await writeFile(
          `${process.env.MESSAGES_LOCATION}/${validatorPubkey}.json`,
          JSON.stringify(store)
        )

        // 임시 폴더 삭제
        await $`rm -rf ${tempDir}`

        return resultObject

      } catch (e) {
        logger.error('[Message Create] Exception', e)
        await $`rm -rf ${tempDir}`
        return null
      }
    }
    return null
  }

  const loadToMemoryStorage = async (
    messagesStorage: MessageStorage,
    forkInfo: {
      currentVersion: string
      capellaVersion: string
      isDencun: boolean
    }
  ): Promise<{
    updated: number
    added: number
    removed: number
    invalidExitMessageFiles: Set<string>
  }> => {
    invalidExitMessageFiles.clear()

    messagesStorage.startUpdateCycle()

    const { isDencun, currentVersion, capellaVersion } = forkInfo

    messagesStorage.removeOldForkVersionMessages(currentVersion)

    const newMessages = await loadNewMessages(messagesStorage, currentVersion)

    const verifiedNewMessages = await verify(
      newMessages,
      isDencun,
      capellaVersion
    )

    const removed = messagesStorage.removeOldMessages()

    const stats = messagesStorage.updateMessages(verifiedNewMessages)

    // updating metrics
    metrics.exitMessages.reset()
    metrics.exitMessages.labels('true').inc(messagesStorage.size)
    metrics.exitMessages.labels('false').inc(invalidExitMessageFiles.size)

    return { ...stats, removed, invalidExitMessageFiles }
  }

  return { exit, loadToMemoryStorage, createExitSignedMessage }
}
