import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(sourceDirectory, 'package.json'), 'utf8'));
const outputPath = path.join(sourceDirectory, `${packageJson.name}-${packageJson.version}.vsix`);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-progress-editor-'));
const extensionDirectory = path.join(temporaryDirectory, 'extension');

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
</Types>
`;

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${packageJson.name}" Version="${packageJson.version}" Publisher="${packageJson.publisher}" />
    <DisplayName>${packageJson.displayName}</DisplayName>
    <Description xml:space="preserve">${packageJson.description}</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${packageJson.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" />
  </Assets>
</PackageManifest>
`;

try {
  await mkdir(extensionDirectory);
  await Promise.all([
    copyFile(path.join(sourceDirectory, 'extension.js'), path.join(extensionDirectory, 'extension.js')),
    copyFile(path.join(sourceDirectory, 'package.json'), path.join(extensionDirectory, 'package.json')),
    copyFile(path.join(sourceDirectory, 'README.md'), path.join(extensionDirectory, 'README.md')),
    writeFile(path.join(temporaryDirectory, '[Content_Types].xml'), contentTypes),
    writeFile(path.join(temporaryDirectory, 'extension.vsixmanifest'), manifest),
  ]);

  await rm(outputPath, { force: true });
  execFileSync('zip', ['-X', '-q', '-r', outputPath, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], {
    cwd: temporaryDirectory,
    stdio: 'inherit',
  });
  process.stdout.write(`${outputPath}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
