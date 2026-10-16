# Harness discovery

OMP Desktop discovers the OMP harness (`omp`) without invoking a shell or evaluating shell startup files. This keeps startup bounded and makes detection independent of whether the user prefers bash, zsh, fish, or no interactive shell at all.

## Resolution order

Each refresh checks, in order:

1. The absolute executable override saved in Harness settings.
2. The `OMP_BINARY` environment override.
3. Absolute directories in the process `PATH`/`Path` snapshot.
4. The harness-specific installer location: `%LOCALAPPDATA%\omp` on Windows (native installer) and `$PI_INSTALL_DIR` when set on POSIX.
5. Shared system and package-manager locations for npm, Bun, pnpm, mise, Volta, Homebrew, and Linuxbrew. NVM version-manager directories are bounded to 64 entries and sorted by descending version.

Candidates are deduplicated and must be executable. OMP Desktop then runs a bounded `--version` probe with no shell; only an exit-zero candidate is published to the renderer. A broken override therefore falls through to later automatic candidates, but its own missing, permission, spawn, exit, timeout, or output-limit reason is retained for the settings card. If no candidate works, the card reports the configured override's reason when present, otherwise the last probed candidate's reason. Probe stderr is control-character-stripped and byte-capped before it crosses IPC.

The relevant upstream install layouts are documented by [OMP](https://github.com/can1357/oh-my-pi), [npm](https://docs.npmjs.com/files/folders.html), [Bun](https://bun.sh/docs/installation), [pnpm](https://pnpm.io/settings/other#globalbindir), [mise](https://mise.jdx.dev/dev-tools/shims.html), and [Volta](https://docs.volta.sh/guide/getting-started).

## Windows and WSL boundaries

OMP's native Windows installer writes `%LOCALAPPDATA%\omp\omp.exe`, which is checked explicitly so Refresh works even when the running GUI still has the old `Path` snapshot.

OMP ships a native executable on every platform and does not document a Windows package-manager install, so there is no `.cmd` shim resolution machinery: discovery only accepts a real executable. A community layout outside the searched directories must be named explicitly through the override with a native executable.

A Windows app also does not treat an executable inside a WSL distribution as a native Windows path. WSL execution requires an explicit transport, distribution selection, Windows/Linux cwd conversion, and Linux-owned session roots. If OMP Desktop itself runs as a Linux application under WSLg, normal Linux discovery applies.
