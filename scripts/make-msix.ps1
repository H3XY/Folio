# Packs dist/Folio-win32-x64 (from `npm run package`) into dist/Folio.msix for the Microsoft Store.
# The package is unsigned: the Store signs it when you submit. (To sideload it for testing you'd sign it with a
# certificate whose subject matches the Publisher below.)
#
# Identity values come from Partner Center > your app > Product identity, via environment variables:
#   FOLIO_MSIX_NAME          Package/Identity/Name           e.g. 12345YourName.Folio
#   FOLIO_MSIX_PUBLISHER     Package/Identity/Publisher      e.g. CN=ABCD1234-...
#   FOLIO_MSIX_PUBLISHER_DISPLAY  Publisher display name
# Without them, placeholder values are used (good for checking that packaging works).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'dist\Folio-win32-x64'
if (-not (Test-Path (Join-Path $src 'Folio.exe'))) { throw "Run 'npm run package' first ($src not found)." }

$pkgVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$parts = $pkgVersion.Split('.') + @('0', '0', '0')
$version = '{0}.{1}.{2}.0' -f $parts[0], $parts[1], $parts[2]   # Store requires the 4th part to be 0

$name = if ($env:FOLIO_MSIX_NAME) { $env:FOLIO_MSIX_NAME } else { 'FolioDev.Folio' }
$publisher = if ($env:FOLIO_MSIX_PUBLISHER) { $env:FOLIO_MSIX_PUBLISHER } else { 'CN=FolioDev' }
$display = if ($env:FOLIO_MSIX_PUBLISHER_DISPLAY) { $env:FOLIO_MSIX_PUBLISHER_DISPLAY } else { 'Folio' }

$stage = Join-Path $env:TEMP ('folio-msix-' + [guid]::NewGuid())
Copy-Item $src $stage -Recurse
Copy-Item (Join-Path $root 'build\appx\Assets') (Join-Path $stage 'Assets') -Recurse
(Get-Content (Join-Path $root 'build\appx\AppxManifest.xml') -Raw) `
  -replace '__IDENTITY_NAME__', $name -replace '__PUBLISHER__', $publisher `
  -replace '__PUBLISHER_DISPLAY__', $display -replace '__VERSION__', $version |
  Set-Content (Join-Path $stage 'AppxManifest.xml') -Encoding UTF8

$makeappx = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe' |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe not found; install the Windows 10/11 SDK.' }

$out = Join-Path $root 'dist\Folio.msix'
Remove-Item $out -ErrorAction SilentlyContinue
& $makeappx.FullName pack /d $stage /p $out /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
Remove-Item $stage -Recurse -Force
Write-Host "Wrote $out ($name $version, $publisher)"
