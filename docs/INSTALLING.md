# Installing CytoWeave

CytoWeave is one executable. The browser application and the example
experiments are inside it, so nothing else needs to be installed.

## Release files

| Operating system | Architecture | Release file |
| --- | --- | --- |
| macOS | Apple silicon (ARM64) | `cytoweave-darwin-arm64` |
| macOS | Intel (x64) | `cytoweave-darwin-amd64` |
| Linux | x64 | `cytoweave-linux-amd64` |
| Linux | ARM64 | `cytoweave-linux-arm64` |
| Windows | x64 | `cytoweave-windows-amd64.exe` |
| Windows | ARM64 | `cytoweave-windows-arm64.exe` |

Each release also has `SHA256SUMS`, the SHA-256 checksum of every file. The
installers need it.

## macOS and Linux

Install the latest release as `$HOME/.local/bin/cytoweave`:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.sh | sh
```

The installer detects the operating system and CPU and downloads the matching
file and `SHA256SUMS` from the same release. It requires exactly one matching
checksum and runs the downloaded program's `--version`, and only then moves it
into place, so a failed download never replaces a working copy. It does not use
`sudo`, change `PATH` or start CytoWeave. If `$HOME/.local/bin` is not on
your `PATH`, it prints the full path to run.

To read the installer before running it:

```sh
curl --proto '=https' --tlsv1.2 -fsSLo install-cytoweave.sh \
  https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.sh
less install-cytoweave.sh
sh install-cytoweave.sh
```

To install a particular release, give its tag (the
[releases page](https://github.com/robert-mcdermott/cytoweave/releases)
lists them):

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.sh |
  CYTOWEAVE_VERSION=v0.8.1 sh
```

To install somewhere else, use a directory you can write to:

```sh
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.sh |
  CYTOWEAVE_INSTALL_DIR="$HOME/bin" sh
```

A downloaded installer takes the same settings as options:

```sh
sh install-cytoweave.sh --version v0.8.1 --install-dir "$HOME/bin"
```

`CYTOWEAVE_REPOSITORY=owner/repository` installs from a fork. For a
system-wide installation, download and read the script, then run it with an
administrator-owned `--install-dir`. Never pipe a download straight into
`sudo sh`.

## Windows

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.ps1 | iex
```

The program is installed as
`$env:LOCALAPPDATA\Programs\CytoWeave\cytoweave.exe`, and that folder is
added to your user `PATH`. Terminals that are already open keep their old
`PATH`, so open a new one before running `cytoweave`. The installer detects
x64 or ARM64, downloads the program and `SHA256SUMS`, requires exactly one
matching checksum, runs the downloaded program's version check, and replaces
an existing copy only after every check passes. It does not need administrator
rights. Windows cannot replace a program that is running, so stop CytoWeave
before upgrading.

### Execution policy

`irm … | iex` is not affected by the PowerShell execution policy, which
governs script *files*: this form reads the script into memory and runs it, so
it works under `Restricted`, `AllSigned` and `RemoteSigned` alike. There is no
need for `Set-ExecutionPolicy` or `Unblock-File`.

The policy does apply to a saved copy of the installer. Bypass it for that one
run instead of changing the setting:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-cytoweave.ps1
```

### Options

Piping into `iex` cannot pass parameters. Set environment variables, which the
piped form reads:

```powershell
$env:CYTOWEAVE_VERSION = 'v0.8.1'
$env:CYTOWEAVE_INSTALL_DIR = "$HOME\bin"
irm https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.ps1 | iex
```

or build a script block, which accepts parameters:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.ps1))) `
  -Version v0.8.1 -InstallDir "$HOME\bin"
```

| Parameter | Environment variable | Purpose |
| --- | --- | --- |
| `-Version` | `CYTOWEAVE_VERSION` | Release tag to install. Defaults to the latest release. |
| `-InstallDir` | `CYTOWEAVE_INSTALL_DIR` | Absolute installation folder. |
| `-Repository` | `CYTOWEAVE_REPOSITORY` | GitHub `owner/repository`, for forks. |
| `-Architecture` | `CYTOWEAVE_ARCH` | `amd64` or `arm64`, when detection fails. |
| `-NoPathUpdate` | `CYTOWEAVE_NO_PATH_UPDATE` | Leave the user `PATH` unchanged. |

A parameter takes precedence over its environment variable.

### Reading the installer first

```powershell
$Installer = Join-Path $env:TEMP 'install-cytoweave.ps1'
Invoke-WebRequest -UseBasicParsing `
  'https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.ps1' `
  -OutFile $Installer
Get-Content $Installer
powershell -ExecutionPolicy Bypass -File $Installer
```

## Downloading and verifying by hand

On macOS or Linux, choose the file for your computer from the table above:

```sh
ASSET=cytoweave-linux-amd64
curl -fLO "https://github.com/robert-mcdermott/cytoweave/releases/latest/download/$ASSET"
curl -fLO https://github.com/robert-mcdermott/cytoweave/releases/latest/download/SHA256SUMS
grep "  $ASSET\$" SHA256SUMS | sha256sum --check -
chmod +x "$ASSET"
./"$ASSET" --version
```

On macOS, use `shasum -a 256 --check -` instead of `sha256sum --check -`.

In PowerShell:

```powershell
$Asset = 'cytoweave-windows-amd64.exe'
$Base = 'https://github.com/robert-mcdermott/cytoweave/releases/latest/download'
Invoke-WebRequest -UseBasicParsing "$Base/$Asset" -OutFile $Asset
Invoke-WebRequest -UseBasicParsing "$Base/SHA256SUMS" -OutFile SHA256SUMS
$Expected = (Select-String -Path SHA256SUMS -Pattern ('  ' + [regex]::Escape($Asset) + '$')).Line.Split(' ')[0]
$Actual = (Get-FileHash -Algorithm SHA256 $Asset).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) { throw 'Checksum verification failed' }
& ".\$Asset" --version
```

The checksum detects a damaged download and a file that differs from the
release's list. Both come from the same release, so it cannot protect against
someone able to replace both.

### Files downloaded in a browser

CytoWeave's programs are not signed with an Apple or Microsoft certificate.
The installers and the commands above download without a browser, so the
operating system does not flag the file. A file saved from a browser is
flagged, and the first start asks for confirmation.

**macOS.** A warning such as *Apple could not verify "cytoweave-darwin-arm64"
is free of malware* appears. Either open **System Settings → Privacy &
Security**, find the message about CytoWeave in the Security section and
click **Open Anyway**, or remove the flag in Terminal:

```sh
xattr -d com.apple.quarantine ./cytoweave-darwin-arm64
chmod +x ./cytoweave-darwin-arm64
```

If `xattr` says the attribute was not found, the file was not flagged.

**Windows.** If SmartScreen blocks the program, click **More info**, then
**Run anyway**. Or clear the flag before starting it: right-click the `.exe`,
choose **Properties**, check **Unblock** on the **General** tab and click
**OK**, or run `Unblock-File .\cytoweave-windows-amd64.exe` in PowerShell.

## Upgrading and going back

Running the installer again upgrades CytoWeave. A failed download, checksum
or version check leaves the installed copy as it was. The workspace library is
not touched.

To go back to an earlier release (v0.1.0 or later), install it by tag:

```sh
CYTOWEAVE_VERSION=v0.1.0 sh install-cytoweave.sh
```

```powershell
$env:CYTOWEAVE_VERSION = 'v0.1.0'
irm https://raw.githubusercontent.com/robert-mcdermott/cytoweave/main/install.ps1 | iex
```

## Uninstalling

Delete the program: `~/.local/bin/cytoweave` on macOS and Linux, or the
`%LocalAppData%\Programs\CytoWeave` folder on Windows, whose entry you can
also remove from the user `PATH` (**Settings → System → About → Advanced
system settings → Environment Variables**).

CytoWeave keeps your workspace library (saved workspaces and a copy of each FCS
file you added, stored by checksum) in `~/Library/Application Support/CytoWeave`
on macOS, `~/.config/CytoWeave` on Linux (or `$XDG_CONFIG_HOME/CytoWeave`), and
`%AppData%\CytoWeave` on Windows. `--data-dir` puts it elsewhere. Delete it only
if you no longer need those workspaces; deleted workspaces are first moved to its
`trash` folder.

## Building from source

With the Go version in `go.mod` or newer:

```sh
git clone https://github.com/robert-mcdermott/cytoweave.git
cd cytoweave
go test ./...
go build -o cytoweave .
./cytoweave --version
```

The [README](../README.md#development) describes development and releases.
