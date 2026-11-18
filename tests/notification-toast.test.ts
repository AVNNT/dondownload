import { describe, expect, it } from 'vitest'
import {
  TOAST_ACTION_OPEN,
  TOAST_ACTION_SHOW,
  buildCompletionToastXml,
  notificationTag
} from '../src/main/notifications/toast'

describe('Windows completion toast XML', () => {
  it('builds a ToastGeneric body with Open and Show in folder buttons', () => {
    const xml = buildCompletionToastXml({
      title: 'Download complete',
      body: 'ubuntu.iso',
      notificationId: 'dd1abc'
    })

    expect(xml.startsWith('<toast>')).toBe(true)
    expect(xml).toContain('<binding template="ToastGeneric">')
    expect(xml).toContain('<text>Download complete</text>')
    expect(xml).toContain('<text>ubuntu.iso</text>')
    expect(xml).toContain('content="Open"')
    expect(xml).toContain('content="Show in folder"')
    expect(xml.match(/activationType="foreground"/g)).toHaveLength(2)
    expect(xml).toContain(
      `arguments="type=action&amp;action=${TOAST_ACTION_OPEN}&amp;tag=dd1abc"`
    )
    expect(xml).toContain(
      `arguments="type=action&amp;action=${TOAST_ACTION_SHOW}&amp;tag=dd1abc"`
    )
    expect(xml.trim().endsWith('</toast>')).toBe(true)
  })

  it('escapes user-visible text so a filename cannot break the XML', () => {
    const xml = buildCompletionToastXml({
      title: 'Download <complete>',
      body: 'Tom & Jerry "final" \'cut\'.mkv',
      notificationId: 'dd2xyz'
    })
    expect(xml).toContain('<text>Download &lt;complete&gt;</text>')
    expect(xml).toContain(
      '<text>Tom &amp; Jerry &quot;final&quot; &apos;cut&apos;.mkv</text>'
    )
    expect(xml).not.toContain('Tom & Jerry')
  })

  it('accepts localized button labels', () => {
    const xml = buildCompletionToastXml({
      title: 'Download complete',
      body: 'file.zip',
      notificationId: 'dd3',
      openLabel: 'Open file',
      showLabel: 'Reveal'
    })
    expect(xml).toContain('content="Open file"')
    expect(xml).toContain('content="Reveal"')
  })

  it('generates short alphanumeric tags for older Windows builds', () => {
    const tag = notificationTag(42, 'ab-cd ef.12')
    expect(tag).toMatch(/^[a-z0-9]+$/)
    expect(tag.length).toBeLessThanOrEqual(16)
    expect(tag).not.toBe(notificationTag(43, 'ab-cd ef.12'))
  })
})
