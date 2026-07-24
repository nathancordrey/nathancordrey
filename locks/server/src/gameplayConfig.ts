import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_GAMEPLAY_TUNING,
  type GameplayTuning,
  type RuntimeGameplayConfig,
} from '../../client/src/shared/config.js';

export type GameplayConfigDocument = {
  activePreset: string;
  presets: Record<string, GameplayTuning>;
};

export type LoadedGameplayConfig = {
  path: string;
  document: GameplayConfigDocument;
  active: RuntimeGameplayConfig;
};

const REPOSITORY_DEFAULT_PATH = fileURLToPath(
  new URL('../config/gameplay.defaults.json', import.meta.url)
);

let lastValid: LoadedGameplayConfig | null = null;

export function gameplayConfigPath(): string {
  const explicit = process.env.GAMEPLAY_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  return process.env.NODE_ENV === 'production'
    ? '/etc/locks/gameplay.json'
    : REPOSITORY_DEFAULT_PATH;
}

export function validateGameplayConfigDocument(value: unknown): GameplayConfigDocument {
  if (!isRecord(value)) throw new Error('Root must be a JSON object.');

  const activePreset = stringValue(value.activePreset, 'activePreset');
  if (!isRecord(value.presets)) throw new Error('presets must be a JSON object.');

  const presets: Record<string, GameplayTuning> = {};
  for (const [name, rawPreset] of Object.entries(value.presets)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) {
      throw new Error(`Invalid preset name ${JSON.stringify(name)}.`);
    }
    presets[name] = validatePreset(rawPreset, `presets.${name}`);
  }

  if (Object.keys(presets).length === 0) throw new Error('At least one preset is required.');
  if (presets[activePreset] === undefined) {
    throw new Error(`activePreset ${JSON.stringify(activePreset)} is not defined in presets.`);
  }

  return { activePreset, presets };
}

export function readGameplayConfig(path = gameplayConfigPath()): LoadedGameplayConfig {
  if (!existsSync(path)) {
    throw new Error(`Gameplay config file does not exist: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${path}: ${message}`);
  }

  const document = validateGameplayConfigDocument(parsed);
  const values = document.presets[document.activePreset];
  const configHash = gameplayConfigHash(document.activePreset, values);
  return {
    path,
    document,
    active: {
      presetName: document.activePreset,
      configHash,
      ...values,
    },
  };
}

/**
 * Read the file for each new room. A malformed edit never changes existing
 * rooms and cannot take the server down: the last valid preset remains active.
 */
export function loadGameplayConfigForNewRoom(): LoadedGameplayConfig {
  const path = gameplayConfigPath();
  try {
    const loaded = readGameplayConfig(path);
    lastValid = loaded;
    return loaded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (lastValid !== null) {
      console.error(
        `[locks-game][tuning] invalid config; keeping preset=${lastValid.active.presetName} hash=${lastValid.active.configHash}: ${message}`
      );
      return lastValid;
    }

    // First-room safety fallback. Production still logs the missing/bad file,
    // while gameplay remains available with repository defaults.
    const fallbackValues = { ...DEFAULT_GAMEPLAY_TUNING };
    const fallback: LoadedGameplayConfig = {
      path,
      document: { activePreset: 'baseline', presets: { baseline: fallbackValues } },
      active: {
        presetName: 'baseline',
        configHash: gameplayConfigHash('baseline', fallbackValues),
        ...fallbackValues,
      },
    };
    lastValid = fallback;
    console.error(
      `[locks-game][tuning] could not load ${path}; using built-in baseline hash=${fallback.active.configHash}: ${message}`
    );
    return fallback;
  }
}

export function gameplayConfigHash(name: string, values: GameplayTuning): string {
  const canonical = JSON.stringify({
    name,
    cameraZoom: values.cameraZoom,
    playerVisionRadius: values.playerVisionRadius,
    shotRange: values.shotRange,
    lockAcquireMs: values.lockAcquireMs,
    playerSpeed: values.playerSpeed,
    respawnTimeMs: values.respawnTimeMs,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

function validatePreset(value: unknown, path: string): GameplayTuning {
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object.`);

  const preset: GameplayTuning = {
    cameraZoom: rangedNumber(value.cameraZoom, `${path}.cameraZoom`, 0.5, 1.5),
    playerVisionRadius: rangedNumber(
      value.playerVisionRadius,
      `${path}.playerVisionRadius`,
      100,
      900
    ),
    shotRange: rangedNumber(value.shotRange, `${path}.shotRange`, 50, 800),
    lockAcquireMs: rangedNumber(value.lockAcquireMs, `${path}.lockAcquireMs`, 0, 3_000),
    playerSpeed: rangedNumber(value.playerSpeed, `${path}.playerSpeed`, 60, 420),
    respawnTimeMs: rangedNumber(value.respawnTimeMs, `${path}.respawnTimeMs`, 0, 15_000),
  };

  if (preset.shotRange > preset.playerVisionRadius) {
    throw new Error(
      `${path}.shotRange (${preset.shotRange}) cannot exceed playerVisionRadius (${preset.playerVisionRadius}).`
    );
  }

  return preset;
}

function rangedNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new Error(`${path} must be between ${min} and ${max}.`);
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
