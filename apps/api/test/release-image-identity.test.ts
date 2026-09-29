import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, test, expect } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const hasBash = spawnSync(bash, ['--version'], {stdio:'ignore'}).status === 0;
const windowsTest = process.platform === 'win32' ? test : test.skip;
const bashTest = hasBash ? test : test.skip;
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'ec-image-identity-'));
  const config='sha256:'+'a'.repeat(64);
  const body=JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:config,size:10},layers:[]});
  const id='sha256:'+createHash('sha256').update(body).digest('hex');
  mkdirSync(join(dir,'blobs/sha256'),{recursive:true});
  writeFileSync(join(dir,'blobs/sha256',id.slice(7)),body);
  const archive=join(dir,'ec-data-images.tar');
  const tar=spawnSync('tar',['-cf',archive,'-C',dir,'blobs'],{encoding:'utf8'});
  expect(tar.status,tar.stderr).toBe(0);
  return {dir,config,id,archive};
}
describe('Docker classic/containerd image identity compatibility',()=>{
  windowsTest('PowerShell resolves a verified archive manifest and rejects unrelated IDs/configs',()=>{
    const f=fixture();
    try {
      const launcher=resolve(root,'scripts/release-start.ps1').replaceAll("'","''");
      const script=`$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile('${launcher}',[ref]$null,[ref]$null)
foreach($name in @('Invoke-NativeCapture','Test-ArchiveManifestImageId','Get-UniqueNativeLine','Assert-LoadedImageIds')) {
 $fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)[0]
 Invoke-Expression $fn.Extent.Text
}
$ImageArchive='${f.archive.replaceAll("'","''")}'
if(-not(Test-ArchiveManifestImageId '${f.id}' '${f.config}')){throw 'valid mapping rejected'}
if(Test-ArchiveManifestImageId '${f.id}' ('sha256:'+'b'*64)){throw 'wrong config accepted'}
if(Test-ArchiveManifestImageId ('sha256:'+'c'*64) '${f.config}'){throw 'missing member accepted'}
if(Test-ArchiveManifestImageId '../invalid' '${f.config}'){throw 'unsafe digest accepted'}
# The independent verifier has its own native capture contract.
$verifyAst=[Management.Automation.Language.Parser]::ParseFile('${resolve(root,'scripts/verify-release.ps1').replaceAll("'","''")}',[ref]$null,[ref]$null)
foreach($name in @('Invoke-NativeCapture','Assert-LoadedReleaseImageIds')) {
 $fn=$verifyAst.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)[0]
 Invoke-Expression $fn.Extent.Text
}
function Get-DockerImageId {param($Image) return '${f.id}'}
$verified=[pscustomobject]@{images=@('example:latest');imageIds=[pscustomobject]@{'example:latest'='${f.config}'}}
Assert-LoadedReleaseImageIds -Manifest $verified -ImageArchivePath $ImageArchive
$verified.imageIds.'example:latest'='sha256:'+'b'*64
$rejected=$false
try {Assert-LoadedReleaseImageIds -Manifest $verified -ImageArchivePath $ImageArchive}catch{$rejected=$true}
if(-not $rejected){throw 'verifier accepted wrong config'}
# Existing classic-store path must remain usable without archive access.
$Images=@('example:latest')
function Invoke-NativeCapture {param($file,$arguments) return [pscustomobject]@{ExitCode=0;StdOut=@('${f.config}');Output=@('${f.config}')}}
$classic=Assert-LoadedImageIds @{ 'example:latest'='${f.config}' }
if($classic['example:latest'] -cne '${f.config}'){throw 'classic ID changed'}
Write-Output 'IMAGE_IDENTITY_OK'
`;
      const p=join(f.dir,'check.ps1');writeFileSync(p,script);
      const r=spawnSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',p],{encoding:'utf8'});
      expect(r.status,r.stdout+r.stderr).toBe(0);expect(r.stdout).toContain('IMAGE_IDENTITY_OK');
    } finally {rmSync(f.dir,{recursive:true,force:true});}
  },30000);
  bashTest('Bash accepts only the matching archived manifest config',()=>{
    const f=fixture();
    try {
      const source=readFileSync(resolve(root,'scripts/release-start.sh'),'utf8').replaceAll('\r\n','\n');
      const start=source.indexOf('image_id_matches_archive() {');
      const end=source.indexOf('\n}\n',start)+3;
      expect(start).toBeGreaterThan(0);
      const body=source.slice(start,end)+`\nimage_id_matches_archive '${f.id}' '${f.config}' || exit 2
if image_id_matches_archive '${f.id}' 'sha256:${'b'.repeat(64)}'; then exit 3; fi
if image_id_matches_archive 'sha256:${'c'.repeat(64)}' '${f.config}'; then exit 4; fi
if image_id_matches_archive '../invalid' '${f.config}'; then exit 5; fi
echo IMAGE_IDENTITY_OK\n`;
      const r=spawnSync(bash,['-c',body],{cwd:f.dir,encoding:'utf8'});
      expect(r.status,r.stdout+r.stderr).toBe(0);expect(r.stdout).toContain('IMAGE_IDENTITY_OK');
    } finally {rmSync(f.dir,{recursive:true,force:true});}
  },30000);
});
