import { configureModuleLoader } from "./loader.js";
import {
  createModuleConfigStore,
  type ModuleConfigStore,
} from "../services/module-config-store.js";

/**
 * Production composition boundary for persisted module configurations.
 *
 * The argument is the real Drizzle database in the running API and may be a
 * persistence adapter in focused integration tests.
 */
export function configureRuntimeModuleLoader(
  databaseOrAdapter: unknown,
): ModuleConfigStore {
  const store = createModuleConfigStore(databaseOrAdapter);
  configureModuleLoader({
    listStoredModules: () => store.listActive(),
  });
  return store;
}
