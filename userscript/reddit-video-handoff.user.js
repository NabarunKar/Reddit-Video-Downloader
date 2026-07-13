// ==UserScript==
// @name         Reddit Video Downloader Handoff
// @namespace    reddit-video-downloader
// @version      0.1.0
// @description  On a Reddit post page, fetch the post .json same-origin, extract signed dashUrl, and hand it to a local web app.
// @author       
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @match        https://old.reddit.com/*
// @run-at       document-idle
// ==/UserScript==

;(function () {
  'use strict'

  const APP_ORIGIN = 'https://reddit-video-downloader-2.vercel.app'

  /**
   * @param {unknown} node
   * @returns {string | null}
   */
  function findDashUrlDeep(node) {
    const visited = new Set()

    /**
     * @param {unknown} value
     * @returns {string | null}
     */
    function walk(value) {
      if (value === null || value === undefined) return null

      if (typeof value === 'string') return null
      if (typeof value !== 'object') return null

      if (visited.has(value)) return null
      visited.add(value)

      if (Array.isArray(value)) {
        for (const item of value) {
          const found = walk(item)
          if (found) return found
        }
        return null
      }

      const obj = /** @type {Record<string, unknown>} */ (/** @type {any} */ (value))

      if (typeof obj.dashUrl === 'string' && obj.dashUrl.length > 0) return obj.dashUrl
      if (typeof obj.dash_url === 'string' && obj.dash_url.length > 0) return obj.dash_url

      for (const k of Object.keys(obj)) {
        const found = walk(obj[k])
        if (found) return found
      }

      return null
    }

    return walk(node)
  }

  function isProbablyPostPath(pathname) {
    // Most canonical post pages include /comments/<id>/
    return /\/comments\/[a-z0-9]+/i.test(pathname)
  }

  function toRedditJsonUrlFromLocation() {
    const u = new URL(location.href)

    // Remove trailing slashes and any existing .json
    const trimmedPath = u.pathname.replace(/\/+$/, '')
    const pathNoJson = trimmedPath.endsWith('.json')
      ? trimmedPath.slice(0, -'.json'.length)
      : trimmedPath

    return `${u.origin}${pathNoJson}.json${u.search}`
  }

  function ensureButton() {
    if (document.getElementById('rvd-handoff-btn')) return

    const btn = document.createElement('button')
    btn.id = 'rvd-handoff-btn'
    btn.textContent = 'Download video'

    btn.style.position = 'fixed'
    btn.style.right = '16px'
    btn.style.bottom = '16px'
    btn.style.zIndex = '2147483647'
    btn.style.padding = '10px 12px'
    btn.style.borderRadius = '10px'
    btn.style.border = '1px solid rgba(0,0,0,0.25)'
    btn.style.background = '#ffffff'
    btn.style.color = '#111827'
    btn.style.fontSize = '14px'
    btn.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
    btn.style.cursor = 'pointer'
    btn.style.boxShadow = '0 10px 15px -3px rgba(0,0,0,0.15)'

    btn.addEventListener('click', async () => {
      if (!isProbablyPostPath(location.pathname)) {
        alert('This does not look like a Reddit post URL (missing /comments/<id>/).')
        return
      }

      btn.disabled = true
      const previous = btn.textContent
      btn.textContent = 'Finding MPD…'

      try {
        const jsonUrl = toRedditJsonUrlFromLocation()
        const res = await fetch(jsonUrl, { method: 'GET', headers: { accept: 'application/json' } })
        if (!res.ok) {
          throw new Error(`Reddit JSON fetch failed: ${res.status} ${res.statusText}`)
        }

        /** @type {unknown} */
        let json
        try {
          json = await res.json()
        } catch {
          throw new Error('Failed to parse Reddit JSON')
        }

        const dashUrl = findDashUrlDeep(json)
        if (!dashUrl) {
          throw new Error('No dashUrl found on this post')
        }

        const target = new URL(APP_ORIGIN)
        target.hash = `dashUrl=${encodeURIComponent(dashUrl)}`

        window.open(target.toString(), '_blank', 'noopener,noreferrer')
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e))
      } finally {
        btn.disabled = false
        btn.textContent = previous
      }
    })

    document.body.appendChild(btn)
  }

  function updateButtonVisibility() {
    const btn = document.getElementById('rvd-handoff-btn')
    if (!btn) return
    btn.style.display = isProbablyPostPath(location.pathname) ? 'block' : 'none'
  }

  // Initial
  ensureButton()
  updateButtonVisibility()

  // Reddit often navigates via SPA; watch URL changes.
  let lastHref = location.href
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      ensureButton()
      updateButtonVisibility()
    }
  }, 500)
})()
