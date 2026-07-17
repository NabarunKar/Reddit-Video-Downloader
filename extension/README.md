# Reddit Video Downloader (Chrome Extension)

This folder contains a **Manifest V3** Chrome extension that behaves like the Tampermonkey userscript in `userscript/reddit-video-handoff.user.js`.

## What it does
- Runs on `https://www.reddit.com/*`
- Adds a small fixed-position **Download video** button on Reddit post pages
- When clicked, it fetches the current post's `.json` metadata **same-origin**, finds `dashUrl`/`dash_url`, and opens:

`https://reddit-video-downloader-2.vercel.app/#dashUrl=<encoded>`

No analytics, tracking, or telemetry.

## Permissions
- No declared permissions.
- Uses a content script restricted to `https://www.reddit.com/*`.

## Load unpacked (local testing)
1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension/` folder.
6. Navigate to a Reddit post on `https://www.reddit.com/.../comments/...`.
7. Click **Download video**.

## Packaging for Chrome Web Store
- Replace the placeholder icons in `extension/icons/`.
- Increment `version` in `manifest.json`.
- Zip the **contents** of `extension/` (not the parent folder) and upload.

## Notes / limitations
- This is a content-script-only extension. It does not use background scripts.
- Reddit uses SPA navigation; the script polls for URL changes every 500ms (same as the userscript).
