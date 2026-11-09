// Self update from the latest GitHub release (kalmik/prway).
// Checks on startup and every 6 hours; the user starts the download and the restart.
// Done by hand instead of electron-updater, whose macOS path needs a real signing certificate:
//  - macOS: download the .zip, unpack it, swap the .app bundle after PRway quits, reopen it.
//    Files Node downloads get no quarantine flag, so Gatekeeper doesn't block the new version.
//  - Windows: run the NSIS installer silently; it replaces the app and starts it again.
//  - Linux AppImage: replace the AppImage file and start it again. Other Linux installs (deb) only
//    get a link to the release page.

import { app, net } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { access, chmod, constants, mkdir, rename, rm, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateState } from '../shared/types'

const run = promisify(execFile)
const LATEST = 'https://api.github.com/repos/kalmik/prway/releases/latest'
const EVERY = 6 * 60 * 60 * 1000

interface Asset {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
}

export class Updater {
  private state: UpdateState = { status: 'idle', current: app.getVersion() }
  private asset: Asset | null = null
  private file: string | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private onChange: (s: UpdateState) => void) {}

  get(): UpdateState {
    return this.state
  }

  start(): void {
    if (!app.isPackaged) {
      this.set({ status: 'idle', manualOnly: 'Development build: updates are off.' })
      return
    }
    // Leftovers of the update that started this version.
    void rm(join(app.getPath('temp'), 'prway-update'), { recursive: true, force: true })
    setTimeout(() => void this.check(), 10_000)
    this.timer = setInterval(() => void this.check(), EVERY)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.state
    // Don't throw away a download in progress or one ready to install.
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.state
    this.set({ status: 'checking', error: undefined })
    try {
      const res = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } })
      if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`)
      const rel = (await res.json()) as { tag_name: string; html_url: string; assets: Asset[] }
      const latest = rel.tag_name.replace(/^v/, '')
      const checkedAt = new Date().toISOString()
      if (newer(latest, this.state.current) <= 0) {
        this.set({ status: 'current', latest, releaseUrl: rel.html_url, checkedAt })
        return this.state
      }
      const { asset, manualOnly } = await pickAsset(rel.assets)
      this.asset = asset
      this.file = null
      this.set({ status: 'available', latest, releaseUrl: rel.html_url, checkedAt, manualOnly, progress: undefined })
    } catch (err) {
      this.set({ status: 'error', error: `Couldn't check for updates: ${(err as Error).message}` })
    }
    return this.state
  }

  async download(): Promise<void> {
    if (this.state.status !== 'available' || !this.asset || this.state.manualOnly) return
    const asset = this.asset
    const dir = join(app.getPath('temp'), 'prway-update', this.state.latest!)
    const file = join(dir, asset.name)
    this.set({ status: 'downloading', progress: 0, error: undefined })
    try {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await fetchTo(asset, file, (p) => this.set({ progress: p }))
      if (process.platform === 'darwin') {
        await run('ditto', ['-x', '-k', file, join(dir, 'app')])
        if (!existsSync(join(dir, 'app', 'PRway.app'))) throw new Error('The download has no PRway.app inside')
      }
      this.file = file
      this.set({ status: 'ready', progress: 1 })
    } catch (err) {
      this.set({ status: 'available', progress: undefined, error: `Download failed: ${(err as Error).message}` })
    }
  }

  /** Quits PRway, puts the new version in place and starts it. */
  async install(): Promise<void> {
    if (this.state.status !== 'ready' || !this.file) return
    const file = this.file
    try {
      if (process.platform === 'darwin') {
        const bundle = appBundle()!
        const fresh = join(dirname(file), 'app', 'PRway.app')
        // Wait for this process to exit, swap the bundles, keep the old one if the move fails, reopen.
        const script =
          'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; ' +
          'rm -rf "$2.old"; mv "$2" "$2.old" && { mv "$3" "$2" || mv "$2.old" "$2"; }; ' +
          'rm -rf "$2.old"; open "$2"'
        spawn('/bin/sh', ['-c', script, 'prway-update', String(process.pid), bundle, fresh], {
          detached: true,
          stdio: 'ignore'
        }).unref()
      } else if (process.platform === 'win32') {
        // electron-builder's NSIS flags: --updated skips the "app is running" prompt, --force-run starts it after.
        spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      } else {
        const target = process.env.APPIMAGE!
        const next = `${target}.new`
        await copyFile(file, next)
        await chmod(next, 0o755)
        await rename(next, target)
        spawn(target, [], { detached: true, stdio: 'ignore' }).unref()
      }
      this.set({ status: 'installing' })
      setTimeout(() => app.quit(), 300)
    } catch (err) {
      this.set({ error: `Couldn't install the update: ${(err as Error).message}` })
    }
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
}

/** > 0 when `a` is a newer x.y.z version than `b`. */
export function newer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** The .app this process runs from (macOS). */
function appBundle(): string | null {
  const bundle = resolve(app.getPath('exe'), '../../..')
  return bundle.endsWith('.app') ? bundle : null
}

/** The file to download for this install, or why it can't update itself. */
async function pickAsset(assets: Asset[]): Promise<{ asset: Asset | null; manualOnly?: string }> {
  const find = (name: string) => assets.find((a) => a.name === name) ?? null
  let asset: Asset | null = null
  if (process.platform === 'darwin') {
    const bundle = appBundle()
    if (!bundle) return { asset: null, manualOnly: "PRway isn't running from an app bundle." }
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/'))
      return { asset: null, manualOnly: 'Move PRway to the Applications folder, open it from there, then update.' }
    try {
      await access(dirname(bundle), constants.W_OK)
    } catch {
      return { asset: null, manualOnly: `PRway can't write to ${dirname(bundle)}.` }
    }
    asset = find(`PRway-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`)
  } else if (process.platform === 'win32') {
    asset = find('PRway-win-x64.exe')
  } else {
    if (!process.env.APPIMAGE) return { asset: null, manualOnly: 'Installed from a package: download the new one from the release page.' }
    asset = find('PRway-linux-x86_64.AppImage')
  }
  return asset ? { asset } : { asset: null, manualOnly: 'This release has no download for your system yet.' }
}

/** Streams the asset to `file`, checking its size and, when GitHub gives one, its sha256. */
async function fetchTo(asset: Asset, file: string, progress: (p: number) => void): Promise<void> {
  const res = await net.fetch(asset.browser_download_url)
  if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} ${res.statusText}`)
  const out = createWriteStream(file)
  const hash = createHash('sha256')
  const reader = res.body.getReader()
  let got = 0
  let last = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      got += value.length
      if (!out.write(value)) await new Promise((r) => out.once('drain', r))
      const p = asset.size ? got / asset.size : 0
      if (p - last >= 0.01) {
        last = p
        progress(Math.min(p, 0.99))
      }
    }
  } finally {
    await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())))
  }
  if (asset.size && got !== asset.size) throw new Error(`got ${got} bytes, expected ${asset.size}`)
  const want = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null
  if (want && hash.digest('hex') !== want) throw new Error("the file doesn't match the release checksum")
}
