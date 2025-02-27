import { createLogger, Plugin } from 'vite'

import { PLUGIN_NAME } from './lib/constant'
import { getDefaultHosts } from './lib/util'
import Mkcert, { MkcertOptions } from './mkcert'

export type ViteCertificateOptions = MkcertOptions & {
  /**
   * The hosts that needs to generate the certificate.
   *
   * @default ["localhost","local ip addrs"]
   */
  hosts?: string[]
}

const plugin = (options: ViteCertificateOptions = {}): Plugin => {
  return {
    name: PLUGIN_NAME,
    apply: 'serve',
    config: async config => {
      if (!config.server?.https) {
        return
      }

      const { hosts = getDefaultHosts(), ...mkcertOptions } = options

      const { logLevel } = config
      const logger = createLogger(logLevel, {
        prefix: PLUGIN_NAME
      })
      const mkcert = Mkcert.create({
        logger,
        ...mkcertOptions
      })

      await mkcert.init()

      const uniqueHosts = Array.from(new Set(hosts))
      const certificate = await mkcert.install(uniqueHosts)

      return {
        server: {
          https: {
            ...certificate
          }
        }
      }
    }
  }
}

export default plugin
