/**
 * What the reader has decided a diff should look like.
 *
 * Every one of these is a choice about presentation, not about content, which
 * is why they are all applied as attributes on one element and read by CSS.
 * Nothing here refetches markup, and nothing here re-renders: switching the
 * indicators off on a forty thousand file compare is a class change, not a
 * round trip and not a relayout of the list.
 *
 * The one exception is the layout, which genuinely changes what the rows are,
 * and it lives here anyway so that a reader's whole set of choices is read and
 * written in one place rather than a key at a time.
 */

export type DiffLayout = 'unified' | 'split'

/** How a changed line announces itself. */
export type DiffIndicators = 'glyph' | 'bar' | 'none'

/**
 * Which pair of colours the added and removed lines use.
 *
 * Red and green is the convention and it fails roughly one in twelve men, who
 * see the two as the same muddy colour. The alternatives are not a
 * simulation of what those readers see - they are pairs chosen to stay
 * distinguishable *for* them: blue against orange survives red-green
 * deficiency, and teal against magenta survives blue-yellow.
 *
 * Colour is never the only cue whichever pair is in force. The `+`/`-` glyph
 * or the edge bar carries the same information in shape, which is the part
 * that actually makes a diff readable rather than merely tinted.
 */
export type DiffPalette = 'classic' | 'deuteranopia' | 'tritanopia' | 'contrast'

export interface DiffPreferences {
  layout: DiffLayout
  /**
   * `glyph` is the `+`/`-` column every forge uses; `bar` is a coloured edge,
   * which reads better beside syntax colours; `none` leaves the background to
   * carry it alone.
   */
  indicators: DiffIndicators
  palette: DiffPalette
  lineNumbers: boolean
  /**
   * The green and red wash behind changed lines.
   *
   * Some readers find a screen of it harder to read than easier, and with the
   * bar indicator on there is still something saying which side a line is.
   */
  changeBackground: boolean
  /** Wrap long lines instead of scrolling the file sideways. */
  wrap: boolean
}

export const DEFAULT_PREFERENCES: DiffPreferences = {
  layout: 'unified',
  indicators: 'glyph',
  palette: 'classic',
  lineNumbers: true,
  changeBackground: true,
  wrap: false,
}

/** One key for the whole set. */
const STORAGE_KEY = 'reviewos:diff'

/**
 * Where the layout alone used to live.
 *
 * Read once, when the new key is absent, so a reader who had already chosen
 * split does not silently get unified back the first time they load a page
 * after this shipped.
 */
const LEGACY_LAYOUT_KEY = 'reviewos:diff-layout'

/**
 * Storage, if this browser has any we may use.
 *
 * Safari in private browsing throws on access, and so does any browser with
 * third-party storage blocked in a frame. A reader who cannot be remembered
 * still gets a working page, so every path through this file tolerates null.
 */
function storage(): Storage | null {
  try {
    return window.localStorage
  }
  catch {
    return null
  }
}

function isLayout(value: unknown): value is DiffLayout {
  return value === 'unified' || value === 'split'
}

function isIndicators(value: unknown): value is DiffIndicators {
  return value === 'glyph' || value === 'bar' || value === 'none'
}

function isPalette(value: unknown): value is DiffPalette {
  return value === 'classic' || value === 'deuteranopia' || value === 'tritanopia' || value === 'contrast'
}

/**
 * The reader's choices, with anything missing or unrecognised defaulted.
 *
 * Field by field rather than trusting the stored object wholesale: this is
 * parsed from storage a future version may have written differently, and a
 * viewer that renders nothing because one key changed shape is a worse outcome
 * than a viewer that forgets one setting.
 */
export function readPreferences(): DiffPreferences {
  const store = storage()
  const raw = store?.getItem(STORAGE_KEY)

  let stored: Record<string, unknown> = {}
  if (raw != null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object')
        stored = parsed as Record<string, unknown>
    }
    catch {
      // Unreadable. The defaults are a working page.
    }
  }

  const legacy = raw == null ? store?.getItem(LEGACY_LAYOUT_KEY) : null

  return {
    layout: isLayout(stored.layout) ? stored.layout : (isLayout(legacy) ? legacy : DEFAULT_PREFERENCES.layout),
    indicators: isIndicators(stored.indicators) ? stored.indicators : DEFAULT_PREFERENCES.indicators,
    palette: isPalette(stored.palette) ? stored.palette : DEFAULT_PREFERENCES.palette,
    lineNumbers: typeof stored.lineNumbers === 'boolean' ? stored.lineNumbers : DEFAULT_PREFERENCES.lineNumbers,
    changeBackground: typeof stored.changeBackground === 'boolean'
      ? stored.changeBackground
      : DEFAULT_PREFERENCES.changeBackground,
    wrap: typeof stored.wrap === 'boolean' ? stored.wrap : DEFAULT_PREFERENCES.wrap,
  }
}

export function writePreferences(preferences: DiffPreferences): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(preferences))
  }
  catch {
    // Not being remembered is not a reason to stop.
  }
}

/**
 * Put the choices where CSS can see them.
 *
 * Attributes on an ancestor rather than classes on every row: a row is created
 * and destroyed as the reader scrolls, and a setting applied per row would have
 * to be re-applied on every mount. An attribute on the container is applied
 * once and is true of every row that ever appears under it.
 */
export function applyPreferences(root: HTMLElement, preferences: DiffPreferences): void {
  root.dataset.diffIndicators = preferences.indicators
  root.dataset.diffPalette = preferences.palette
  root.dataset.diffNumbers = preferences.lineNumbers ? 'on' : 'off'
  root.dataset.diffBackgrounds = preferences.changeBackground ? 'on' : 'off'
  root.dataset.diffWrap = preferences.wrap ? 'on' : 'off'
}

/**
 * Write one control's value into the preferences, if it is a value that key
 * can hold.
 *
 * A switch rather than an indexed write, because a control is addressed by a
 * string from an attribute and every key has a different type. The alternative
 * is a cast, and a cast here would let a radio whose `value` was mistyped in a
 * template put `"gylph"` into `indicators`, where it would silently match no
 * CSS rule and look exactly like the feature not working.
 */
function assign(preferences: DiffPreferences, key: keyof DiffPreferences, value: string | boolean): boolean {
  switch (key) {
    case 'layout':
      if (!isLayout(value))
        return false
      preferences.layout = value
      return true
    case 'indicators':
      if (!isIndicators(value))
        return false
      preferences.indicators = value
      return true
    case 'palette':
      if (!isPalette(value))
        return false
      preferences.palette = value
      return true
    case 'lineNumbers':
    case 'changeBackground':
    case 'wrap':
      if (typeof value !== 'boolean')
        return false
      preferences[key] = value
      return true
    default:
      return false
  }
}

/**
 * Wire a set of controls to the preferences.
 *
 * The controls say which preference they are for in a `data-diff-pref`
 * attribute, so this file knows nothing about the markup beyond that and a
 * template can lay the panel out however it likes. A checkbox writes a boolean;
 * anything else writes its value.
 *
 * Returns a function that reads the current set, because the caller needs the
 * layout out of it and should not keep a second copy that can drift.
 */
export function wirePreferenceControls(options: {
  root: HTMLElement
  panel: ParentNode
  onChange: (preferences: DiffPreferences, changed: keyof DiffPreferences) => void
}): DiffPreferences {
  const { root, panel, onChange } = options
  const preferences = readPreferences()

  applyPreferences(root, preferences)

  for (const control of panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-diff-pref]')) {
    const key = control.dataset.diffPref as keyof DiffPreferences | undefined
    if (!key || !(key in preferences))
      continue

    // Reflect what is stored before anything is listened for, so the panel
    // opens showing what is actually in force rather than what the markup
    // happened to be written with.
    const current = preferences[key]
    if (control instanceof HTMLInputElement && control.type === 'checkbox')
      control.checked = current === true
    else if (control instanceof HTMLInputElement && control.type === 'radio')
      control.checked = control.value === current
    else
      control.value = String(current)

    control.addEventListener('change', () => {
      const next = control instanceof HTMLInputElement && control.type === 'checkbox'
        ? control.checked
        : control.value

      if (!assign(preferences, key, next))
        return

      writePreferences(preferences)
      applyPreferences(root, preferences)
      onChange(preferences, key)
    })
  }

  return preferences
}
