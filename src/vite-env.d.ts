/// <reference types="vite/client" />

import type { MockPilotApi, ScreenProtectionApi } from '../electron/ipc-types'

declare global {
  interface Window {
    /** Typed bridge to the main process, exposed by electron/preload.ts. */
    api: MockPilotApi
    /** Screen protection API mapping directly to SetWindowDisplayAffinity. */
    screenProtection: ScreenProtectionApi
  }
}

export {}
