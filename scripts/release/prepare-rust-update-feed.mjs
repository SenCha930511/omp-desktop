#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `<os>-<arch>` keys cargo-packager-updater resolves for the running target.
 * The OS names come from its `get_updater_target`; the architectures from
 * `get_updater_arch`.
 */
export const UPDATE_PLATFORM_PATTERN = /^(?:macos|linux|windows)-(?:x86_64|aarch64|i686|armv7|riscv64)$/

/** Formats cargo-packager 0.11 produces for this app and the updater accepts. */
export const UPDATE_FORMATS = Object.freeze(['app', 'nsis', 'appimage'])

/**
 * File-name suffixes cargo-packager 0.11 writes for each updater format. A
 * macOS `app` output is the `.app` directory archived and signed as
 * `.app.tar.gz`; Windows signs the NSIS installer and Linux the AppImage.
 */
export const UPDATE_ARTIFACT_SUFFIXES = Object.freeze([
  { suffix: '.app.tar.gz', format: 'app' },
  { suffix: '-setup.exe', format: 'nsis' },
  { suffix: '.AppImage', format: 'appimage' },
])

const UPDATE_FORMAT_SET = new Set(UPDATE_FORMATS)
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
// cargo-packager writes a `.sig` file containing base64(signature box). The
// updater base64-decodes the feed's `signature` field before parsing the
// minisign signature, so a raw minisign `.sig` file would not verify.
const SIGNATURE_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * @typedef {object} UpdateFeedPlatform
 * @property {string} url
 * @property {string} signature
 * @property {string} format
 */

/**
 * @typedef {object} UpdateFeed
 * @property {string} version
 * @property {Record<string, UpdateFeedPlatform>} platforms
 */

/**
 * @typedef {object} UpdateManifestEntry
 * @property {string} platform
 * @property {string} artifact
 * @property {string} signature
 * @property {string} format
 */

/**
 * @typedef {object} PrepareUpdateFeedOptions
 * @property {string} version
 * @property {string} baseUrl
 * @property {string} [manifestPath] Explicit manifest; mutually exclusive with
 *   `artifactsPath`.
 * @property {string} [artifactsPath] Directory of downloaded release artifacts
 *   laid out as `<os>-<arch>/<artifact>[.sig]`; mutually exclusive with
 *   `manifestPath`.
 * @property {string} [outputPath]
 * @property {boolean} [check]
 */

/**
 * Validates a semver version, accepting and stripping the `v` prefix release
 * tags use. The feed itself always carries the canonical version.
 * @param {string} version
 * @returns {string}
 */
export function validateUpdateVersion(version) {
  if (typeof version !== 'string' || !version.trim()) throw new Error('Update version is required')
  const value = version.trim()
  const normalized = value.startsWith('v') ? value.slice(1) : value
  if (!SEMVER_PATTERN.test(normalized)) throw new Error(`Update version must be semver: ${version}`)
  return normalized
}

/**
 * Reads the version the packaged Rust application was built as from its
 * workspace manifest (`[workspace.package] version`). That is the value
 * compiled into `CARGO_PKG_VERSION` and compared against the feed, so the feed
 * must carry it instead of the release tag.
 * @param {string} path
 * @returns {string}
 */
export function readRustPackageVersion(path) {
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Rust workspace manifest is missing or unreadable: ${path}`)
  }
  const section = source.split(/^\[/m).find((block) => block.startsWith('workspace.package]'))
  const match = section?.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error(`Rust workspace manifest has no [workspace.package] version: ${path}`)
  return validateUpdateVersion(match[1])
}

/**
 * Validates the directory URL release assets are published under and returns it
 * with a trailing slash so artifact names resolve as path segments.
 * @param {string} baseUrl
 * @returns {URL}
 */
export function validateUpdateBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('Update base URL is required')
  let url
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new Error(`Update base URL is not a valid URL: ${baseUrl}`)
  }
  if (url.protocol !== 'https:') throw new Error(`Update base URL must use https: ${baseUrl}`)
  if (url.username || url.password) throw new Error(`Update base URL must not contain credentials: ${baseUrl}`)
  if (url.search || url.hash) throw new Error(`Update base URL must not contain a query or fragment: ${baseUrl}`)
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url
}

/**
 * Reads the base64 signature box cargo-packager writes next to a signed
 * artifact and rejects anything the updater cannot verify.
 * @param {string} path
 * @returns {string}
 */
export function readUpdateSignature(path) {
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Update signature is missing or unreadable: ${path}`)
  }
  const signature = source.trim()
  if (!signature) throw new Error(`Update signature is empty: ${path}`)
  if (signature.length % 4 !== 0 || !SIGNATURE_BASE64_PATTERN.test(signature)) {
    throw new Error(`Update signature must be the base64 signature box cargo-packager writes to a .sig file: ${path}`)
  }
  if (!/^trusted comment: /m.test(Buffer.from(signature, 'base64').toString('utf8'))) {
    throw new Error(`Update signature does not decode to a minisign signature box: ${path}`)
  }
  return signature
}

/**
 * @param {unknown} value
 * @param {string} directory
 * @param {string} label
 * @returns {string}
 */
function resolveEntryPath(value, directory, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${label} must name a single-line file path`)
  const path = resolve(directory, value.trim())
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} does not exist as a file: ${path}`)
  return path
}

/**
 * Parses and validates an update manifest. Relative artifact and signature
 * paths resolve against the manifest's own directory.
 * @param {string} source
 * @param {string} manifestPath
 * @returns {UpdateManifestEntry[]}
 */
export function parseUpdateManifest(source, manifestPath) {
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch (error) {
    throw new Error(`Cannot parse update manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`Update manifest must be a JSON object: ${manifestPath}`)
  const platforms = manifest.platforms
  if (!Array.isArray(platforms) || platforms.length === 0) throw new Error(`Update manifest must list at least one platform: ${manifestPath}`)

  const directory = dirname(resolve(manifestPath))
  const seen = new Set()
  const entries = []
  for (const [index, entry] of platforms.entries()) {
    const label = `Update manifest platform #${index + 1}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} must be an object`)
    const platform = entry.platform
    if (typeof platform !== 'string' || !UPDATE_PLATFORM_PATTERN.test(platform)) throw new Error(`${label} has an unsupported platform: ${String(platform)}`)
    if (seen.has(platform)) throw new Error(`Update manifest contains duplicate platform: ${platform}`)
    seen.add(platform)
    const format = entry.format
    if (typeof format !== 'string' || !UPDATE_FORMAT_SET.has(format)) throw new Error(`${label} (${platform}) has an unsupported format: ${String(format)}`)
    entries.push({
      platform,
      artifact: resolveEntryPath(entry.artifact, directory, `${label} (${platform}) artifact`),
      signature: resolveEntryPath(entry.signature, directory, `${label} (${platform}) signature`),
      format,
    })
  }
  return entries
}

/**
 * Builds the feed object. Platform keys are sorted so identical inputs always
 * serialize to identical bytes.
 * @param {{ version: string, baseUrl: string, manifestSource: string, manifestPath: string }} options
 * @returns {UpdateFeed}
 */
export function buildUpdateFeed({ version, baseUrl, manifestSource, manifestPath }) {
  const normalizedVersion = validateUpdateVersion(version)
  const base = validateUpdateBaseUrl(baseUrl)
  const entries = parseUpdateManifest(manifestSource, manifestPath).sort((left, right) => (left.platform < right.platform ? -1 : left.platform > right.platform ? 1 : 0))
  /** @type {Record<string, UpdateFeedPlatform>} */
  const platforms = {}
  for (const entry of entries) {
    platforms[entry.platform] = {
      url: new URL(encodeURIComponent(basename(entry.artifact)), base).href,
      signature: readUpdateSignature(entry.signature),
      format: entry.format,
    }
  }
  return { version: normalizedVersion, platforms }
}

/**
 * Serializes the feed deterministically: two-space JSON with a trailing newline.
 * @param {UpdateFeed} feed
 * @returns {string}
 */
export function serializeUpdateFeed(feed) {
  return `${JSON.stringify(feed, null, 2)}\n`
}

/**
 * Builds a manifest from downloaded release artifacts laid out as
 * `<artifacts>/<os>-<arch>/<artifact>[.sig]`, the shape per-platform
 * `actions/upload-artifact` directories produce. Each platform directory must
 * hold exactly one supported artifact and the cargo-packager signature for it.
 * Paths are relative to the artifacts directory, which is where the feed
 * resolves them from.
 * @param {string} directory
 * @returns {{ platforms: UpdateManifestEntry[] }}
 */
export function discoverUpdateManifest(directory) {
  const root = resolve(directory)
  let children
  try {
    children = readdirSync(root, { withFileTypes: true })
  } catch {
    throw new Error(`Update artifacts directory is missing or unreadable: ${root}`)
  }
  const platformDirectories = children
    .filter((child) => child.isDirectory())
    .map((child) => child.name)
    .sort()
  if (platformDirectories.length === 0) throw new Error(`Update artifacts directory has no <os>-<arch> platform directories: ${root}`)
  /** @type {UpdateManifestEntry[]} */
  const platforms = []
  for (const platform of platformDirectories) {
    if (!UPDATE_PLATFORM_PATTERN.test(platform)) throw new Error(`Update artifacts directory has an unsupported platform name: ${platform}`)
    const files = readdirSync(join(root, platform), { withFileTypes: true })
      .filter((child) => child.isFile())
      .map((child) => child.name)
    const artifacts = files.filter((name) => UPDATE_ARTIFACT_SUFFIXES.some(({ suffix }) => name.endsWith(suffix)))
    if (artifacts.length !== 1) throw new Error(`Update artifacts for ${platform} must contain exactly one supported artifact (found ${artifacts.length})`)
    const artifact = artifacts[0]
    const format = UPDATE_ARTIFACT_SUFFIXES.find(({ suffix }) => artifact.endsWith(suffix))?.format
    const signature = `${artifact}.sig`
    if (!files.includes(signature)) throw new Error(`Update artifact ${platform}/${artifact} is missing its ${signature} signature file`)
    platforms.push({ platform, artifact: `${platform}/${artifact}`, signature: `${platform}/${signature}`, format })
  }
  return { platforms }
}

/**
 * Validates the manifest and either writes the feed or, in check mode, only
 * reports what would be written.
 * @param {PrepareUpdateFeedOptions} options
 * @returns {{ feed: UpdateFeed, contents: string, outputPath: string, written: boolean }}
 */
export function prepareRustUpdateFeed({ version, baseUrl, manifestPath, artifactsPath, outputPath = 'updates.json', check = false }) {
  if (Boolean(manifestPath) === Boolean(artifactsPath)) throw new Error('Provide either an update manifest or an artifacts directory')
  let resolvedManifestPath
  let manifestSource
  if (manifestPath) {
    resolvedManifestPath = resolve(manifestPath)
    try {
      manifestSource = readFileSync(resolvedManifestPath, 'utf8')
    } catch {
      throw new Error(`Update manifest is missing or unreadable: ${resolvedManifestPath}`)
    }
  } else {
    // buildUpdateFeed resolves entry paths against the manifest's directory, so
    // the discovered manifest is anchored inside the artifacts directory
    // without being written to disk.
    const directory = resolve(artifactsPath)
    resolvedManifestPath = join(directory, 'artifacts-manifest.json')
    manifestSource = JSON.stringify(discoverUpdateManifest(directory))
  }
  const feed = buildUpdateFeed({ version, baseUrl, manifestSource, manifestPath: resolvedManifestPath })
  const contents = serializeUpdateFeed(feed)
  const resolvedOutputPath = resolve(outputPath)
  if (check) return { feed, contents, outputPath: resolvedOutputPath, written: false }
  mkdirSync(dirname(resolvedOutputPath), { recursive: true })
  writeFileSync(resolvedOutputPath, contents)
  return { feed, contents, outputPath: resolvedOutputPath, written: true }
}

export function invokedAsScript() {
  if (!process.argv[1]) return true
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

/**
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

if (invokedAsScript()) {
  try {
    const args = process.argv.slice(2)
    const version = option(args, '--version')
    const versionFile = option(args, '--version-file')
    const baseUrl = option(args, '--base-url')
    const manifestPath = option(args, '--manifest')
    const artifactsPath = option(args, '--artifacts')
    if (version && versionFile) throw new Error('Provide only one of --version and --version-file')
    if (!version && !versionFile) throw new Error('Provide --version or --version-file')
    if (!baseUrl || (!manifestPath && !artifactsPath)) throw new Error('Provide --base-url and either --manifest or --artifacts')
    if (manifestPath && artifactsPath) throw new Error('Provide only one of --manifest and --artifacts')
    const result = prepareRustUpdateFeed({
      version: version ?? readRustPackageVersion(versionFile),
      baseUrl,
      manifestPath,
      artifactsPath,
      outputPath: option(args, '--output') ?? 'updates.json',
      check: args.includes('--check'),
    })
    const platformCount = Object.keys(result.feed.platforms).length
    if (result.written) console.log(`Wrote ${platformCount} platform(s) for ${result.feed.version} to ${result.outputPath}.`)
    else console.log(`Validated ${platformCount} platform(s) for ${result.feed.version}; no file written.`)
  } catch (error) {
    console.error(`Rust update feed preparation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
