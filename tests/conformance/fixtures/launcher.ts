import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'omp-fixture.mjs')

function findCscExecutable(): string {
  const winDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidates = [join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'csc.exe'
}

function escapeCSharpString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function ensureWindowsLauncherBinary(): string {
  const hash = createHash('sha256').update(process.execPath).update('\0').update(FIXTURE_SCRIPT).digest('hex').slice(0, 16)
  const cacheDir = join(tmpdir(), 'omp-conformance-win-launcher')
  const cachedExe = join(cacheDir, `omp-fixture-${hash}.exe`)
  if (existsSync(cachedExe)) return cachedExe

  mkdirSync(cacheDir, { recursive: true })
  const sourcePath = join(cacheDir, `omp-fixture-${hash}.cs`)
  const source = `using System;
using System.Diagnostics;
using System.Text;

class OmpFixtureLauncher {
  static string QuoteArg(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\\t', '\\n', '\\v', '"' }) == -1) {
      return arg;
    }
    var sb = new StringBuilder();
    sb.Append('"');
    for (int i = 0; i < arg.Length; i++) {
      int backslashes = 0;
      while (i < arg.Length && arg[i] == '\\\\') {
        backslashes++;
        i++;
      }
      if (i == arg.Length) {
        sb.Append('\\\\', backslashes * 2);
        break;
      }
      if (arg[i] == '"') {
        sb.Append('\\\\', backslashes * 2 + 1);
        sb.Append('"');
      } else {
        sb.Append('\\\\', backslashes);
        sb.Append(arg[i]);
      }
    }
    sb.Append('"');
    return sb.ToString();
  }

  static int Main(string[] args) {
    var psi = new ProcessStartInfo();
    psi.FileName = "${escapeCSharpString(process.execPath)}";
    var sb = new StringBuilder();
    sb.Append(QuoteArg("${escapeCSharpString(FIXTURE_SCRIPT)}"));
    foreach (var arg in args) {
      sb.Append(' ');
      sb.Append(QuoteArg(arg));
    }
    psi.Arguments = sb.ToString();
    psi.UseShellExecute = false;
    var proc = Process.Start(psi);
    proc.WaitForExit();
    return proc.ExitCode;
  }
}
`
  writeFileSync(sourcePath, source, 'utf8')
  const csc = findCscExecutable()
  const tempOut = `${cachedExe}.${process.pid}.tmp.exe`
  try {
    const compiled = spawnSync(csc, ['/nologo', '/optimize+', `/out:${tempOut}`, sourcePath], { encoding: 'utf8' })
    if (compiled.status !== 0) {
      throw new Error(`Failed to compile Windows omp-fixture launcher with ${csc}: ${compiled.stdout}\n${compiled.stderr}`)
    }
    copyFileSync(tempOut, cachedExe)
  } finally {
    try {
      rmSync(sourcePath, { force: true })
    } catch {}
    try {
      rmSync(tempOut, { force: true })
    } catch {}
  }
  return cachedExe
}

/**
 * Creates a standalone native-spawnable `omp-fixture` executable inside `dir`
 * that delegates to `omp-fixture.mjs` without needing `shell: true`.
 */
export function createOmpFixtureExecutable(dir: string): string {
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const exePath = join(dir, 'omp-fixture.exe')
    const launcher = ensureWindowsLauncherBinary()
    copyFileSync(launcher, exePath)
    return exePath
  }
  const scriptPath = join(dir, 'omp-fixture')
  writeFileSync(scriptPath, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_SCRIPT}" "$@"\n`, 'utf8')
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

/** Pads a `{"type":"title",...}` line to exactly 255 bytes so the slot spans 256 bytes with its trailing `\n`. */
export function ompTitleSlot(title: string, updatedAt: string): string {
  const unpadded = JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: '' })
  const paddingLength = 255 - Buffer.byteLength(unpadded, 'utf8')
  if (paddingLength < 0) throw new Error('Title exceeds 255-byte slot budget')
  return JSON.stringify({ type: 'title', v: 1, title, updatedAt, pad: ' '.repeat(paddingLength) })
}

export interface WriteOmpSessionFixtureOptions {
  homeDir: string
  bucket: string
  fileName: string
  title: string
  updatedAt: string
  entries: ReadonlyArray<Record<string, unknown>>
}

/** Writes a valid OMP v3 JSONL session file under `<homeDir>/.omp/agent/sessions/<bucket>/<fileName>`. */
export function writeOmpSessionFixture(options: WriteOmpSessionFixtureOptions): string {
  const dir = join(options.homeDir, '.omp', 'agent', 'sessions', options.bucket)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, options.fileName)
  const lines = [ompTitleSlot(options.title, options.updatedAt), ...options.entries.map((entry) => JSON.stringify(entry)), '']
  writeFileSync(filePath, lines.join('\n'), 'utf8')
  return filePath
}
