import { defineConfig } from 'vitest/config'

// Unit tests for pure logic modules (turn control, answer orchestration, ASR
// event mapping). Node environment -- these modules have no DOM/Electron
// dependency by design, which is exactly what makes them testable here without
// a live API key or audio device.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts']
  }
})
