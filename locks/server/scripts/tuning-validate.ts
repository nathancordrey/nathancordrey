import { gameplayConfigPath, readGameplayConfig } from '../src/gameplayConfig.js';

const path = process.argv[2] ?? gameplayConfigPath();
try {
  const loaded = readGameplayConfig(path);
  console.log(
    `GAMEPLAY CONFIG VALID path=${loaded.path} active=${loaded.active.presetName} hash=${loaded.active.configHash} presets=${Object.keys(loaded.document.presets).length}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
