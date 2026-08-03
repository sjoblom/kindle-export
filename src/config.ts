import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Stored settings, so the CLI works from any directory.
 *
 * `dotenv` reads `.env` relative to the working directory, which is fine while
 * you're sitting in the repo and useless once the command is on your PATH.
 * This file lives in the home directory instead and is found from anywhere.
 *
 * Deliberately no Amazon password: signing in happens in the browser, and a
 * field for it here would only invite people to store one.
 */

export interface UserConfig {
  openaiApiKey?: string
  model?: string
  outDir?: string
  concurrency?: number
}

export function configDir(): string {
  return path.join(os.homedir(), '.kindle-export')
}

export function configPath(): string {
  return path.join(configDir(), 'config.json')
}

export async function loadConfig(): Promise<UserConfig> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as UserConfig) : {}
  } catch {
    // No config yet, or it's unreadable — defaults and flags still work.
    return {}
  }
}

export async function saveConfig(config: UserConfig): Promise<string> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 })

  const target = configPath()
  // It holds an API key, so keep it readable only by its owner.
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  })
  await fs.chmod(target, 0o600).catch(() => {})

  return target
}

/**
 * Resolve one setting: an explicit flag wins, then the environment (including
 * `.env`), then the stored config, then the built-in default.
 */
export function resolveSetting<T>(
  flag: T | undefined,
  env: T | undefined,
  stored: T | undefined,
  fallback: T
): T {
  return flag ?? env ?? stored ?? fallback
}
