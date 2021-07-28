import fs from 'fs'

import chalk from 'chalk'
import { Logger } from 'vite'

import { debug } from '../lib/logger'
import {
  ensureDirExist,
  exec,
  exists,
  getHash,
  prettyLog,
  resolvePath
} from '../lib/util'

import Downloader from './downloader'
import { BaseSource, GithubSource, CodingSource } from './source'
import VersionManger from './version'
import Config from './config'
import Record from './record'

export type SourceType = 'github' | 'coding' | BaseSource

export type MkcertOptions = {
  /**
   * Automatically upgrade mkcert
   *
   * @default false
   */
  autoUpgrade?: boolean

  /**
   * Specify mkcert download source
   *
   * @default github
   */
  source?: SourceType

  /**
   * If your network is restricted, you can specify a local binary file instead of downloading
   *
   * @description it should be absolute path
   * @default none
   */
  mkcertPath?: string
}

export type MkcertProps = MkcertOptions & {
  logger: Logger
}

const KEY_FILE_PATH = resolvePath('certs/dev.key')
const CERT_FILE_PATH = resolvePath('certs/dev.pem')
class Mkcert {
  private autoUpgrade?: boolean
  private mkcertLocalPath?: string
  private source: BaseSource
  private logger: Logger

  private mkcertSavedPath: string
  private sourceType: SourceType

  private config: Config

  public static create(options: MkcertProps) {
    return new Mkcert(options)
  }

  private constructor(options: MkcertProps) {
    const { autoUpgrade, source, mkcertPath, logger } = options

    this.logger = logger
    this.autoUpgrade = autoUpgrade
    this.mkcertLocalPath = mkcertPath
    this.sourceType = source || 'github'

    if (this.sourceType === 'github') {
      this.source = GithubSource.create()
    } else if (this.sourceType === 'coding') {
      this.source = CodingSource.create()
    } else {
      this.source = this.sourceType
    }

    this.mkcertSavedPath = resolvePath(
      process.platform === 'win32' ? 'mkcert.exe' : 'mkcert'
    )

    this.config = new Config()
  }

  private async getMkcertBinnary() {
    return (await this.checkMkcert())
      ? this.mkcertLocalPath || this.mkcertSavedPath
      : undefined
  }

  /**
   * Check if mkcert exists
   */
  private async checkMkcert() {
    let exist: boolean
    if (this.mkcertLocalPath) {
      exist = await exists(this.mkcertLocalPath)
      this.logger.error(
        chalk.red(
          `${this.mkcertLocalPath} does not exist, please check the mkcertPath paramter`
        )
      )
    } else {
      exist = await exists(this.mkcertSavedPath)
    }
    return exist
  }

  private async getCertificate() {
    const key = await fs.promises.readFile(KEY_FILE_PATH)
    const cert = await fs.promises.readFile(CERT_FILE_PATH)

    return {
      key,
      cert
    }
  }

  private async createCertificate(hostnames: string[]) {
    const hostlist = hostnames.join(' ')
    const mkcertBinnary = await this.getMkcertBinnary()

    if (!mkcertBinnary) {
      debug(
        `Mkcert does not exist, unable to generate certificate for ${hostlist}`
      )
    }

    await ensureDirExist(KEY_FILE_PATH)
    await ensureDirExist(CERT_FILE_PATH)

    const cmd = `${mkcertBinnary} -install -key-file ${KEY_FILE_PATH} -cert-file ${CERT_FILE_PATH} ${hostlist}`

    await exec(cmd)

    this.logger.info(
      `The certificate is saved in:\n${KEY_FILE_PATH}\n${CERT_FILE_PATH}`
    )
  }

  private getLatestHash = async () => {
    return {
      key: await getHash(KEY_FILE_PATH),
      cert: await getHash(CERT_FILE_PATH)
    }
  }

  private async regenerate(record: Record, hosts: string[]) {
    await this.createCertificate(hosts)

    const hash = await this.getLatestHash()

    record.update({ hosts, hash })
  }

  public async init() {
    await this.config.init()
    const exist = await this.checkMkcert()
    if (this.autoUpgrade || !exist) {
      await this.updateMkcert(exist)
    }
  }

  public async updateMkcert(mkcertExist: boolean) {
    const versionManger = new VersionManger({ config: this.config })
    const sourceInfo = await this.source.getSourceInfo()

    if (!sourceInfo) {
      if (typeof this.sourceType === 'string') {
        debug('Failed to request mkcert information, please check your network')
        if (this.sourceType === 'github') {
          debug(
            'If you are a user in china, maybe you should set "source" paramter to "coding"'
          )
        }
      } else {
        debug(
          'Please check your custom "source", it seems to return invalid result'
        )
      }
      debug('Can not get mkcert information, update skipped')
      return
    }

    // if binary exist, compare version
    if (mkcertExist) {
      const versionInfo = versionManger.compare(sourceInfo.version)

      if (!versionInfo.shouldUpdate) {
        debug('Mkcert is kept latest version, update skipped')
        return
      }

      if (versionInfo.breakingChange) {
        debug(
          'The current version of mkcert is %s, and the latest version is %s, there may be some breaking changes, update skipped',
          versionInfo.currentVersion,
          versionInfo.nextVersion
        )
        return
      }

      debug(
        'The current version of mkcert is %s, and the latest version is %s, mkcert will be updated',
        versionInfo.currentVersion,
        versionInfo.nextVersion
      )

      await this.downloadMkcert(sourceInfo.downloadUrl, this.mkcertSavedPath)
      versionManger.update(versionInfo.nextVersion)

    } else {
      debug('mkcert does not exist, download it now')

      await this.downloadMkcert(sourceInfo.downloadUrl, this.mkcertSavedPath)
      versionManger.update(sourceInfo.version)
    }
  }

  public async downloadMkcert(sourceUrl: string, distPath: string) {
    const downloader = Downloader.create()
    await downloader.download(sourceUrl, distPath)
  }

  public async renew(hosts: string[]) {
    const record = new Record({ config: this.config })

    if (!record.contains(hosts)) {
      this.logger.info(
        `The hosts changed from [${record.getHosts()}] to [${hosts}], start regenerate certificate`
      )

      await this.regenerate(record, hosts)
      return
    }

    const hash = await this.getLatestHash()

    if (record.tamper(hash)) {
      this.logger.info(
        `The hash changed from ${prettyLog(
          record.getHash()
        )} to ${prettyLog(hash)}, start regenerate certificate`
      )

      await this.regenerate(record, hosts)
      return
    }

    debug('Neither hosts nor hash has changed, skip regenerate certificate')
  }

  /**
   * Get certificates
   *
   * @param hosts host collection
   * @returns cretificates
   */
  public async install(hosts: string[]) {
    if (hosts.length) {
      await this.renew(hosts)
    }

    return await this.getCertificate()
  }
}

export default Mkcert
