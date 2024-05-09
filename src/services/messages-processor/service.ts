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
import type { LoggerService } from 'lido-nanolib'
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
}: {
  logger: LoggerService
  config: { MESSAGES_LOCATION?: string | undefined; MESSAGES_PASSWORD?: string }
  localFileReader: LocalFileReaderService
  consensusApi: ConsensusApiService
  metrics: MetricsService
  s3Service: S3StoreService
  gsService: GsStoreService
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
      logger.debug(`${ix + 1}/${folder.length} 11`)

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
      logger.debug(`${ix + 1}/${messages.length}`)

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

      if (!isValid) {
        logger.error(`Invalid signature for validator ${validatorIndex}`)
        invalidExitMessageFiles.add(m.meta.filename)
        continue
      }

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
    const message = messageStorage.findByValidatorIndex(event.validatorIndex)

    if (!message) {
      logger.error(
        'Validator needs to be exited but required message was not found / accessible!'
      )
      metrics.exitActions.inc({ result: 'error' })

      try {
        await createExitSignedMessage(event.validatorPubkey)
      } catch (e) {
        logger.error('[Message Create] Exception', e)
      }

      return
    }

    try {
      await consensusApi.exitRequest(message)
      logger.info(
        'Voluntary exit message sent successfully to Consensus Layer',
        event
      )
      metrics.exitActions.inc({ result: 'success' })
    } catch (e) {
      logger.error(
        'Failed to send out exit message',
        e instanceof Error ? e.message : e
      )
      metrics.exitActions.inc({ result: 'error' })
    }
  }

  const createExitSignedMessage = async (validatorPubkey: string) => {
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
      try {
        const ETHDO_PATH = process.env.ETHDO_PATH

        if (!process.env.KEYSTORE_PASSWARD) {
          console.error('Please set encryption password in .env')
          return
        }

        if (!process.env.MESSAGES_PASSWORD) {
          console.error('Please set massage password in .env')
          return
        }

        if (!process.env.CONSENSUS_NODE) {
          console.error('Please set node url in .env')
          return
        }

        logger.info(
          `[Message Create] Fetching network state (create offline-preparation.json)`
        )
        await $`${ETHDO_PATH} validator exit --prepare-offline --connection=${process.env.CONSENSUS_NODE} --timeout=300s --verbose --debug`
        logger.info(`[Message Create] Network state fetched`)

        logger.info('[Message Create] Doing', validatorPubkey)

        // Importing keystore to ethdo
        await $`${ETHDO_PATH} --base-dir=./temp wallet create --wallet=wallet`
        await $`${ETHDO_PATH} --base-dir=./temp account import --account=wallet/account --keystore="keystore/${keystoreFileName}" --keystore-passphrase="${process.env.KEYSTORE_PASSWARD}" --passphrase=pass --allow-weak-passphrases`

        // Generating an exit message, catching command output and writing to file
        const output =
          await $`${ETHDO_PATH} --base-dir=./temp validator exit --account=wallet/account --passphrase=pass --json --verbose --debug --offline`
        await fs.writeFile(`temp/${validatorPubkey}.json`, output.stdout)

        // Cleaning up
        await $`${ETHDO_PATH} --base-dir=./temp wallet delete --wallet=wallet`
        logger.info('[Message Create] Done with', validatorPubkey)

        await $`rm offline-preparation.json`

        const original = (
          await readFile(`temp/${validatorPubkey}.json`)
        ).toString()

        const message = utils.toUtf8Bytes(original)
        const pubkey = new Uint8Array()
        const path = ''

        const store = await create(
          process.env.MESSAGES_PASSWORD,
          message,
          pubkey,
          path
        )

        await writeFile(
          `${process.env.MESSAGES_LOCATION}/${validatorPubkey}.json`,
          JSON.stringify(store)
        )
      } catch (e) {
        const ETHDO_PATH = process.env.ETHDO_PATH
        try {
          await $`${ETHDO_PATH} --base-dir=./temp wallet delete --wallet=wallet`
          await $`rm offline-preparation.json`
        } catch (e) {}
        logger.error('[Message Create] Exception', e)
      }
    }
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
