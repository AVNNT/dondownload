import type { MenuItemConstructorOptions } from 'electron'
import {
  SPEED_LIMIT_PRESETS,
  isSpeedLimitPreset,
  speedLimitMenuLabel
} from '@shared/speedLimits'

/**
 * Build the tray's "Speed limit" radio submenu.
 *
 * The checked item reflects the current global download limit exactly. A value
 * that is not one of the shared presets (for example a custom number typed in
 * Settings) adds one checked, non-clickable `Custom (<value>)` item so the
 * menu never claims a preset is active when it is not.
 */
export function buildSpeedLimitSubmenu(
  currentBps: number,
  onSelect: (bps: number) => void
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = SPEED_LIMIT_PRESETS.map(
    (preset) => ({
      label: preset.label,
      type: 'radio',
      checked: currentBps === preset.bps,
      click: () => onSelect(preset.bps)
    })
  )

  if (!isSpeedLimitPreset(currentBps)) {
    items.push({
      label: speedLimitMenuLabel(currentBps),
      type: 'radio',
      checked: true,
      enabled: false
    })
  }

  return items
}
