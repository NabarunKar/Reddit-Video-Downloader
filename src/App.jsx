import './App.css'
import { useEffect, useState } from 'react'
import { discoverFromDashUrl } from './lib/redditDiscovery.js'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

function readDashUrlFromHash() {
  const raw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  const params = new URLSearchParams(raw)
  const v = params.get('dashUrl')
  return v ? v : null
}

function normalizeHtmlEntityAmp(url) {
  // Guard against accidental HTML entity encoding in URLs (e.g. "&amp;").
  // Only decode the specific sequence "&amp;" -> "&".
  return url.includes('&amp;') ? url.replaceAll('&amp;', '&') : url
}

function App() {
  const [_url, setUrl] = useState('')
  const [_openedViaHandoff, setOpenedViaHandoff] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [verification, setVerification] = useState(null)
  const [muxStatus, setMuxStatus] = useState(null)
  const [isMuxing, setIsMuxing] = useState(false)
  const [showDev, setShowDev] = useState(false)

  useEffect(() => {
    const dashUrl = readDashUrlFromHash()
    if (!dashUrl) return

    setOpenedViaHandoff(true)

    // Keep the dashUrl in state for internal use.
    setUrl(dashUrl)

    // Auto-run discovery when arriving from the userscript handoff.
    setIsLoading(true)
    setError(null)
    setResult(null)
    setVerification(null)
    setMuxStatus(null)

    discoverFromDashUrl(dashUrl)
      .then((discovered) => setResult(discovered))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setIsLoading(false))
  }, [])

  // Manual discovery UI removed for MVP; discovery happens via hash handoff.

  useEffect(() => {
    if (!result) return

    const videoFetchUrl = normalizeHtmlEntityAmp(result.video.url)
    const audioFetchUrl = normalizeHtmlEntityAmp(result.audio.url)

    setVerification({ isLoading: true })

    Promise.all([
      fetch(videoFetchUrl).then(async (res) => {
        const blob = await res.blob()
        return {
          status: res.status,
          contentType: res.headers.get('content-type') || blob.type || null,
          size: blob.size,
        }
      }),
      fetch(audioFetchUrl).then(async (res) => {
        const blob = await res.blob()
        return {
          status: res.status,
          contentType: res.headers.get('content-type') || blob.type || null,
          size: blob.size,
        }
      }),
    ])
      .then(([video, audio]) => {
        setVerification({ isLoading: false, video, audio })
      })
      .catch((e) => {
        setVerification({ isLoading: false, error: e instanceof Error ? e.message : String(e) })
      })
  }, [result])

  async function onDownloadMuxed() {
    if (!result) return

    setIsMuxing(true)
    setError(null)
    setMuxStatus('Loading FFmpeg')

    const ffmpeg = new FFmpeg()

    // Vite + @ffmpeg/ffmpeg 0.12.x:
    // Use the ESM core entry so the worker can `import` it, and provide the wasm URL explicitly.
    // IMPORTANT: For single-thread core, we do NOT need (and should not fetch) ffmpeg-core.worker.js
    // from @ffmpeg/core; fetching it from unpkg is blocked by CORS.
    const coreBase = 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/esm'
    let coreURL
    let wasmURL

    try {
      coreURL = await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript')
      wasmURL = await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm')
    } catch (e) {
      throw new Error(`Failed to load FFmpeg core assets: ${e instanceof Error ? e.message : String(e)}`)
    }

    ffmpeg.on('log', ({ message }) => {
      console.log('[ffmpeg]', message)
    })

    try {
      await ffmpeg.load({ coreURL, wasmURL })

      const videoUrl = normalizeHtmlEntityAmp(result.video.url)
      const audioUrl = normalizeHtmlEntityAmp(result.audio.url)

      setMuxStatus('Fetching video')
      const videoData = await fetchFile(videoUrl)

      setMuxStatus('Fetching audio')
      const audioData = await fetchFile(audioUrl)

      const videoName = 'video.mp4'
      const audioName = 'audio.mp4'
      const outName = 'output.mp4'

      await ffmpeg.writeFile(videoName, videoData)
      await ffmpeg.writeFile(audioName, audioData)

      setMuxStatus('Muxing')
      // Equivalent to:
      // ffmpeg -i video.mp4 -i audio.mp4 -c copy output.mp4
      await ffmpeg.exec(['-i', videoName, '-i', audioName, '-c', 'copy', outName])

      const outData = await ffmpeg.readFile(outName)
      const outBlob = new Blob([outData], { type: 'video/mp4' })

      setMuxStatus('Download ready')

      const dlUrl = URL.createObjectURL(outBlob)
      try {
        const a = document.createElement('a')
        a.href = dlUrl
        a.download = 'reddit-video.mp4'
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
      } finally {
        URL.revokeObjectURL(dlUrl)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setMuxStatus(null)
    } finally {
      // Best-effort FS cleanup
      try {
        await ffmpeg.deleteFile('video.mp4')
      } catch {
        // ignore
      }
      try {
        await ffmpeg.deleteFile('audio.mp4')
      } catch {
        // ignore
      }
      try {
        await ffmpeg.deleteFile('output.mp4')
      } catch {
        // ignore
      }

      ffmpeg.terminate()
      setIsMuxing(false)
    }
  }

  const humanMuxStatus =
    muxStatus === 'Loading FFmpeg'
      ? 'Preparing video tools…'
      : muxStatus === 'Fetching video'
        ? 'Downloading video…'
        : muxStatus === 'Fetching audio'
          ? 'Downloading audio…'
          : muxStatus === 'Muxing'
            ? 'Combining video + audio…'
            : muxStatus === 'Download ready'
              ? 'Ready.'
              : muxStatus

  const devObject =
    result
      ? {
          redditJsonUrl: result.redditJsonUrl,
          dashMpdUrl: result.dashMpdUrl,
          video: {
            url: result.video.url,
            height: result.video.height,
            bandwidth: result.video.bandwidth,
          },
          audio: {
            url: result.audio.url,
            bandwidth: result.audio.bandwidth,
          },
          verification,
          mux: {
            status: muxStatus,
            isMuxing,
          },
        }
      : {
          verification,
          mux: {
            status: muxStatus,
            isMuxing,
          },
        }

  const devJson = JSON.stringify(devObject, null, 2)

  function copyDevJson() {
    navigator.clipboard
      .writeText(devJson)
      .catch(() => {
        // ignore clipboard failures (permissions / insecure context)
      })
  }

  function renderJsonHighlighted(jsonText) {
    // Very small, local-only syntax highlighting (no dependency).
    // Escapes HTML and then wraps tokens.
    const escaped = jsonText
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')

    // Regex lifted from common JSON highlighters; keeps escapes minimal to satisfy oxlint.
    const tokenized = escaped.replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        const isKey = match.endsWith(':')
        const isString = match.startsWith('"')
        const isBool = match === 'true' || match === 'false'
        const isNull = match === 'null'
        const isNumber = !isString && !isBool && !isNull

        if (isKey) return `<span style="color:#93c5fd">${match}</span>`
        if (isBool) return `<span style="color:#fbbf24">${match}</span>`
        if (isNull) return `<span style="color:#a1a1aa">${match}</span>`
        if (isNumber) return `<span style="color:#86efac">${match}</span>`
        return `<span style="color:#fda4af">${match}</span>`
      },
    )

    return <pre style={{ margin: 0 }} dangerouslySetInnerHTML={{ __html: tokenized }} />
  }

  return (
    <>
      <section id="center">
        <div style={{ width: 'min(820px, 100%)', textAlign: 'left' }}>
          <h1 style={{ marginBottom: 18 }}>Reddit Video Downloader</h1>
          <p style={{ marginTop: 0 }}>
            Download Reddit videos with audio in the highest available quality.
          </p>

          {null}

          <div style={{ marginTop: 16 }}>
            {error ? (
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: '1px solid rgba(185, 28, 28, 0.35)',
                  background: 'rgba(185, 28, 28, 0.08)',
                  color: 'var(--text-h)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Error</div>
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, color: 'inherit' }}>{error}</pre>
              </div>
            ) : null}

            {result ? (
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="counter"
                  onClick={onDownloadMuxed}
                  disabled={isMuxing}
                  style={{ fontSize: 16, padding: '10px 14px' }}
                >
                  {isMuxing ? 'Working…' : 'Download your video'}
                </button>
                {humanMuxStatus ? (
                  <div style={{ marginTop: 10, fontSize: 14, opacity: 0.9 }}>{humanMuxStatus}</div>
                ) : null}
              </div>
            ) : (
              <div style={{ marginTop: 12, fontSize: 14, opacity: 0.85 }}>
                {isLoading ? 'Preparing…' : 'Waiting for a video…'}
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="counter"
                onClick={() => setShowDev((v) => !v)}
                style={{ background: 'transparent', color: 'var(--text-h)' }}
              >
                {showDev ? 'Hide technical details' : 'View technical details'}
              </button>
            </div>

            {showDev ? (
              <div
                style={{
                  marginTop: 12,
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--border)',
                    background: 'rgba(255,255,255,0.02)',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>Developer details</div>
                  <button type="button" className="counter" onClick={copyDevJson}>
                    Copy JSON
                  </button>
                </div>

                <div style={{ padding: 12 }}>
                  <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>Diagnostic data:</div>

                  <div
                    style={{
                      borderRadius: 10,
                      background: 'rgba(0,0,0,0.35)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      overflowX: 'auto',
                      padding: 12,
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      lineHeight: '1.4',
                      color: '#e5e7eb',
                    }}
                  >
                    {renderJsonHighlighted(devJson)}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </>
  )
}

export default App
