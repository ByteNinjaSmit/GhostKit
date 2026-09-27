/**
 * keyVault.ts
 *
 * Thin wrapper around `keytar` for storing the user's Gemini API key in the
 * OS-native credential store (Windows Credential Manager on Windows, Keychain
 * on macOS, libsecret on Linux).
 *
 * This module runs in the main process ONLY. It must never be imported by
 * renderer or preload code.
 */
import keytar from 'keytar'
import type { OperationResult } from '../ipc-types'
import { redact } from '../lib/redact'

/** Service name under which the credential is filed in the OS credential store. */
const SERVICE_NAME = 'MockPilot'
/** Account name (i.e. the "username" field) for the stored credential. */
const ACCOUNT_NAME = 'gemini-api-key'

/**
 * Reads the stored Gemini API key, if one has been saved.
 * Returns `null` when no key is stored, or when the credential store cannot
 * be reached (never throws).
 */
export async function getApiKey(): Promise<string | null> {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)
  } catch {
    return null
  }
}

/** Whether a key is currently stored, without exposing the value itself. */
export async function hasApiKey(): Promise<boolean> {
  try {
    return (await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME)) !== null
  } catch {
    return false
  }
}

/**
 * Persists the Gemini API key to the OS credential store, overwriting any
 * previously stored value.
 */
export async function setApiKey(apiKey: string): Promise<OperationResult> {
  const trimmed = apiKey.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'API key cannot be empty.' }
  }

  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, trimmed)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeError(err, 'Failed to save the API key.') }
  }
}

/** Removes the stored Gemini API key, if any. */
export async function deleteApiKey(): Promise<OperationResult> {
  try {
    await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeError(err, 'Failed to delete the API key.') }
  }
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? redact(err.message) : fallback
}
