import { describe, expect, it } from 'vitest'
import {
  defaultDesktopSettings,
  type DesktopSettings
} from '../src/shared/desktopSettings'
import {
  DesktopSettingsManager,
  type DesktopSettingsStore
} from '../src/main/settings/desktopManager'

function memoryStore(
  initial: DesktopSettings = defaultDesktopSettings()
): DesktopSettingsStore & { saved: DesktopSettings[] } {
  let current = { ...initial }
  const saved: DesktopSettings[] = []
  return {
    saved,
    loadDesktopSettings: () => ({ ...current }),
    saveDesktopSettings: (settings) => {
      current = { ...settings }
      saved.push({ ...settings })
    }
  }
}

describe('DesktopSettingsManager first-start guide flag', () => {
  it('marks only the guide flag and keeps a concurrent change', async () => {
    const store = memoryStore({
      ...defaultDesktopSettings(),
      showNotifications: false,
      interfaceSizePercent: 110
    })
    const manager = new DesktopSettingsManager({ store })

    // Another surface changes a preference while the guide is still open.
    await manager.update({ ...manager.getSettings(), showNotifications: true })

    const result = manager.markWelcomeGuideSeen()

    expect(result.welcomeGuideSeen).toBe(true)
    expect(result.showNotifications).toBe(true)
    expect(result.interfaceSizePercent).toBe(110)
    expect(store.saved.at(-1)).toMatchObject({
      welcomeGuideSeen: true,
      showNotifications: true
    })
  })

  it('is idempotent when the guide was already dismissed', () => {
    const store = memoryStore({
      ...defaultDesktopSettings(),
      welcomeGuideSeen: true
    })
    const manager = new DesktopSettingsManager({ store })

    expect(manager.markWelcomeGuideSeen().welcomeGuideSeen).toBe(true)
    expect(store.saved).toHaveLength(0)
  })
})
