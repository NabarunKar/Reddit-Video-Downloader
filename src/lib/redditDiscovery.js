/**
 * Media discovery layer for Reddit-hosted videos.
 *
 * Scope:
 * - Given a Reddit post URL, derive the .json endpoint.
 * - Fetch the Reddit JSON.
 * - Recursively locate a signed DASH MPD URL (dashUrl).
 * - Fetch and parse the MPD.
 * - Select best video (height, then bandwidth) and best audio (bandwidth).
 * - Resolve selected BaseURL(s) against the MPD URL.
 */

/** @typedef {{ url: string, bandwidth?: number, height?: number, mimeType?: string, codecs?: string }} SelectedRepresentation */

/**
 * @param {string} url
 */
function assertHttpUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL: unable to parse')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid URL: must be http(s)')
  }
}

/**
 * Try to normalize a variety of Reddit URL forms into the canonical JSON endpoint.
 *
 * Examples supported:
 * - https://www.reddit.com/r/.../comments/<id>/<slug>/
 * - https://reddit.com/r/.../comments/<id>/
 * - https://old.reddit.com/r/.../comments/<id>/
 * - https://www.reddit.com/comments/<id>/<slug>/
 * - (with/without trailing slash, with/without query)
 *
 * NOTE: We intentionally do not add additional dependencies or rely on a fixed path.
 *
 * @param {string} redditPostUrl
 * @returns {string} jsonUrl
 */
export function toRedditJsonUrl(redditPostUrl) {
  assertHttpUrl(redditPostUrl)

  const u = new URL(redditPostUrl)

  // Basic host sanity check. Reddit has multiple hosts; allow a small set and block obvious non-Reddit.
  const host = u.hostname.toLowerCase()
  const looksLikeReddit =
    host === 'reddit.com' ||
    host.endsWith('.reddit.com') ||
    host === 'redd.it' ||
    host.endsWith('.redd.it')

  if (!looksLikeReddit) {
    throw new Error('Invalid Reddit URL: hostname is not reddit.com/redd.it')
  }

  // redd.it short links need expansion to a comments URL via a redirect.
  if (host === 'redd.it' || host.endsWith('.redd.it')) {
    // Use the redirect target to create .json.
    // Keep query parameters; they usually include tracking but harmless.
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}.json${u.search}`
  }

  // Remove any existing .json suffix to avoid duplicates.
  const trimmedPath = u.pathname.replace(/\/+$/, '')
  const pathNoJson = trimmedPath.endsWith('.json')
    ? trimmedPath.slice(0, -'.json'.length)
    : trimmedPath

  // If the URL points to an in-app /gallery or /s/ share, Reddit often still serves JSON
  // at the same path with .json appended.
  const jsonPath = `${pathNoJson}.json`

  return `${u.origin}${jsonPath}${u.search}`
}

/**
 * Recursively searches for a "dashUrl" string in any JSON-like structure.
 *
 * @param {unknown} node
 * @returns {string | null}
 */
export function findDashUrlDeep(node) {
  const visited = new Set()

  /**
   * @param {unknown} value
   * @returns {string | null}
   */
  function walk(value) {
    if (value === null || value === undefined) return null

    if (typeof value === 'string') {
      return null
    }

    if (typeof value !== 'object') {
      return null
    }

    if (visited.has(value)) return null
    visited.add(value)

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item)
        if (found) return found
      }
      return null
    }

    // Object
    /** @type {Record<string, unknown>} */
    const obj = /** @type {any} */ (value)

    // Prefer explicit key match first.
    if (typeof obj.dashUrl === 'string' && obj.dashUrl.length > 0) {
      return obj.dashUrl
    }

    // Also accept "dash_url" and other casing variants if encountered.
    if (typeof obj.dash_url === 'string' && obj.dash_url.length > 0) {
      return obj.dash_url
    }

    for (const k of Object.keys(obj)) {
      const found = walk(obj[k])
      if (found) return found
    }

    return null
  }

  return walk(node)
}

/**
 * @param {Element} el
 * @param {string} name
 */
function getAttr(el, name) {
  const v = el.getAttribute(name)
  return v === null ? undefined : v
}

/**
 * @param {string | undefined} v
 */
function toNumber(v) {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Resolve a representation URL (usually a relative BaseURL) against the MPD URL.
 *
 * Reddit MPDs often include query parameters (e.g. "?token=...") that must be preserved
 * for segment URLs. If the BaseURL does not contain a query string, we copy the MPD
 * query string onto the resolved URL.
 *
 * @param {string} mpdUrl
 * @param {string} baseUrlText
 */
export function resolveBaseUrlAgainstMpd(mpdUrl, baseUrlText) {
  const mpd = new URL(mpdUrl)
  const resolved = new URL(baseUrlText, mpd)

  // Preserve signed query params when BaseURL doesn't specify any.
  if (!resolved.search && mpd.search) {
    resolved.search = mpd.search
  }

  return resolved.toString()
}

/**
 * @param {Document} mpdDoc
 */
function selectBestFromMpd(mpdDoc) {
  const representations = Array.from(mpdDoc.getElementsByTagName('Representation'))
  if (representations.length === 0) {
    throw new Error('Invalid MPD: no Representation elements found')
  }

  /** @type {SelectedRepresentation[]} */
  const video = []
  /** @type {SelectedRepresentation[]} */
  const audio = []

  for (const rep of representations) {
    // Representation can inherit mimeType from AdaptationSet.
    const adaptationSet = rep.parentElement
    const mimeType =
      getAttr(rep, 'mimeType') || (adaptationSet ? getAttr(adaptationSet, 'mimeType') : undefined)

    const codecs =
      getAttr(rep, 'codecs') || (adaptationSet ? getAttr(adaptationSet, 'codecs') : undefined)

    const bandwidth = toNumber(getAttr(rep, 'bandwidth'))
    const height = toNumber(getAttr(rep, 'height'))

    // Find the closest BaseURL within this Representation.
    const baseUrlEl = rep.getElementsByTagName('BaseURL')[0]
    const baseUrlText = baseUrlEl?.textContent?.trim() || ''

    if (!baseUrlText) continue

    const entry = { url: baseUrlText, bandwidth, height, mimeType, codecs }

    // We only want MP4s. Reddit's DASH typically uses video/mp4 and audio/mp4.
    if (mimeType?.includes('video')) {
      // Some MPDs use video/webm; ignore those.
      if (mimeType.includes('mp4')) video.push(entry)
      continue
    }

    if (mimeType?.includes('audio')) {
      if (mimeType.includes('mp4')) audio.push(entry)
      continue
    }

    // Fallback when mimeType missing: infer from attributes.
    if (height !== undefined) {
      video.push(entry)
    } else {
      audio.push(entry)
    }
  }

  if (video.length === 0) {
    throw new Error('MPD did not contain any MP4 video representations')
  }
  if (audio.length === 0) {
    throw new Error('MPD did not contain any MP4 audio representations')
  }

  const bestVideo = [...video].sort((a, b) => {
    const ha = a.height ?? -1
    const hb = b.height ?? -1
    if (hb !== ha) return hb - ha
    const ba = a.bandwidth ?? -1
    const bb = b.bandwidth ?? -1
    return bb - ba
  })[0]

  const bestAudio = [...audio].sort((a, b) => {
    const ba = a.bandwidth ?? -1
    const bb = b.bandwidth ?? -1
    return bb - ba
  })[0]

  return { bestVideo, bestAudio }
}

/**
 * @typedef {{
 *   redditJsonUrl: string,
 *   dashMpdUrl: string,
 *   video: { url: string, height?: number, bandwidth?: number },
 *   audio: { url: string, bandwidth?: number },
 * }} DiscoveryResult
 */

/**
 * Main orchestration: URL -> JSON -> dashUrl -> MPD -> best video+audio.
 *
 * @param {string} redditPostUrl
 * @returns {Promise<DiscoveryResult>}
 */
export async function discoverRedditMedia(redditPostUrl) {
  const redditJsonUrl = toRedditJsonUrl(redditPostUrl)

  // This web app can no longer fetch Reddit JSON directly due to CORS and Reddit blocking.
  // For the MVP, we expect a signed DASH MPD URL (dashUrl) to be handed off from a userscript
  // running on reddit.com.
  throw new Error(
    `Reddit JSON discovery is not available from this origin. Provide a dashUrl instead. Derived JSON URL: ${redditJsonUrl}`,
  )
}

/**
 * MVP path: start from an already-discovered signed DASH MPD URL.
 * (This is handed off from a reddit.com userscript via URL hash.)
 *
 * @param {string} dashMpdUrl
 * @returns {Promise<DiscoveryResult>}
 */
export async function discoverFromDashUrl(dashMpdUrl) {
  assertHttpUrl(dashMpdUrl)

  const mpdRes = await fetch(dashMpdUrl, {
    method: 'GET',
    headers: { accept: 'application/dash+xml, application/xml, text/xml, */*' },
  })

  if (!mpdRes.ok) {
    throw new Error(`Failed to fetch DASH MPD: ${mpdRes.status} ${mpdRes.statusText}`)
  }

  const mpdText = await mpdRes.text()

  const parser = new DOMParser()
  const mpdDoc = parser.parseFromString(mpdText, 'application/xml')

  const parseError = mpdDoc.getElementsByTagName('parsererror')[0]
  if (parseError) {
    throw new Error('Invalid MPD XML: parser error')
  }

  const mpdEl = mpdDoc.getElementsByTagName('MPD')[0]
  if (!mpdEl) {
    throw new Error('Invalid MPD XML: missing <MPD> root element')
  }

  const { bestVideo, bestAudio } = selectBestFromMpd(mpdDoc)

  const videoUrl = resolveBaseUrlAgainstMpd(dashMpdUrl, bestVideo.url)
  const audioUrl = resolveBaseUrlAgainstMpd(dashMpdUrl, bestAudio.url)

  return {
    redditJsonUrl: '',
    dashMpdUrl,
    video: {
      url: videoUrl,
      height: bestVideo.height,
      bandwidth: bestVideo.bandwidth,
    },
    audio: {
      url: audioUrl,
      bandwidth: bestAudio.bandwidth,
    },
  }
}
