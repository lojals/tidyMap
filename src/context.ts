import type { Config } from './config.js';
import type { Db } from './db/client.js';

export interface AppContext {
  db: Db;
  config: Config;
}
