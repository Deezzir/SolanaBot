import path from "path"
import { get_keypair, Key, KEYS_DIR, RESERVE_KEY_FILE } from "./common.js"
import { error } from "console"
import { Keypair } from "@solana/web3.js"

interface IConfig {
  ReserveKeypair?: Keypair
}

export class Config {
  public static config: IConfig = {}

  static init(config: IConfig) {
    Config.config = config
  }

  /**
   * Initialize a config value and store it in the cache.
   * @param key - Key to store the config value, should be a key of IConfig
   * @param initMethod - Method to initialize the config value, should return the value
   * @returns
   */
  public static configCacheBoilerplate(key: keyof IConfig, initMethod: () => any) {
    if(Config.config[key]) {
      return Config.config[key]
    }

    Config.config[key] = initMethod()
    return Config.config[key]
  }

  public static get ReserveKeypair() {
    return <Keypair>this.configCacheBoilerplate('ReserveKeypair', () => {
      const RESERVE_KEY_PATH = path.join(KEYS_DIR, RESERVE_KEY_FILE);
      const reserve_keypair = get_keypair(RESERVE_KEY_PATH);
      
      if (!reserve_keypair) {
        error(`[ERROR] Failed to read the reserve key file: ${RESERVE_KEY_PATH}`);
        process.exit(1);
      }

      return reserve_keypair
    })
  }
}