import { gameplayConfigPath, readGameplayConfig } from '../src/gameplayConfig.js';

const path = process.argv[2] ?? gameplayConfigPath();
try {
  const loaded = readGameplayConfig(path);
  console.log(`path: ${loaded.path}`);
  console.log(`activePreset: ${loaded.active.presetName}`);
  console.log(`configHash: ${loaded.active.configHash}`);
  console.log(JSON.stringify(loaded.active, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
