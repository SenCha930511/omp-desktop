import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  bootstrapNpm,
  parsePinnedNpmArtifact,
  persistNpmCliPath,
  persistNpmShimDirectory,
  readPinnedNpmArtifact,
  resolveNpmGlobalLayout,
  verifyPinnedNpmArtifact,
} from '../scripts/release/bootstrap-npm.mjs'
import { assertSupportedNode, assertSupportedNpm, assertSupportedToolchain, parseToolchainMetadata, readNpmOutput, readNpmVersion, readRepositoryToolchain } from '../scripts/release/lib.mjs'
import { buildUpdateFeed, prepareRustUpdateFeed, readRustPackageVersion, serializeUpdateFeed, validateUpdateBaseUrl, validateUpdateVersion } from '../scripts/release/prepare-rust-update-feed.mjs'
import { parseDraftAssetNames, staleDraftReleaseAssets } from '../scripts/release/prune-draft-release-assets.mjs'
import { assertReleaseTag } from '../scripts/release/validate-release-tag.mjs'

// js-yaml ships no type declarations, so it is required rather than imported.
const load = createRequire(import.meta.url)('js-yaml').load as (source: string) => unknown

const PINNED_NPM_INTEGRITY = 'sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw=='

function npmArtifactManifest(size: number, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    artifacts: {
      npm: {
        version: '12.0.2',
        path: 'vendor/npm-12.0.2.tgz',
        source: 'https://registry.npmjs.org/npm/-/npm-12.0.2.tgz',
        integrity: PINNED_NPM_INTEGRITY,
        size,
        license: 'Artistic-2.0',
        ...overrides,
      },
    },
  })
}

function createPinnedNpmArtifactFixture(contents = Buffer.from('verified npm archive fixture')) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'omp-desktop npm artifact & '))
  const repositoryRoot = join(temporaryDirectory, 'repository with spaces & metacharacters')
  const artifactPath = join(repositoryRoot, 'vendor', 'npm-12.0.2.tgz')
  mkdirSync(dirname(artifactPath), { recursive: true })
  writeFileSync(artifactPath, contents)
  const integrity = `sha512-${createHash('sha512').update(contents).digest('base64')}`
  const manifest = npmArtifactManifest(contents.length, { integrity })
  const artifact = parsePinnedNpmArtifact(manifest, { node: '24.15.0', npm: '12.0.2' }, repositoryRoot)
  return { temporaryDirectory, repositoryRoot, artifactPath, artifact, manifest, contents, integrity }
}

interface WorkflowStep {
  job: string
  name: string | undefined
  uses: string | undefined
  secretLines: string[]
  lines: string[]
}

/** Minimal structural read of a GitHub workflow: jobs and their step blocks. */
function parseWorkflowSteps(source: string): WorkflowStep[] {
  const steps: WorkflowStep[] = []
  let job = ''
  let inJobs = false
  let current: WorkflowStep | undefined
  for (const line of source.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      continue
    }
    if (!inJobs) continue
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (jobMatch) {
      job = jobMatch[1]
      current = undefined
      continue
    }
    if (/^ {6}- /.test(line)) {
      current = { job, name: undefined, uses: undefined, secretLines: [], lines: [] }
      steps.push(current)
    }
    if (!current) continue
    current.lines.push(line)
    const name = line.match(/^\s*(?:- )?name:\s*(.+?)\s*$/)
    if (name && current.name === undefined) current.name = name[1]
    const uses = line.match(/^\s*(?:- )?uses:\s*(\S+)/)
    if (uses && current.uses === undefined) current.uses = uses[1]
    if (line.includes('secrets.')) current.secretLines.push(line)
  }
  return steps
}

describe('release toolchain', () => {
  test('enforces the repository Node and npm boundaries from checked-in metadata', () => {
    expect(readRepositoryToolchain()).toEqual({ node: '24.15.0', npm: '12.0.2' })
    expect(() => assertSupportedNode('v24.14.99')).toThrow(/Node\.js >=24\.15\.0 is required/)
    expect(() => assertSupportedNode('v24.15.0')).not.toThrow()
    expect(() => assertSupportedNode('v25.0.0')).not.toThrow()
    expect(() => assertSupportedNpm('12.0.1')).toThrow(/npm >=12\.0\.2 is required/)
    expect(() => assertSupportedNpm('12.0.2')).not.toThrow()
    expect(() => assertSupportedNpm('13.0.0')).not.toThrow()
    expect(() => assertSupportedToolchain({ nodeVersion: 'v24.15.0', npmVersion: '12.0.2' })).not.toThrow()
  })

  test('rejects malformed and prerelease tool versions', () => {
    for (const version of ['24.15', 'v24.15.0 trailing', 'not-node']) {
      expect(() => assertSupportedNode(version)).toThrow(/Cannot parse Node\.js version/)
    }
    expect(() => assertSupportedNode('v24.15.0-rc.1')).toThrow(/stable Node\.js release/)
    for (const version of ['12.0', '12.0.2 trailing', 'not-npm']) {
      expect(() => assertSupportedNpm(version)).toThrow(/Cannot parse npm version/)
    }
    expect(() => assertSupportedNpm('12.0.2-beta.1')).toThrow(/stable npm release/)
  })

  test('fails closed when checked-in toolchain metadata disagrees', () => {
    const packageMetadata = {
      engines: { node: '>=24.15.0', npm: '>=12.0.2' },
      packageManager: 'npm@12.0.2',
    }
    expect(parseToolchainMetadata(JSON.stringify(packageMetadata), '24.15.0\n')).toEqual({ node: '24.15.0', npm: '12.0.2' })
    expect(() => parseToolchainMetadata(JSON.stringify(packageMetadata), '24.14.0\n')).toThrow(/\.nvmrc.*engines\.node/)
    expect(() => parseToolchainMetadata(JSON.stringify({ ...packageMetadata, packageManager: 'npm@12.0.1' }), '24.15.0\n')).toThrow(/packageManager.*engines\.npm/)
    expect(() => parseToolchainMetadata(JSON.stringify({ ...packageMetadata, engines: { ...packageMetadata.engines, node: '^24.15.0' } }), '24.15.0\n')).toThrow(/engines\.node must use/)
    expect(() => parseToolchainMetadata(JSON.stringify(packageMetadata), '24.15.0-rc.1\n')).toThrow(/stable \.nvmrc release/)
    expect(() => parseToolchainMetadata('{', '24.15.0\n')).toThrow(/Cannot parse package\.json/)

    for (const path of ['scripts/release/lib.mjs', 'scripts/release/bootstrap-npm.mjs', 'scripts/release/preflight.mjs']) {
      const source = readFileSync(path, 'utf8')
      expect(source).not.toContain('24.15.0')
      expect(source).not.toContain('12.0.2')
    }
  })

  test('probes npm through its JavaScript CLI and the preflight rejects an old npm', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-npm-version-'))
    const npmCli = join(directory, 'npm-cli.mjs')
    writeFileSync(npmCli, "process.stdout.write('12.0.1\\n')\n")
    const env = { ...process.env, npm_execpath: npmCli }
    try {
      expect(readNpmVersion({ env })).toBe('12.0.1')
      const preflight = spawnSync(process.execPath, ['scripts/release/preflight.mjs'], { encoding: 'utf8', env })
      expect(preflight.status).toBe(1)
      expect(preflight.stderr).toContain('npm >=12.0.2 is required')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('keeps contributor instructions aligned with the enforced engines', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    const toolchain = readRepositoryToolchain()
    expect(packageJson.engines).toEqual({ node: `>=${toolchain.node}`, npm: `>=${toolchain.npm}` })
    expect(packageJson.packageManager).toBe(`npm@${toolchain.npm}`)
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe(toolchain.node)
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).toContain(`Node.js ${toolchain.node} or newer and npm ${toolchain.npm} or newer`)
    expect(readme).toContain('npm run toolchain:bootstrap')
    expect(readme).toContain("invoked npm's configured global prefix")
    expect(readme).toContain('install-time lifecycle scripts disabled')
    expect(readme).not.toContain('into the active Node installation')
    expect(readFileSync('scripts/release/preflight.mjs', 'utf8')).toContain('assertSupportedToolchain()')
  })

  test('pins every workflow action, including third-party owners, to a full commit SHA', () => {
    for (const path of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
      const steps = parseWorkflowSteps(readFileSync(path, 'utf8'))
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        if (step.uses === undefined) continue
        // Every `uses:` reference must be `owner/repo[/path]@<40-hex sha>`,
        // regardless of owner - tags and branches are movable for actions/*
        // and third-party owners alike.
        expect(step.uses, `${path} ${step.job}: ${step.uses}`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/)
      }
    }
  })

  test('confines workflow secrets to the Rust updater signing step', () => {
    const releaseSteps = parseWorkflowSteps(readFileSync('.github/workflows/release.yml', 'utf8'))
    const secretSteps = releaseSteps.filter((step) => step.secretLines.length > 0)
    expect(secretSteps.map((step) => `${step.job}: ${step.name}`)).toEqual(['package-rust: Package and sign the application'])
    for (const step of secretSteps) {
      // Secrets may only be consumed as env-var assignments inside the step's
      // env block - never interpolated into run commands or action inputs.
      expect(step.lines.some((line) => /^\s*env:\s*$/.test(line))).toBe(true)
      for (const line of step.secretLines) {
        expect(line).toMatch(/^\s+[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/)
      }
      expect(step.lines.join('\n')).not.toMatch(/run:.*secrets\./)
    }

    const ciSteps = parseWorkflowSteps(readFileSync('.github/workflows/ci.yml', 'utf8'))
    expect(ciSteps.filter((step) => step.secretLines.length > 0)).toEqual([])
  })

  test('cancels superseded PR runs without cancelling validation for pushed SHAs', () => {
    const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      concurrency: { group: string; 'cancel-in-progress': string }
    }
    expect(workflow.concurrency.group).toBe(
      "ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.event_name == 'push' && format('push-{0}', github.sha) || format('dispatch-{0}', github.run_id) }}",
    )
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}")
  })

  test('reads the Node version from .nvmrc and bootstraps the pinned toolchain before npm ci', () => {
    for (const path of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
      const source = readFileSync(path, 'utf8')
      expect(source).not.toMatch(/node-version:/)
      const steps = parseWorkflowSteps(source)
      const setupSteps = steps.filter((step) => step.uses?.startsWith('actions/setup-node@'))
      expect(setupSteps.length).toBeGreaterThan(0)
      for (const setup of setupSteps) {
        const setupIndex = steps.indexOf(setup)
        const bootstrapIndexes = steps.flatMap((step, index) => (step.job === setup.job && step.lines.some((line) => line.includes('run: npm run toolchain:bootstrap')) ? [index] : []))
        const preflightIndexes = steps.flatMap((step, index) => (step.job === setup.job && step.lines.some((line) => line.includes('run: npm run release:preflight')) ? [index] : []))
        expect(bootstrapIndexes, `${path} ${setup.job} bootstrap steps`).toHaveLength(1)
        expect(preflightIndexes, `${path} ${setup.job} preflight steps`).toHaveLength(1)
        const bootstrapIndex = bootstrapIndexes[0]
        const preflightIndex = preflightIndexes[0]
        const installIndex = steps.findIndex((step, index) => index > setupIndex && step.job === setup.job && step.lines.some((line) => /run: npm ci(?:\s|$)/.test(line)))
        expect(bootstrapIndex).toBeGreaterThan(setupIndex)
        expect(preflightIndex).toBeGreaterThan(bootstrapIndex)
        if (installIndex >= 0) expect(preflightIndex).toBeGreaterThan(installIndex)
      }
      const uploads = source.match(/uses: actions\/upload-artifact@/g) ?? []
      expect(source.match(/if-no-files-found: error/g)).toHaveLength(uploads.length)
    }
  })

  test('runs only Rust jobs in CI plus the release-tooling suite', () => {
    const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      on: Record<string, unknown>
      jobs: Record<string, { strategy?: { matrix?: { include?: Array<Record<string, string>> } }; steps?: Array<{ name?: string; run?: string }> }>
    }
    expect(workflow.on).toHaveProperty('pull_request')
    expect(Object.keys(workflow.jobs)).toEqual(['release-scripts', 'rust', 'rust-conformance', 'rust-package-smoke', 'rust-package-smoke-linux', 'rust-package-smoke-windows'])

    const toolingRuns = workflow.jobs['release-scripts']?.steps?.map((step) => step.run).filter((run): run is string => typeof run === 'string') ?? []
    expect(toolingRuns).toEqual(['npm run toolchain:bootstrap', 'npm ci', 'npm run release:preflight', 'npm run typecheck', 'npm run check', 'npm test'])

    const rustRunners = (workflow.jobs.rust?.strategy?.matrix?.include ?? []).map((entry) => entry.runner).sort()
    expect(rustRunners).toEqual(['macos-15', 'ubuntu-22.04', 'windows-2022'])
    // The Windows leg of the Rust matrix is what covers state migration there.
    expect(workflow.jobs.rust?.steps?.some((step) => step.run?.includes('cargo test --workspace --locked'))).toBe(true)

    const conformanceRunners = (workflow.jobs['rust-conformance']?.strategy?.matrix?.include ?? []).map((entry) => entry.runner).sort()
    expect(conformanceRunners).toEqual(['macos-15', 'ubuntu-22.04', 'windows-2022'])
    expect(workflow.jobs['rust-conformance']?.steps?.some((step) => step.run?.includes('--config vitest.conformance.config.ts'))).toBe(true)
  })

  test('publishes only signed Rust packages from an existing version tag', () => {
    const workflow = load(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, { required: boolean; type: string }> } }
      env: Record<string, string>
      jobs: Record<string, { needs?: string[]; if?: string; steps?: Array<{ name?: string; id?: string; run?: string; if?: string; env?: Record<string, string> }> }>
    }
    expect(workflow.env.RELEASE_TAG).toBe('${{ inputs.tag || github.ref_name }}')
    expect(workflow.on.push.tags).toEqual(['v*.*.*'])
    expect(workflow.on.workflow_dispatch.inputs.tag).toMatchObject({ required: true, type: 'string' })
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['tag'])
    expect(Object.keys(workflow.jobs)).toEqual(['validate', 'quality', 'package-rust', 'release-packages', 'rust-update-feed'])

    const packageRust = workflow.jobs['package-rust']
    expect(packageRust.needs).toEqual(['validate', 'quality'])
    const sign = packageRust.steps?.find((step) => step.id === 'package')
    expect(sign?.env).toEqual({
      RUST_UPDATER_SIGNING_KEY: '${{ secrets.RUST_UPDATER_SIGNING_KEY }}',
      CARGO_PACKAGER_SIGN_PRIVATE_KEY: '${{ secrets.RUST_UPDATER_SIGNING_KEY }}',
    })
    expect(sign?.run).toContain('cargo packager --formats ${{ matrix.format }} --release')
    expect(sign?.run).toContain('skipping the signed Rust package')

    const release = workflow.jobs['release-packages']
    expect(release.needs).toEqual(['validate', 'package-rust'])
    expect(release.if).toBe('always()')
    const steps = release.steps ?? []
    expect(steps.find((step) => step.name === 'Fail if a release prerequisite did not succeed')?.run).toContain('exit 1')
    expect(steps.find((step) => step.name === 'Fail closed unless every signed Rust package was produced')?.run).toContain('RUST_UPDATER_SIGNING_KEY')
    expect(steps.find((step) => step.name === 'Add the signed Rust packages to the release assets')?.run).toContain('release-assets')
    expect(steps.find((step) => step.name === 'Write SHA-256 checksums for every published asset')?.run).toContain('SHA256SUMS.txt')
    expect(steps.some((step) => step.name === 'Attest release assets')).toBe(true)

    const publish = steps.find((step) => step.name === 'Publish GitHub Release')?.run ?? ''
    expect(publish.trimStart().startsWith('tag_sha=$(gh api repos/${{ github.repository }}/commits/$RELEASE_TAG --jq .sha)')).toBe(true)
    expect(publish).toContain('is already published and will not be replaced')
    expect(publish).toContain('gh release upload "$RELEASE_TAG" release-assets/* --clobber')
    expect(publish).toContain('gh release create "$RELEASE_TAG" release-assets/*')
    expect(publish).toContain('--verify-tag')
    expect(publish).toContain('--fail-on-no-commits')
    expect(publish).toContain('--latest')
    expect(publish).not.toContain('--prerelease')
    expect(steps.find((step) => step.name === 'Publish GitHub Release')?.env?.GH_TOKEN).toBe('${{ github.token }}')

    const feed = workflow.jobs['rust-update-feed']
    expect(feed.needs).toEqual(['validate', 'release-packages', 'package-rust'])
    expect(feed.if).toContain("needs.release-packages.result == 'success'")
    expect(feed.if).toContain("needs.package-rust.result == 'success'")
    const generate = feed.steps?.find((step) => step.name === 'Generate and upload the Rust updater feed')
    expect(generate?.if).toBe("steps.signatures.outputs.signed == 'true'")
    expect(generate?.run).toContain('--version-file rust/Cargo.toml')
    expect(generate?.run).toContain('--artifacts rust-artifacts')
    expect(generate?.run).toContain('gh release upload "$RELEASE_TAG" rust-update-feed/updates.json --clobber')
    expect(generate?.env?.GH_TOKEN).toBe('${{ github.token }}')
  })
})

describe('npm bootstrap', () => {
  test('binds the npm bootstrap artifact to the packageManager version and canonical registry provenance', () => {
    const fixture = createPinnedNpmArtifactFixture()
    try {
      expect(fixture.artifact).toMatchObject({
        version: '12.0.2',
        relativePath: 'vendor/npm-12.0.2.tgz',
        path: fixture.artifactPath,
        source: 'https://registry.npmjs.org/npm/-/npm-12.0.2.tgz',
        integrity: fixture.integrity,
        size: fixture.contents.length,
        license: 'Artistic-2.0',
      })

      const invalidPins = [
        npmArtifactManifest(fixture.contents.length, { version: '12.0.1' }),
        npmArtifactManifest(fixture.contents.length, { path: 'vendor/npm-elsewhere.tgz' }),
        npmArtifactManifest(fixture.contents.length, { path: '../npm-12.0.2.tgz' }),
        npmArtifactManifest(fixture.contents.length, { source: 'https://example.invalid/npm-12.0.2.tgz' }),
        npmArtifactManifest(fixture.contents.length, { integrity: 'sha256-not-strong-enough' }),
        npmArtifactManifest(fixture.contents.length, { size: 0 }),
        npmArtifactManifest(fixture.contents.length, { size: 1.5 }),
        npmArtifactManifest(fixture.contents.length, { license: 'MIT' }),
        JSON.stringify({ artifacts: {} }),
        '{',
      ]
      for (const source of invalidPins) {
        expect(() => parsePinnedNpmArtifact(source, { node: '24.15.0', npm: '12.0.2' }, fixture.repositoryRoot)).toThrow(/npm bootstrap artifact|dependency-pins\.json/)
      }
    } finally {
      rmSync(fixture.temporaryDirectory, { recursive: true, force: true })
    }
  })

  test('verifies the npm archive before any npm invocation and rejects unsafe artifact state', () => {
    const fixture = createPinnedNpmArtifactFixture()
    try {
      expect(verifyPinnedNpmArtifact(fixture.artifact)).toEqual(fixture.artifact)

      writeFileSync(fixture.artifactPath, Buffer.alloc(fixture.contents.length, 0x78))
      let npmInvocations = 0
      expect(() =>
        bootstrapNpm({
          artifact: fixture.artifact,
          nodeVersion: 'v24.15.0',
          toolchain: { node: '24.15.0', npm: '12.0.2' },
          readOutput: () => {
            npmInvocations += 1
            return 'unexpected'
          },
          run: () => {
            npmInvocations += 1
          },
          persist: () => {
            throw new Error('GITHUB_PATH must not be updated after verification failure')
          },
        }),
      ).toThrow(/integrity does not match/)
      expect(npmInvocations).toBe(0)

      writeFileSync(fixture.artifactPath, fixture.contents.subarray(0, fixture.contents.length - 1))
      expect(() => verifyPinnedNpmArtifact(fixture.artifact)).toThrow(/size does not match/)
      rmSync(fixture.artifactPath)
      expect(() => verifyPinnedNpmArtifact(fixture.artifact)).toThrow(/does not exist/)
      expect(() =>
        verifyPinnedNpmArtifact(fixture.artifact, {
          lstat: () => ({ isFile: () => false, isSymbolicLink: () => true, size: fixture.contents.length }),
          readFile: () => fixture.contents,
        }),
      ).toThrow(/regular non-symlink file/)
    } finally {
      rmSync(fixture.temporaryDirectory, { recursive: true, force: true })
    }
  })

  test('derives the exact npm CLI and shim from POSIX and Windows global layouts', () => {
    expect(resolveNpmGlobalLayout('/opt/npm', '/opt/npm/lib/node_modules', 'linux')).toEqual({
      prefix: '/opt/npm',
      root: '/opt/npm/lib/node_modules',
      cliPath: '/opt/npm/lib/node_modules/npm/bin/npm-cli.js',
      shimDirectory: '/opt/npm/bin',
      shimPath: '/opt/npm/bin/npm',
    })
    expect(resolveNpmGlobalLayout('C:\\npm\\prefix', 'C:\\npm\\prefix\\node_modules', 'win32')).toEqual({
      prefix: 'C:\\npm\\prefix',
      root: 'C:\\npm\\prefix\\node_modules',
      cliPath: 'C:\\npm\\prefix\\node_modules\\npm\\bin\\npm-cli.js',
      shimDirectory: 'C:\\npm\\prefix',
      shimPath: 'C:\\npm\\prefix\\npm.cmd',
    })
  })

  test('rejects unsafe or inconsistent npm global layout metadata', () => {
    expect(() => resolveNpmGlobalLayout('relative', '/opt/npm/lib/node_modules', 'linux')).toThrow(/absolute single-line path/)
    expect(() => resolveNpmGlobalLayout('/opt/npm\n/injected', '/opt/npm/lib/node_modules', 'linux')).toThrow(/absolute single-line path/)
    expect(() => resolveNpmGlobalLayout('/opt/npm', '/elsewhere/node_modules', 'linux')).toThrow(/does not match.*prefix/)
    expect(() => resolveNpmGlobalLayout('C:\\npm\\prefix', 'D:\\other\\node_modules', 'win32')).toThrow(/does not match.*prefix/)
  })

  test('exact npm CLI verification ignores a stale lifecycle npm_execpath', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop exact npm & version-'))
    const staleCli = join(directory, 'stale-npm-cli.mjs')
    const installedCli = join(directory, 'installed-npm-cli.mjs')
    writeFileSync(staleCli, "process.stdout.write('11.12.1\\n')\n")
    writeFileSync(installedCli, "process.stdout.write('12.0.2\\n')\n")
    const env = { ...process.env, npm_execpath: staleCli }
    try {
      expect(readNpmOutput(['--version'], { env })).toBe('11.12.1')
      expect(readNpmOutput(['--version'], { env, npmCliPath: installedCli })).toBe('12.0.2')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('always installs the verified archive and verifies the installed CLI, even when invoked npm reports the pinned version', () => {
    const fixture = createPinnedNpmArtifactFixture()
    const staleCli = '/runner/node/lib/node_modules/npm/bin/npm-cli.js'
    const githubPath = '/runner/github-path'
    const calls: Array<{ args: string[]; npmCliPath: string | undefined }> = []
    const runs: Array<{ command: string; args: string[]; shell: boolean }> = []
    const persisted: Array<{ shimDirectory: string; destination: string | undefined }> = []
    let installed = false
    try {
      const result = bootstrapNpm({
        artifact: fixture.artifact,
        env: { npm_execpath: staleCli, GITHUB_PATH: githubPath },
        nodeVersion: 'v24.15.0',
        platform: 'linux',
        toolchain: { node: '24.15.0', npm: '12.0.2' },
        readOutput: (args: string[], options: { npmCliPath?: string }) => {
          calls.push({ args, npmCliPath: options.npmCliPath })
          if (args[0] === 'prefix') return '/runner/npm-global'
          if (args[0] === 'root') return '/runner/npm-global/lib/node_modules'
          if (!options.npmCliPath) return '12.0.2'
          return options.npmCliPath && installed ? '12.0.2' : '11.12.1'
        },
        run: (command: string, args: string[], options: { shell?: boolean }) => {
          installed = true
          return runs.push({ command, args, shell: options.shell ?? false })
        },
        fileExists: () => true,
        persist: (shimDirectory: string, destination: string | undefined) => {
          persisted.push({ shimDirectory, destination })
          return true
        },
      })

      expect(runs).toEqual([
        {
          command: 'npm',
          args: ['install', '--global', '--prefix', '/runner/npm-global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', fixture.artifactPath],
          shell: false,
        },
      ])
      expect(runs[0]?.args.join(' ')).not.toContain('npm@12.0.2')
      expect(runs[0]?.args.some((argument) => argument.startsWith('https://'))).toBe(false)
      expect(calls.at(-1)).toEqual({
        args: ['--version'],
        npmCliPath: '/runner/npm-global/lib/node_modules/npm/bin/npm-cli.js',
      })
      expect(persisted).toEqual([{ shimDirectory: '/runner/npm-global/bin', destination: githubPath }])
      expect(result).toMatchObject({ current: '12.0.2', installed: '12.0.2', shimDirectory: '/runner/npm-global/bin', githubPathUpdated: true })
    } finally {
      rmSync(fixture.temporaryDirectory, { recursive: true, force: true })
    }
  })

  test('executes the installed npm CLI and selects its shim for the next workflow step', () => {
    const fixture = createPinnedNpmArtifactFixture()
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop stale npm & bootstrap-'))
    const prefix = join(directory, 'configured global')
    const root = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
    const layout = resolveNpmGlobalLayout(prefix, root)
    const staleCli = join(directory, 'stale npm-cli.mjs')
    const githubPath = join(directory, 'github-path')
    const expectedInstallArgs = ['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', fixture.artifactPath]
    mkdirSync(dirname(staleCli), { recursive: true })
    writeFileSync(githubPath, '')
    writeFileSync(
      staleCli,
      `import { mkdirSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '--version') process.stdout.write('11.12.1\\n')
else if (args[0] === 'prefix') process.stdout.write(${JSON.stringify(`${prefix}\n`)})
else if (args[0] === 'root') process.stdout.write(${JSON.stringify(`${root}\n`)})
else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(expectedInstallArgs))}) {
  mkdirSync(${JSON.stringify(dirname(layout.cliPath))}, { recursive: true })
  mkdirSync(${JSON.stringify(layout.shimDirectory)}, { recursive: true })
  writeFileSync(${JSON.stringify(layout.cliPath)}, "process.stdout.write('12.0.2\\\\n')\\n")
  writeFileSync(${JSON.stringify(layout.shimPath)}, 'npm shim')
} else {
  process.stderr.write(\`unexpected fake npm arguments: \${JSON.stringify(args)}\`)
  process.exitCode = 2
}
`,
    )

    try {
      const result = bootstrapNpm({ artifact: fixture.artifact, env: { ...process.env, GITHUB_PATH: githubPath, npm_execpath: staleCli } })
      expect(result).toMatchObject({ current: '11.12.1', installed: '12.0.2', ...layout, githubPathUpdated: true })
      expect(readFileSync(githubPath, 'utf8')).toBe(`${layout.shimDirectory}\n`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(fixture.temporaryDirectory, { recursive: true, force: true })
    }
  })

  test('installs the checked-in npm archive into a fresh prefix without network access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop real npm bootstrap & '))
    const prefix = join(directory, 'fresh global prefix')
    const githubPath = join(directory, 'github-path')
    const cache = join(directory, 'npm cache')
    writeFileSync(githubPath, '')
    try {
      const result = bootstrapNpm({
        env: {
          ...process.env,
          GITHUB_PATH: githubPath,
          npm_config_cache: cache,
          npm_config_prefix: prefix,
        },
      })
      expect(result).toMatchObject({ installed: '12.0.2', prefix, githubPathUpdated: true })
      expect(readFileSync(githubPath, 'utf8')).toBe(`${result.shimDirectory}\n`)
      expect(readNpmOutput(['--version'], { npmCliPath: result.cliPath })).toBe('12.0.2')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test('persists only a validated npm shim directory for the next GitHub Actions step', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-github-path-'))
    const githubPath = join(directory, 'github-path')
    writeFileSync(githubPath, '/existing/tool\n')
    try {
      expect(persistNpmShimDirectory('/opt/repository-npm/bin', githubPath, 'linux')).toBe(true)
      const entries = readFileSync(githubPath, 'utf8').trimEnd().split('\n')
      expect(entries).toEqual(['/existing/tool', '/opt/repository-npm/bin'])
      // GitHub prepends GITHUB_PATH entries to PATH for subsequent steps, so
      // the persisted entry becomes the npm selected by the next npm command.
      expect(entries.at(-1)).toBe('/opt/repository-npm/bin')
      expect(() => persistNpmShimDirectory('/opt/npm\n/injected', githubPath, 'linux')).toThrow(/absolute single-line path/)
      expect(() => persistNpmShimDirectory('/opt/npm/bin', 'relative/github-path', 'linux')).toThrow(/absolute single-line path/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('persists the bootstrapped npm CLI for direct Node release entry points', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omp-desktop-github-env-'))
    const githubEnv = join(directory, 'github-env')
    writeFileSync(githubEnv, '')
    try {
      expect(persistNpmCliPath('/opt/repository-npm/lib/node_modules/npm/bin/npm-cli.js', githubEnv, 'linux')).toBe(true)
      expect(readFileSync(githubEnv, 'utf8')).toBe('npm_execpath=/opt/repository-npm/lib/node_modules/npm/bin/npm-cli.js\n')
      expect(() => persistNpmCliPath('/opt/npm\n/injected', githubEnv, 'linux')).toThrow(/absolute single-line path/)
      expect(() => persistNpmCliPath('/opt/npm/bin/npm-cli.js', 'relative/github-env', 'linux')).toThrow(/absolute single-line path/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('vendored supply-chain pins', () => {
  test('vendor/ holds only the pinned npm bootstrap artifacts', () => {
    const manifest = JSON.parse(readFileSync('scripts/release/dependency-pins.json', 'utf8'))
    // A new vendored package must add a pin deliberately rather than
    // reappearing silently in vendor/.
    expect(manifest.packages).toEqual({})
    expect(readdirSync('vendor').sort()).toEqual(['npm-12.0.2.md', 'npm-12.0.2.tgz'])
  })

  test('the checked-in npm bootstrap archive matches its strict artifact pin and provenance record', () => {
    const pinManifest = JSON.parse(readFileSync('scripts/release/dependency-pins.json', 'utf8'))
    const artifact = readPinnedNpmArtifact()
    expect(pinManifest.artifacts).toEqual({
      npm: {
        version: '12.0.2',
        path: 'vendor/npm-12.0.2.tgz',
        source: 'https://registry.npmjs.org/npm/-/npm-12.0.2.tgz',
        integrity: PINNED_NPM_INTEGRITY,
        size: artifact.size,
        license: 'Artistic-2.0',
      },
    })
    expect(verifyPinnedNpmArtifact(artifact)).toEqual(artifact)
    expect(readdirSync('vendor').filter((name) => /^npm-\d+\.\d+\.\d+\.tgz$/.test(name))).toEqual(['npm-12.0.2.tgz'])

    const provenance = readFileSync('vendor/npm-12.0.2.md', 'utf8')
    expect(provenance).toContain('https://registry.npmjs.org/npm/-/npm-12.0.2.tgz')
    expect(provenance).toContain(PINNED_NPM_INTEGRITY)
    expect(provenance).toContain('Artistic-2.0')
    expect(provenance).toContain('unmodified')
    expect(provenance).toMatch(/before\s+invoking npm's installer/)

    const security = readFileSync('docs/security.md', 'utf8')
    expect(security).toContain("Before invoking npm's installer")
    expect(security).not.toContain('Before invoking npm,')
    expect(security).not.toContain('lifecycle scripts, extensions')
  })
})

describe('release publication scripts', () => {
  test('deletes stale draft assets before publishing a resumed release', () => {
    const assets = ['OMP-Desktop-0.1.9-arm64.dmg', 'OMP-Desktop-0.2.0-arm64.dmg', 'SHA256SUMS.txt']
    const expected = ['OMP-Desktop-0.2.0-arm64.dmg', 'SHA256SUMS.txt']
    expect(staleDraftReleaseAssets(assets, expected)).toEqual(['OMP-Desktop-0.1.9-arm64.dmg'])
    expect(staleDraftReleaseAssets(expected, expected)).toEqual([])
    expect(() => staleDraftReleaseAssets(assets, [])).toThrow(/expected release asset set is empty/)
    expect(parseDraftAssetNames(JSON.stringify({ assets: [{ name: 'a.dmg' }, { name: 'b.zip' }] }))).toEqual(['a.dmg', 'b.zip'])
    expect(() => parseDraftAssetNames(JSON.stringify({ assets: [{ label: 'a.dmg' }] }))).toThrow(/without a name/)
    expect(() => parseDraftAssetNames(JSON.stringify({}))).toThrow(/not an array/)
  })

  test('requires the release tag to match package.json and package-lock.json', () => {
    expect(assertReleaseTag('v0.2.0', '0.2.0', '0.2.0')).toEqual({ tag: 'v0.2.0', version: '0.2.0' })
    expect(() => assertReleaseTag('0.2.0', '0.2.0', '0.2.0')).toThrow(/must exactly match/)
    expect(() => assertReleaseTag('v0.2.1', '0.2.0', '0.2.0')).toThrow(/v0\.2\.0/)
    expect(() => assertReleaseTag('v0.2.0', '0.2.0', '0.1.9')).toThrow(/does not match/)
    expect(() => assertReleaseTag('v0.2.0', '0.2.0', '0.2.0', '0.1.9')).toThrow(/root package version/)
    expect(() => assertReleaseTag('v01.2.3', '01.2.3', '01.2.3')).toThrow(/not a supported semantic version/)
  })

  test('validates the checked-in tag through the CLI entry point', () => {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
    const accepted = spawnSync(process.execPath, ['scripts/release/validate-release-tag.mjs', '--tag', `v${version}`], { encoding: 'utf8' })
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stdout).toContain(`Validated release tag v${version}`)
    const rejected = spawnSync(process.execPath, ['scripts/release/validate-release-tag.mjs', '--tag', 'v0.0.0'], { encoding: 'utf8' })
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('Release tag validation failed')
  })
})

describe('Rust update feed', () => {
  const signatureBox = 'untrusted comment: signature from cargo-packager secret key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\ntrusted comment: timestamp:1\tfile:fixture\nAAAA\n'
  const signature = Buffer.from(signatureBox).toString('base64')

  type ManifestEntry = { platform: string; artifact: string; signature?: string; format: string }

  function createFeedDirectory() {
    return mkdtempSync(join(tmpdir(), 'omp-desktop-rust-update-feed-'))
  }

  function writeManifest(directory: string, platforms: unknown) {
    const manifestPath = join(directory, 'updates-manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ platforms }))
    return manifestPath
  }

  function writeSignedArtifact(directory: string, entry: ManifestEntry) {
    writeFileSync(join(directory, entry.artifact), `artifact ${entry.platform}`)
    writeFileSync(join(directory, entry.signature ?? `${entry.artifact}.sig`), signature)
    return { ...entry, signature: entry.signature ?? `${entry.artifact}.sig` }
  }

  function readFeed(directory: string, platforms: ManifestEntry[], options: { version?: string; baseUrl?: string; outputPath?: string } = {}) {
    const entries = platforms.map((entry) => writeSignedArtifact(directory, entry))
    const manifestPath = writeManifest(directory, entries)
    const outputPath = options.outputPath ?? join(directory, 'out', 'updates.json')
    const result = prepareRustUpdateFeed({
      version: options.version ?? '0.1.0',
      baseUrl: options.baseUrl ?? 'https://github.com/SenCha930511/omp-desktop/releases/download/v0.1.0',
      manifestPath,
      outputPath,
    })
    return { result, outputPath, manifestPath }
  }

  test('writes a cargo-packager-updater 0.2.3 feed with sorted platform keys and a trailing newline', () => {
    const directory = createFeedDirectory()
    try {
      const { result, outputPath } = readFeed(directory, [
        { platform: 'macos-aarch64', artifact: 'OMP Desktop_0.1.0_aarch64.app.tar.gz', format: 'app' },
        { platform: 'linux-x86_64', artifact: 'omp-desktop_0.1.0_amd64.AppImage', format: 'appimage' },
      ])
      expect(result.written).toBe(true)
      const source = readFileSync(outputPath, 'utf8')
      expect(source.endsWith('\n')).toBe(true)
      expect(source).toBe(
        `${JSON.stringify(
          {
            version: '0.1.0',
            platforms: {
              'linux-x86_64': {
                url: 'https://github.com/SenCha930511/omp-desktop/releases/download/v0.1.0/omp-desktop_0.1.0_amd64.AppImage',
                signature,
                format: 'appimage',
              },
              'macos-aarch64': {
                url: 'https://github.com/SenCha930511/omp-desktop/releases/download/v0.1.0/OMP%20Desktop_0.1.0_aarch64.app.tar.gz',
                signature,
                format: 'app',
              },
            },
          },
          null,
          2,
        )}\n`,
      )
      expect(Object.keys(JSON.parse(source).platforms)).toEqual(['linux-x86_64', 'macos-aarch64'])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('serializes identically regardless of manifest order and check mode writes nothing', () => {
    const directory = createFeedDirectory()
    try {
      const entries: ManifestEntry[] = [
        { platform: 'windows-x86_64', artifact: 'omp-desktop_0.1.0_x64-setup.exe', format: 'nsis' },
        { platform: 'macos-x86_64', artifact: 'OMP Desktop_0.1.0_x64.app.tar.gz', format: 'app' },
        { platform: 'linux-aarch64', artifact: 'omp-desktop_0.1.0_aarch64.AppImage', format: 'appimage' },
      ]
      const signed = entries.map((entry) => writeSignedArtifact(directory, entry))
      const forwardManifest = writeManifest(directory, signed)
      const reverseManifest = writeManifest(directory, [...signed].reverse())
      const forward = buildUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestSource: readFileSync(forwardManifest, 'utf8'), manifestPath: forwardManifest })
      const reverse = buildUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestSource: readFileSync(reverseManifest, 'utf8'), manifestPath: reverseManifest })
      expect(serializeUpdateFeed(forward)).toBe(serializeUpdateFeed(reverse))
      expect(Object.keys(forward.platforms)).toEqual(['linux-aarch64', 'macos-x86_64', 'windows-x86_64'])

      const outputPath = join(directory, 'check', 'updates.json')
      const checked = prepareRustUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestPath: forwardManifest, outputPath, check: true })
      expect(checked.written).toBe(false)
      expect(checked.contents).toBe(serializeUpdateFeed(forward))
      expect(existsSync(outputPath)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('runs --check from the command line without writing and fails closed on an http base URL', () => {
    const directory = createFeedDirectory()
    try {
      const entry = writeSignedArtifact(directory, { platform: 'linux-x86_64', artifact: 'omp-desktop.AppImage', format: 'appimage' })
      const manifestPath = writeManifest(directory, [entry])
      const outputPath = join(directory, 'cli', 'updates.json')
      const scriptPath = fileURLToPath(new URL('../scripts/release/prepare-rust-update-feed.mjs', import.meta.url))
      const args = ['--version', '0.1.0', '--base-url', 'https://example.com/releases/', '--manifest', manifestPath, '--output', outputPath]
      const checked = spawnSync(process.execPath, [scriptPath, ...args, '--check'], { encoding: 'utf8' })
      expect(checked.status).toBe(0)
      expect(checked.stdout).toContain('Validated 1 platform(s) for 0.1.0; no file written.')
      expect(existsSync(outputPath)).toBe(false)

      const written = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
      expect(written.status).toBe(0)
      expect(JSON.parse(readFileSync(outputPath, 'utf8')).platforms['linux-x86_64'].format).toBe('appimage')

      const rejected = spawnSync(process.execPath, [scriptPath, '--version', '0.1.0', '--base-url', 'http://example.com/releases/', '--manifest', manifestPath, '--output', outputPath], {
        encoding: 'utf8',
      })
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain('Update base URL must use https')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('accepts canonical and v-prefixed semver but rejects everything else', () => {
    expect(validateUpdateVersion('0.1.0')).toBe('0.1.0')
    expect(validateUpdateVersion('v1.2.3-beta.1')).toBe('1.2.3-beta.1')
    expect(() => validateUpdateVersion('')).toThrow(/required/)
    for (const version of ['0.1', 'v', '01.0.0', '1.0.0.0', '1.0.0-', 'latest']) {
      expect(() => validateUpdateVersion(version)).toThrow(/semver/)
    }
  })

  test('requires an https base URL without credentials, query, or fragment and normalizes the trailing slash', () => {
    expect(validateUpdateBaseUrl('https://github.com/SenCha930511/omp-desktop/releases/download/v0.1.0').href).toBe('https://github.com/SenCha930511/omp-desktop/releases/download/v0.1.0/')
    expect(() => validateUpdateBaseUrl('http://example.com/releases/')).toThrow(/https/)
    expect(() => validateUpdateBaseUrl('https://user:password@example.com/releases/')).toThrow(/credentials/)
    expect(() => validateUpdateBaseUrl('https://example.com/releases/?token=1')).toThrow(/query/)
    expect(() => validateUpdateBaseUrl('https://example.com/releases/#feed')).toThrow(/fragment/)
    expect(() => validateUpdateBaseUrl('not a url')).toThrow(/valid URL/)
  })

  test('rejects malformed manifests, missing platform lists, duplicates, and unknown platforms or formats', () => {
    const directory = createFeedDirectory()
    try {
      const manifestPath = writeManifest(directory, [])
      const build = (platforms: unknown) => {
        const path = writeManifest(directory, platforms)
        return buildUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestSource: readFileSync(path, 'utf8'), manifestPath: path })
      }
      expect(() => build([])).toThrow(/at least one platform/)
      expect(() => buildUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestSource: '[]', manifestPath })).toThrow(/JSON object/)
      expect(() => buildUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestSource: '{', manifestPath })).toThrow(/Cannot parse update manifest/)
      const artifact = writeSignedArtifact(directory, { platform: 'linux-x86_64', artifact: 'omp-desktop.AppImage', format: 'appimage' })
      expect(() => build([artifact, artifact])).toThrow(/duplicate platform: linux-x86_64/)
      expect(() => build([{ ...artifact, platform: 'darwin-x86_64' }])).toThrow(/unsupported platform: darwin-x86_64/)
      expect(() => build([{ ...artifact, format: 'dmg' }])).toThrow(/unsupported format: dmg/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('fails closed on missing artifacts, missing signatures, empty signatures, and non-cargo-packager signatures', () => {
    const directory = createFeedDirectory()
    try {
      const entry: ManifestEntry = { platform: 'linux-x86_64', artifact: 'omp-desktop.AppImage', signature: 'omp-desktop.AppImage.sig', format: 'appimage' }
      const manifestPath = writeManifest(directory, [entry])
      const build = () => buildUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestSource: readFileSync(manifestPath, 'utf8'), manifestPath })
      expect(build).toThrow(/artifact does not exist as a file/)
      writeFileSync(join(directory, entry.artifact), 'artifact')
      expect(build).toThrow(/signature does not exist as a file/)
      const unsignedManifestPath = join(directory, 'unsigned-manifest.json')
      writeFileSync(unsignedManifestPath, JSON.stringify({ platforms: [{ platform: entry.platform, artifact: entry.artifact, format: entry.format }] }))
      expect(() =>
        buildUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestSource: readFileSync(unsignedManifestPath, 'utf8'), manifestPath: unsignedManifestPath }),
      ).toThrow(/signature must name a single-line file path/)
      writeFileSync(join(directory, entry.signature!), '   \n')
      expect(build).toThrow(/signature is empty/)
      writeFileSync(join(directory, entry.signature!), signatureBox)
      expect(build).toThrow(/base64 signature box/)
      writeFileSync(join(directory, entry.signature!), Buffer.from('not a minisign box').toString('base64'))
      expect(build).toThrow(/does not decode to a minisign signature box/)
      expect(() =>
        prepareRustUpdateFeed({ version: '0.1.0', baseUrl: 'https://example.com/releases/', manifestPath: join(directory, 'missing.json'), outputPath: join(directory, 'updates.json') }),
      ).toThrow(/manifest is missing or unreadable/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('builds the feed from downloaded per-platform artifact directories', () => {
    const directory = createFeedDirectory()
    try {
      const artifacts = join(directory, 'artifacts')
      const published = [
        { platform: 'macos-aarch64', artifact: 'OMP Desktop_2.0.0_aarch64.app.tar.gz', format: 'app' },
        { platform: 'linux-x86_64', artifact: 'omp-desktop_2.0.0_amd64.AppImage', format: 'appimage' },
        { platform: 'windows-x86_64', artifact: 'omp-desktop_2.0.0_x64-setup.exe', format: 'nsis' },
      ]
      for (const entry of published) {
        const platformDirectory = join(artifacts, entry.platform)
        mkdirSync(platformDirectory, { recursive: true })
        // cargo-packager leaves the raw `.app` directory beside the signed
        // archive; discovery must read only the signed file.
        mkdirSync(join(platformDirectory, 'OMP Desktop.app'))
        writeFileSync(join(platformDirectory, entry.artifact), `artifact ${entry.platform}`)
        writeFileSync(join(platformDirectory, `${entry.artifact}.sig`), signature)
      }
      const outputPath = join(directory, 'out', 'updates.json')
      const result = prepareRustUpdateFeed({
        version: 'v2.0.0',
        baseUrl: 'https://github.com/SenCha930511/omp-desktop/releases/download/v2.0.0',
        artifactsPath: artifacts,
        outputPath,
      })
      expect(result.feed).toEqual({
        version: '2.0.0',
        platforms: {
          'linux-x86_64': {
            url: 'https://github.com/SenCha930511/omp-desktop/releases/download/v2.0.0/omp-desktop_2.0.0_amd64.AppImage',
            signature,
            format: 'appimage',
          },
          'macos-aarch64': {
            url: 'https://github.com/SenCha930511/omp-desktop/releases/download/v2.0.0/OMP%20Desktop_2.0.0_aarch64.app.tar.gz',
            signature,
            format: 'app',
          },
          'windows-x86_64': {
            url: 'https://github.com/SenCha930511/omp-desktop/releases/download/v2.0.0/omp-desktop_2.0.0_x64-setup.exe',
            signature,
            format: 'nsis',
          },
        },
      })
      expect(readFileSync(outputPath, 'utf8')).toBe(serializeUpdateFeed(result.feed))
      // The discovered manifest stays in memory; it is never written beside the
      // artifacts that get published.
      expect(existsSync(join(artifacts, 'artifacts-manifest.json'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('fails closed on incomplete artifact directories and runs --artifacts from the command line', () => {
    const directory = createFeedDirectory()
    try {
      const build = (artifactsPath: string) => prepareRustUpdateFeed({ version: '2.0.0', baseUrl: 'https://example.com/releases/', artifactsPath, outputPath: join(directory, 'out', 'updates.json') })
      expect(() => build(join(directory, 'missing'))).toThrow(/artifacts directory is missing or unreadable/)
      expect(() => prepareRustUpdateFeed({ version: '2.0.0', baseUrl: 'https://example.com/releases/', outputPath: join(directory, 'out', 'updates.json') })).toThrow(
        /either an update manifest or an artifacts directory/,
      )
      expect(() =>
        prepareRustUpdateFeed({
          version: '2.0.0',
          baseUrl: 'https://example.com/releases/',
          manifestPath: join(directory, 'manifest.json'),
          artifactsPath: join(directory, 'artifacts'),
        }),
      ).toThrow(/either an update manifest or an artifacts directory/)

      mkdirSync(join(directory, 'empty'))
      expect(() => build(join(directory, 'empty'))).toThrow(/no <os>-<arch> platform directories/)
      mkdirSync(join(directory, 'unsupported', 'darwin-x86_64'), { recursive: true })
      expect(() => build(join(directory, 'unsupported'))).toThrow(/unsupported platform name: darwin-x86_64/)
      for (const [name, artifact] of [
        ['ambiguous', 'one.AppImage'],
        ['ambiguous', 'two.AppImage'],
      ] as const) {
        mkdirSync(join(directory, name, 'linux-x86_64'), { recursive: true })
        writeFileSync(join(directory, name, 'linux-x86_64', artifact), 'artifact')
        writeFileSync(join(directory, name, 'linux-x86_64', `${artifact}.sig`), signature)
      }
      expect(() => build(join(directory, 'ambiguous'))).toThrow(/exactly one supported artifact \(found 2\)/)
      mkdirSync(join(directory, 'unsigned', 'linux-x86_64'), { recursive: true })
      writeFileSync(join(directory, 'unsigned', 'linux-x86_64', 'omp-desktop.AppImage'), 'artifact')
      expect(() => build(join(directory, 'unsigned'))).toThrow(/missing its omp-desktop\.AppImage\.sig signature file/)

      const artifacts = join(directory, 'valid')
      mkdirSync(join(artifacts, 'linux-x86_64'), { recursive: true })
      writeFileSync(join(artifacts, 'linux-x86_64', 'omp-desktop.AppImage'), 'artifact')
      writeFileSync(join(artifacts, 'linux-x86_64', 'omp-desktop.AppImage.sig'), signature)
      const scriptPath = fileURLToPath(new URL('../scripts/release/prepare-rust-update-feed.mjs', import.meta.url))
      const outputPath = join(directory, 'cli', 'updates.json')
      const written = spawnSync(process.execPath, [scriptPath, '--version', '2.0.0', '--base-url', 'https://example.com/releases/', '--artifacts', artifacts, '--output', outputPath], {
        encoding: 'utf8',
      })
      expect(written.status).toBe(0)
      expect(written.stdout).toContain('Wrote 1 platform(s) for 2.0.0')
      expect(JSON.parse(readFileSync(outputPath, 'utf8')).platforms['linux-x86_64'].format).toBe('appimage')

      const both = spawnSync(
        process.execPath,
        [scriptPath, '--version', '2.0.0', '--base-url', 'https://example.com/releases/', '--manifest', join(directory, 'manifest.json'), '--artifacts', artifacts],
        { encoding: 'utf8' },
      )
      expect(both.status).toBe(1)
      expect(both.stderr).toContain('Provide only one of --manifest and --artifacts')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('reads the feed version from the Rust workspace manifest instead of the release tag', () => {
    const directory = createFeedDirectory()
    try {
      expect(readRustPackageVersion('rust/Cargo.toml')).toBe('2.0.0')
      const manifestPath = join(directory, 'workspace.toml')
      writeFileSync(manifestPath, '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "3.1.4"\nedition = "2024"\n')
      expect(readRustPackageVersion(manifestPath)).toBe('3.1.4')
      writeFileSync(manifestPath, '[workspace]\nmembers = []\n')
      expect(() => readRustPackageVersion(manifestPath)).toThrow(/no \[workspace.package\] version/)
      expect(() => readRustPackageVersion(join(directory, 'missing.toml'))).toThrow(/missing or unreadable/)

      const artifacts = join(directory, 'artifacts')
      mkdirSync(join(artifacts, 'windows-x86_64'), { recursive: true })
      writeFileSync(join(artifacts, 'windows-x86_64', 'omp-desktop_3.1.4_x64-setup.exe'), 'artifact')
      writeFileSync(join(artifacts, 'windows-x86_64', 'omp-desktop_3.1.4_x64-setup.exe.sig'), signature)
      writeFileSync(manifestPath, '[workspace.package]\nversion = "3.1.4"\n')
      const scriptPath = fileURLToPath(new URL('../scripts/release/prepare-rust-update-feed.mjs', import.meta.url))
      const outputPath = join(directory, 'cli', 'updates.json')
      const written = spawnSync(process.execPath, [scriptPath, '--version-file', manifestPath, '--base-url', 'https://example.com/releases/', '--artifacts', artifacts, '--output', outputPath], {
        encoding: 'utf8',
      })
      expect(written.status).toBe(0)
      const feed = JSON.parse(readFileSync(outputPath, 'utf8'))
      expect(feed.version).toBe('3.1.4')
      expect(feed.platforms['windows-x86_64'].url).toBe('https://example.com/releases/omp-desktop_3.1.4_x64-setup.exe')

      const both = spawnSync(process.execPath, [scriptPath, '--version', '3.1.4', '--version-file', manifestPath, '--base-url', 'https://example.com/releases/', '--artifacts', artifacts], {
        encoding: 'utf8',
      })
      expect(both.status).toBe(1)
      expect(both.stderr).toContain('Provide only one of --version and --version-file')
      const neither = spawnSync(process.execPath, [scriptPath, '--base-url', 'https://example.com/releases/', '--artifacts', artifacts], { encoding: 'utf8' })
      expect(neither.status).toBe(1)
      expect(neither.stderr).toContain('Provide --version or --version-file')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
