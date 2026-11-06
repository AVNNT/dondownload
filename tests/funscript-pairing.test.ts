import { describe, expect, it } from 'vitest'
import {
  FunscriptPairingError,
  FunscriptRenameCollisionError,
  VIDEO_MATCH_THRESHOLD,
  groupScriptSets,
  isFunscriptFilename,
  matchSetsToVideos,
  normalizeScriptBase,
  parseFunscriptName,
  planRenames,
  type ScriptSet
} from '../src/shared/funscriptPairing'

function singleSet(
  filenames: string[],
  postNumber?: number
): ScriptSet {
  const sets = groupScriptSets(
    filenames.map((filename, index) => ({
      id: `f${index}`,
      filename,
      ...(postNumber === undefined ? {} : { postNumber })
    }))
  )
  const set = sets[0]
  if (set === undefined) throw new Error('expected one script set')
  expect(sets).toHaveLength(1)
  return set
}

describe('parseFunscriptName', () => {
  it('rejects non-funscript input', () => {
    expect(parseFunscriptName('video.mp4')).toBeNull()
    expect(parseFunscriptName('notes.txt')).toBeNull()
    expect(parseFunscriptName('funscript')).toBeNull()
    expect(parseFunscriptName('video.funscript.bak')).toBeNull()
    expect(parseFunscriptName('.funscript')).toBeNull()
    expect(parseFunscriptName('')).toBeNull()
    expect(isFunscriptFilename('video.FUNSCRIPT')).toBe(true)
    expect(isFunscriptFilename('video.funscript.bak')).toBe(false)
  })

  it('accepts the extension case-insensitively', () => {
    expect(parseFunscriptName('Video.FUNSCRIPT')).toEqual({
      base: 'Video',
      axis: null,
      axisToken: null,
      variant: null
    })
    expect(parseFunscriptName('Video.FunScript')?.base).toBe('Video')
  })

  it('treats a plain file as the main stroke', () => {
    expect(parseFunscriptName('LooksCanKill_Wonyoung.funscript')).toEqual({
      base: 'LooksCanKill_Wonyoung',
      axis: null,
      axisToken: null,
      variant: null
    })
  })

  it('maps every main-stroke alias to no suffix', () => {
    for (const token of ['stroke', 'L0', 'updown', 'main', 'STROKE', 'l0']) {
      const parsed = parseFunscriptName(`Name.${token}.funscript`)
      expect(parsed?.axis, token).toBeNull()
      expect(parsed?.axisToken, token).toBe(token)
      expect(parsed?.base, token).toBe('Name')
    }
  })

  it('maps every canonical axis alias, case-insensitively', () => {
    const cases: Array<{ token: string; axis: string | null }> = [
      { token: 'surge', axis: 'surge' },
      { token: 'L1', axis: 'surge' },
      { token: 'l1', axis: 'surge' },
      { token: 'sway', axis: 'sway' },
      { token: 'L2', axis: 'sway' },
      { token: 'twist', axis: 'twist' },
      { token: 'R0', axis: 'twist' },
      { token: 'roll', axis: 'roll' },
      { token: 'R1', axis: 'roll' },
      { token: 'PITCH', axis: 'pitch' },
      { token: 'r2', axis: 'pitch' },
      { token: 'vib', axis: 'vib' },
      { token: 'V0', axis: 'vib' }
    ]

    for (const testCase of cases) {
      const parsed = parseFunscriptName(
        `LooksCanKill_Wonyoung.${testCase.token}.funscript`
      )
      expect(parsed?.axis, testCase.token).toBe(testCase.axis)
      expect(parsed?.axisToken, testCase.token).toBe(testCase.token)
      expect(parsed?.base).toBe('LooksCanKill_Wonyoung')
    }
  })

  it('preserves recognized auxiliary axis tokens exactly as uploaded', () => {
    const cases = ['valve', 'suck', 'A0', 'a1', 'VALVE']
    for (const token of cases) {
      const parsed = parseFunscriptName(`Name.${token}.funscript`)
      expect(parsed?.axis, token).toBe(token)
      expect(parsed?.axisToken, token).toBe(token)
    }
  })

  it('keeps dotted base names intact', () => {
    expect(parseFunscriptName('S01.E02.1080p.roll.funscript')).toEqual({
      base: 'S01.E02.1080p',
      axis: 'roll',
      axisToken: 'roll',
      variant: null
    })
    expect(parseFunscriptName('my.video.1080p.funscript')?.base).toBe(
      'my.video.1080p'
    )
    expect(parseFunscriptName('video.1080p.funscript')?.axis).toBeNull()
  })

  it('handles spaces, brackets and unicode', () => {
    const parsed = parseFunscriptName(
      '[IVE] IVE (아이브) Looks Can Kill.roll.funscript'
    )
    expect(parsed?.base).toBe('[IVE] IVE (아이브) Looks Can Kill')
    expect(parsed?.axis).toBe('roll')
    expect(parseFunscriptName('  spaced name .R1.funscript  ')?.base).toBe(
      'spaced name'
    )
  })

  it('detects variants before an axis', () => {
    expect(parseFunscriptName('Name.hard.roll.funscript')).toEqual({
      base: 'Name',
      axis: 'roll',
      axisToken: 'roll',
      variant: 'hard'
    })
    expect(parseFunscriptName('Name.SOFT.R1.funscript')).toEqual({
      base: 'Name',
      axis: 'roll',
      axisToken: 'R1',
      variant: 'soft'
    })
    expect(parseFunscriptName('Name.v2.surge.funscript')).toEqual({
      base: 'Name',
      axis: 'surge',
      axisToken: 'surge',
      variant: 'v2'
    })
  })

  it('detects variants expressed on the base', () => {
    expect(parseFunscriptName('Name.hard.funscript')).toEqual({
      base: 'Name',
      axis: null,
      axisToken: null,
      variant: 'hard'
    })
    expect(parseFunscriptName('Name (hard).funscript')?.variant).toBe('hard')
    expect(parseFunscriptName('Name (HARD).roll.funscript')?.variant).toBe(
      'hard'
    )
    expect(parseFunscriptName('Name_hard.funscript')?.variant).toBe('hard')
    expect(parseFunscriptName('Name-hard.roll.funscript')).toEqual({
      base: 'Name',
      axis: 'roll',
      axisToken: 'roll',
      variant: 'hard'
    })
    expect(parseFunscriptName('Name-v2.funscript')?.variant).toBe('v2')
    expect(parseFunscriptName('Name.HalfSpeed.funscript')?.variant).toBe(
      'halfspeed'
    )
    expect(parseFunscriptName('Name v2.funscript')?.variant).toBe('v2')
  })

  it('does not invent variants from ordinary dotted titles', () => {
    expect(parseFunscriptName('Some.Name.roll.funscript')).toEqual({
      base: 'Some.Name',
      axis: 'roll',
      axisToken: 'roll',
      variant: null
    })
    expect(parseFunscriptName('Name.official.funscript')?.base).toBe(
      'Name.official'
    )
    expect(parseFunscriptName('Name.foo.roll.funscript')?.base).toBe('Name.foo')
    expect(parseFunscriptName('Video (2020).funscript')?.variant).toBeNull()
    expect(parseFunscriptName('Video (4K).funscript')?.base).toBe('Video (4K)')
  })

  it('never treats an axis-only stem as an axis', () => {
    expect(parseFunscriptName('roll.funscript')).toEqual({
      base: 'roll',
      axis: null,
      axisToken: null,
      variant: null
    })
  })

  it('ignores directory components', () => {
    expect(parseFunscriptName('C:\\videos\\Looks.Can.Kill.roll.funscript'))
      .toEqual({
        base: 'Looks.Can.Kill',
        axis: 'roll',
        axisToken: 'roll',
        variant: null
      })
  })
})

describe('normalizeScriptBase', () => {
  it('normalizes case, separators, camel case and punctuation', () => {
    expect(normalizeScriptBase('LooksCanKill_Wonyoung')).toBe(
      'looks can kill wonyoung'
    )
    expect(normalizeScriptBase('[IVE] Looks Can Kill Wonyoung')).toBe(
      'ive looks can kill wonyoung'
    )
    expect(normalizeScriptBase('LOOKSCANKILL-WONYOUNG')).toBe(
      'lookscankill wonyoung'
    )
    expect(normalizeScriptBase('Café (Live)')).toBe('cafe live')
  })
})

describe('groupScriptSets', () => {
  it('groups files by normalized base and collects axes', () => {
    const sets = groupScriptSets([
      { id: 'a', filename: 'LooksCanKill_Wonyoung.roll.funscript' },
      { id: 'b', filename: 'Looks Can Kill Wonyoung.surge.funscript' },
      { id: 'c', filename: 'LooksCanKill_Wonyoung.vib.funscript' }
    ])

    expect(sets).toHaveLength(1)
    const set = sets[0]
    expect(set?.normalizedBase).toBe('looks can kill wonyoung')
    expect(set?.axes).toEqual(['roll', 'surge', 'vib'])
    expect(set?.variants).toEqual([])
    expect(set?.missingMain).toBe(true)
    expect(set?.mainFileId).toBeNull()
    expect(set?.conflicts).toEqual([])
    expect(set?.files.map((file) => file.fileId)).toEqual(['a', 'b', 'c'])
  })

  it('reports main presence and counts a variant main as main', () => {
    const withMain = singleSet([
      'LooksCanKill_Wonyoung.funscript',
      'LooksCanKill_Wonyoung.roll.funscript'
    ])
    expect(withMain.missingMain).toBe(false)
    expect(withMain.mainFileId).toBe('f0')

    const variantMain = singleSet([
      'LooksCanKill_Wonyoung.hard.funscript',
      'LooksCanKill_Wonyoung.roll.funscript'
    ])
    expect(variantMain.missingMain).toBe(false)
    expect(variantMain.mainFileId).toBe('f0')
    expect(variantMain.variants).toEqual(['hard'])
  })

  it('collects variants and keeps a combined single file as main', () => {
    const combined = singleSet(['LooksCanKill_Wonyoung.funscript'])
    expect(combined.files).toHaveLength(1)
    expect(combined.axes).toEqual([])
    expect(combined.missingMain).toBe(false)

    const variants = singleSet([
      'LooksCanKill_Wonyoung.hard.funscript',
      'LooksCanKill_Wonyoung.soft.funscript'
    ])
    expect(variants.variants).toEqual(['hard', 'soft'])
    expect(variants.missingMain).toBe(false)
  })

  it('flags two files mapping to the same axis and variant', () => {
    const set = singleSet([
      'Name.roll.funscript',
      'Name.R1.funscript',
      'Name.hard.roll.funscript',
      'Name.hard.R1.funscript',
      'Name.surge.funscript'
    ])

    expect(set.axes).toEqual(['roll', 'surge'])
    expect(set.conflicts).toEqual([
      { axis: 'roll', variant: null, fileIds: ['f0', 'f1'] },
      { axis: 'roll', variant: 'hard', fileIds: ['f2', 'f3'] }
    ])
  })

  it('splits by post only when more than one post is present', () => {
    const sets = groupScriptSets([
      { id: 'p7', filename: 'Same.roll.funscript', postNumber: 7 },
      { id: 'p9', filename: 'Same.surge.funscript', postNumber: 9 },
      { id: 'none', filename: 'Same.vib.funscript' }
    ])

    expect(sets).toHaveLength(3)
    expect(sets.map((set) => set.postNumber).sort()).toEqual([7, 9, null])
    expect(sets.find((set) => set.postNumber === 7)?.files[0]?.fileId).toBe('p7')
    expect(sets.find((set) => set.postNumber === 9)?.files[0]?.fileId).toBe('p9')
    expect(sets.find((set) => set.postNumber === null)?.files[0]?.fileId).toBe(
      'none'
    )
    expect(new Set(sets.map((set) => set.id)).size).toBe(3)
  })

  it('keeps one post when it is the only post defined', () => {
    const sets = groupScriptSets([
      { id: 'p3', filename: 'Same.roll.funscript', postNumber: 3 },
      { id: 'none', filename: 'Same.surge.funscript' }
    ])
    expect(sets).toHaveLength(1)
    expect(sets[0]?.postNumber).toBe(3)
    expect(sets[0]?.files).toHaveLength(2)
  })

  it('ignores non-funscript files', () => {
    const sets = groupScriptSets([
      { id: 'video', filename: 'video.mp4' },
      { id: 'script', filename: 'Name.roll.funscript' },
      { id: 'notes', filename: 'notes.txt' }
    ])
    expect(sets).toHaveLength(1)
    expect(sets[0]?.files.map((file) => file.fileId)).toEqual(['script'])
  })
})

describe('matchSetsToVideos', () => {
  const memberVideos = [
    { id: 'v-wonyoung', title: 'IVE Looks Can Kill Wonyoung fancam 4K' },
    { id: 'v-yujin', title: 'IVE Looks Can Kill Yujin fancam 4K' },
    { id: 'v-rei', title: 'IVE Looks Can Kill Rei fancam 4K' },
    { id: 'v-gaeul', title: 'IVE Looks Can Kill Gaeul fancam 4K' },
    { id: 'v-liz', title: 'IVE Looks Can Kill Liz fancam 4K' },
    { id: 'v-leeseo', title: 'IVE Looks Can Kill Leeseo fancam 4K' },
    { id: 'v-mix', title: 'IVE Looks Can Kill Mix' }
  ]

  it('matches six member fancams and a mix by member name', () => {
    const members = [
      'Wonyoung',
      'Yujin',
      'Rei',
      'Gaeul',
      'Liz',
      'Leeseo',
      'Mix'
    ]
    const sets = groupScriptSets(
      members.map((member) => ({
        id: `set-${member}`,
        filename: `LooksCanKill_${member}.roll.funscript`
      }))
    )

    expect(sets).toHaveLength(7)
    const matches = matchSetsToVideos(sets, memberVideos)
    const byMember = new Map(
      matches.map((match) => [match.setId, match.videoId])
    )

    expect(matches.every((match) => match.ambiguous === false)).toBe(true)
    expect(matches.every((match) => match.score >= VIDEO_MATCH_THRESHOLD)).toBe(
      true
    )

    for (const member of members) {
      const set = sets.find((candidate) =>
        candidate.base.endsWith(member)
      )
      expect(set).toBeDefined()
      const expectedVideo =
        member === 'Mix' ? 'v-mix' : `v-${member.toLowerCase()}`
      expect(byMember.get(set?.id ?? '')).toBe(expectedVideo)
    }
  })

  it('matches on the filename when the title is unrelated', () => {
    const sets = groupScriptSets([
      { id: 'set', filename: 'LooksCanKill_Wonyoung.roll.funscript' }
    ])
    const matches = matchSetsToVideos(sets, [
      {
        id: 'v-wonyoung',
        title: 'Unrelated upload title',
        filename: 'IVE Looks Can Kill Wonyoung fancam.mp4'
      },
      { id: 'v-yujin', title: 'Unrelated upload title two' }
    ])

    expect(matches[0]?.videoId).toBe('v-wonyoung')
    expect(matches[0]?.ambiguous).toBe(false)
  })

  it('marks near-identical top candidates as ambiguous instead of forcing', () => {
    const sets = groupScriptSets([
      { id: 'set', filename: 'LooksCanKill_Wonyoung.roll.funscript' }
    ])
    const matches = matchSetsToVideos(sets, [
      { id: 'v-4k', title: 'IVE Looks Can Kill Wonyoung fancam 4K' },
      { id: 'v-1080p', title: 'IVE Looks Can Kill Wonyoung fancam 1080p' }
    ])

    expect(matches[0]?.ambiguous).toBe(true)
    expect(matches[0]?.videoId).toBeNull()
    expect(matches[0]?.score).toBeGreaterThanOrEqual(VIDEO_MATCH_THRESHOLD)
  })

  it('returns null below the threshold for weak matches', () => {
    const sets = groupScriptSets([
      { id: 'set', filename: 'Completely Unrelated Haptic Sequence.funscript' }
    ])
    const matches = matchSetsToVideos(sets, memberVideos)

    expect(matches[0]?.videoId).toBeNull()
    expect(matches[0]?.ambiguous).toBe(false)
    expect(matches[0]?.score).toBeLessThan(VIDEO_MATCH_THRESHOLD)
  })

  it('uses the same-post bonus to break a tie', () => {
    const sets = groupScriptSets([
      {
        id: 'set',
        filename: 'Looks Can Kill Wonyoung.funscript',
        postNumber: 3
      }
    ])
    const matches = matchSetsToVideos(sets, [
      {
        id: 'v-post-2',
        title: 'IVE Looks Can Kill Wonyoung',
        postNumber: 2
      },
      {
        id: 'v-post-3',
        title: 'IVE Looks Can Kill Wonyoung',
        postNumber: 3
      }
    ])

    expect(matches[0]?.videoId).toBe('v-post-3')
    expect(matches[0]?.ambiguous).toBe(false)
  })
})

describe('planRenames', () => {
  const video = 'IVE Looks Can Kill Wonyoung fancam.mp4'

  it('plans canonical names for a full multi-axis set', () => {
    const set = singleSet([
      'LooksCanKill_Wonyoung.funscript',
      'LooksCanKill_Wonyoung.surge.funscript',
      'LooksCanKill_Wonyoung.sway.funscript',
      'LooksCanKill_Wonyoung.twist.funscript',
      'LooksCanKill_Wonyoung.roll.funscript',
      'LooksCanKill_Wonyoung.pitch.funscript',
      'LooksCanKill_Wonyoung.vib.funscript'
    ])

    expect(planRenames(set, video, { primaryVariant: null })).toEqual([
      { fileId: 'f0', targetName: 'IVE Looks Can Kill Wonyoung fancam.funscript' },
      {
        fileId: 'f1',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.surge.funscript'
      },
      {
        fileId: 'f2',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.sway.funscript'
      },
      {
        fileId: 'f3',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.twist.funscript'
      },
      {
        fileId: 'f4',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.roll.funscript'
      },
      {
        fileId: 'f5',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.pitch.funscript'
      },
      {
        fileId: 'f6',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.vib.funscript'
      }
    ])
  })

  it('promotes the primary variant and suffixes the other variants', () => {
    const set = singleSet([
      'LooksCanKill_Wonyoung.hard.funscript',
      'LooksCanKill_Wonyoung.hard.roll.funscript',
      'LooksCanKill_Wonyoung.soft.funscript',
      'LooksCanKill_Wonyoung.soft.roll.funscript'
    ])

    expect(planRenames(set, video, { primaryVariant: 'HARD' })).toEqual([
      { fileId: 'f0', targetName: 'IVE Looks Can Kill Wonyoung fancam.funscript' },
      {
        fileId: 'f1',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.roll.funscript'
      },
      {
        fileId: 'f2',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.soft.funscript'
      },
      {
        fileId: 'f3',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.soft.roll.funscript'
      }
    ])
  })

  it('keeps every variant in the name when no primary is chosen', () => {
    const set = singleSet([
      'LooksCanKill_Wonyoung.hard.funscript',
      'LooksCanKill_Wonyoung.hard.roll.funscript',
      'LooksCanKill_Wonyoung.soft.funscript',
      'LooksCanKill_Wonyoung.soft.roll.funscript'
    ])

    expect(planRenames(set, video, { primaryVariant: null })).toEqual([
      {
        fileId: 'f0',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.hard.funscript'
      },
      {
        fileId: 'f1',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.hard.roll.funscript'
      },
      {
        fileId: 'f2',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.soft.funscript'
      },
      {
        fileId: 'f3',
        targetName: 'IVE Looks Can Kill Wonyoung fancam.soft.roll.funscript'
      }
    ])
  })

  it('turns a combined single multi-axis file into the main name', () => {
    const set = singleSet(['LooksCanKill_Wonyoung.funscript'])
    expect(planRenames(set, video, { primaryVariant: null })).toEqual([
      { fileId: 'f0', targetName: 'IVE Looks Can Kill Wonyoung fancam.funscript' }
    ])
  })

  it('never synthesizes a main entry from axes alone', () => {
    const set = singleSet([
      'LooksCanKill_Wonyoung.roll.funscript',
      'LooksCanKill_Wonyoung.surge.funscript'
    ])
    const plan = planRenames(set, video, { primaryVariant: null })

    expect(plan).toHaveLength(2)
    expect(plan.map((entry) => entry.targetName)).toEqual([
      'IVE Looks Can Kill Wonyoung fancam.roll.funscript',
      'IVE Looks Can Kill Wonyoung fancam.surge.funscript'
    ])
  })

  it('preserves auxiliary axis spelling and uses only the last extension', () => {
    const set = singleSet([
      'Name.A0.funscript',
      'Name.valve.funscript'
    ])
    expect(planRenames(set, 'clip.tar.gz', { primaryVariant: null })).toEqual([
      { fileId: 'f0', targetName: 'clip.tar.A0.funscript' },
      { fileId: 'f1', targetName: 'clip.tar.valve.funscript' }
    ])
  })

  it('runs every target through the filename sanitizer', () => {
    const set = singleSet(['Name.funscript'])
    expect(
      planRenames(set, 'Bad: Name?.mp4', { primaryVariant: null })
    ).toEqual([{ fileId: 'f0', targetName: 'Bad_ Name_.funscript' }])
    expect(planRenames(set, 'CON.mp4', { primaryVariant: null })).toEqual([
      { fileId: 'f0', targetName: '_CON.funscript' }
    ])
  })

  it('throws a typed collision error for duplicate targets', () => {
    const set = singleSet([
      'Name.roll.funscript',
      'Name.R1.funscript'
    ])

    let error: unknown
    try {
      planRenames(set, video, { primaryVariant: null })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(FunscriptRenameCollisionError)
    expect(error).toBeInstanceOf(FunscriptPairingError)
    const collision = error as FunscriptRenameCollisionError
    expect(collision.collisions).toEqual([
      {
        targetName: 'IVE Looks Can Kill Wonyoung fancam.roll.funscript',
        fileIds: ['f0', 'f1']
      }
    ])
  })

  it('detects case-insensitive target collisions', () => {
    const set = singleSet([
      'Name.HARD.funscript',
      'Name.hard.funscript'
    ])
    expect(() =>
      planRenames(set, video, { primaryVariant: null })
    ).toThrow(FunscriptRenameCollisionError)
  })

  it('rejects an empty video filename and accepts an empty set', () => {
    const set = singleSet(['Name.funscript'])
    expect(() => planRenames(set, '   ', { primaryVariant: null })).toThrow(
      FunscriptPairingError
    )

    const empty = groupScriptSets([{ id: 'x', filename: 'notes.txt' }])
    expect(empty).toEqual([])
    const emptySet = {
      ...set,
      files: []
    }
    expect(planRenames(emptySet, video, { primaryVariant: null })).toEqual([])
  })
})
