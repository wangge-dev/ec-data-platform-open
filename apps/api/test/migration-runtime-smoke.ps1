param([string]$ComposeFilePath)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$composeFile = if ($ComposeFilePath) { (Resolve-Path -LiteralPath $ComposeFilePath).Path } else { Join-Path $repoRoot "deploy/docker-compose.yml" }
$migrationSqlFiles = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot "apps/api/drizzle") `
  -Filter "*.sql" -File | Sort-Object Name
)

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $port
}

function Set-IsolatedEnvironment([string]$project) {
  $env:POSTGRES_HOST_PORT = "127.0.0.1:$(Get-FreePort)"
  $env:REDIS_HOST_PORT = "127.0.0.1:$(Get-FreePort)"
  $script:ApiHostPortNumber = Get-FreePort
  $env:API_HOST_PORT = "127.0.0.1:$script:ApiHostPortNumber"
  $env:POSTGRES_CONTAINER_NAME = "$project-pg"
  $env:REDIS_CONTAINER_NAME = "$project-redis"
  $env:MIGRATE_CONTAINER_NAME = "$project-migrate"
  $env:API_CONTAINER_NAME = "$project-api"
  $env:POSTGRES_PASSWORD = [guid]::NewGuid().ToString("N")
  $env:APP_DB_PASSWORD = [guid]::NewGuid().ToString("N")
  $env:ADMIN_PASSWORD = [guid]::NewGuid().ToString("N")
  $env:JWT_SECRET = [guid]::NewGuid().ToString("N")
  $env:DEEPSEEK_API_KEY = "runtime-smoke-not-used"
}

function Remove-IsolatedProject([string]$project) {
  $failures = [Collections.Generic.List[Exception]]::new()
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $downOutput = docker compose -p $project -f $composeFile down -v --remove-orphans 2>&1
    if ($LASTEXITCODE -ne 0) {
      $failures.Add([Exception]::new("Compose cleanup failed for ${project}: $([string]::Join(' ', $downOutput))"))
    }

    foreach ($resource in @(
      @{ Name = "containers"; Arguments = @("ps", "-a", "--filter", "label=com.docker.compose.project=$project", "--format", "{{.ID}} {{.Names}}") },
      @{ Name = "networks"; Arguments = @("network", "ls", "--filter", "label=com.docker.compose.project=$project", "--format", "{{.ID}} {{.Name}}") },
      @{ Name = "volumes"; Arguments = @("volume", "ls", "--filter", "label=com.docker.compose.project=$project", "--format", "{{.Name}}") }
    )) {
      $residue = @(& docker @($resource.Arguments) 2>&1)
      if ($LASTEXITCODE -ne 0) {
        $failures.Add([Exception]::new("Could not inspect isolated $($resource.Name) for ${project}: $([string]::Join(' ', $residue))"))
      } elseif ($residue.Count -gt 0) {
        $failures.Add([Exception]::new("Isolated $($resource.Name) remain for ${project}: $([string]::Join(', ', $residue))"))
      }
    }
  } finally {
    $ErrorActionPreference = $previous
  }

  if ($failures.Count -gt 0) {
    throw [AggregateException]::new("Cleanup failed for isolated project $project", [Exception[]]$failures.ToArray())
  }
}

function Complete-IsolatedProject(
  [string]$project,
  [AllowNull()][Exception]$primaryError,
  [string[]]$temporaryFiles = @()
) {
  $failures = [Collections.Generic.List[Exception]]::new()
  if ($null -ne $primaryError) { $failures.Add($primaryError) }

  foreach ($temporaryFile in $temporaryFiles) {
    try {
      Remove-Item -LiteralPath $temporaryFile -ErrorAction Stop
    } catch [Management.Automation.ItemNotFoundException] {
      # A scenario may fail before creating its temporary file.
    } catch {
      $failures.Add($_.Exception)
    }
  }

  try {
    Remove-IsolatedProject $project
  } catch {
    $failures.Add($_.Exception)
  }

  if ($failures.Count -gt 0) {
    throw [AggregateException]::new("Isolated scenario $project failed; cleanup was attempted", [Exception[]]$failures.ToArray())
  }
}

function Wait-AppRole {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $count = docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -Atqc `
      "SELECT count(*) FROM pg_roles WHERE rolname='ec_app'" 2>$null
    if ($count -eq "1") { return }
    Start-Sleep -Seconds 1
  }
  throw "ec_app role initialization timed out"
}

function Wait-ApiHealth {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing `
        -Uri "http://127.0.0.1:$script:ApiHostPortNumber/api/health" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Seconds 1
  }
  throw "API health timed out"
}

function Initialize-LegacySchema {
  Wait-AppRole
  docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -v ON_ERROR_STOP=1 `
    -c "GRANT CREATE ON SCHEMA public TO ec_app" | Out-Null
  $migrationSql = $migrationSqlFiles[0]
  Get-Content $migrationSql.FullName -Raw | docker exec -i -e PGPASSWORD=$env:APP_DB_PASSWORD `
    $env:POSTGRES_CONTAINER_NAME psql -U ec_app -d ec_data -v ON_ERROR_STOP=1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "legacy schema setup failed while applying $($migrationSql.Name)"
  }
}

function Invoke-FreshSmoke {
  $project = "ecmig-fresh-" + (Get-Date -Format "HHmmssfff")
  Set-IsolatedEnvironment $project
  $workflowFile = Join-Path $env:TEMP "$project.ts"
  $scenarioError = $null
  try {
    docker compose -p $project -f $composeFile up -d postgres redis api | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "fresh Compose start failed" }
    Wait-ApiHealth

    $journal = docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -Atqc `
      "SELECT count(*) FROM drizzle.__drizzle_migrations"
    $wrongOwner = docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -Atqc `
      "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner <> 'ec'"
    $identity = docker exec -e PGPASSWORD=$env:APP_DB_PASSWORD $env:POSTGRES_CONTAINER_NAME `
      psql -U ec_app -d ec_data -Atqc `
      "SELECT rolsuper || '|' || array_to_string(current_schemas(false), ',') FROM pg_roles WHERE rolname=current_user"
    $schema = docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -Atqc `
      "SELECT pg_get_userbyid(nspowner) || '|' || has_schema_privilege('ec_app','user_data','USAGE') || '|' || has_schema_privilege('ec_app','user_data','CREATE') || '|' || has_schema_privilege('ec_app','public','CREATE') FROM pg_namespace WHERE nspname='user_data'"
    if ($journal -ne "$($migrationSqlFiles.Count)" -or $wrongOwner -ne "0" -or $identity -ne "false|public,user_data" -or $schema -ne "ec|true|true|false") {
      throw "fresh ownership/privilege assertion failed: journal=$journal wrongOwner=$wrongOwner identity=$identity schema=$schema"
    }

    docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -v ON_ERROR_STOP=1 -c `
      "CREATE TABLE public.legacy_runtime(marker text); INSERT INTO public.legacy_runtime VALUES ('public'); GRANT SELECT ON public.legacy_runtime TO ec_app" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "legacy public dynamic fixture setup failed" }

    docker exec -e PGPASSWORD=$env:APP_DB_PASSWORD $env:POSTGRES_CONTAINER_NAME `
      psql -v ON_ERROR_STOP=1 -U ec_app -d ec_data -c `
      "BEGIN; INSERT INTO public.users(username,password_hash,is_admin) VALUES ('runtime_crud','x',false); UPDATE public.users SET display_name='ok' WHERE username='runtime_crud'; DELETE FROM public.users WHERE username='runtime_crud'; ROLLBACK; INSERT INTO public.settings(key,value) VALUES ('runtime_schema','public'),('scan_folder','public-folder') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value; INSERT INTO public.alerts(module_code,rule_key,rule_label,severity,message,detail,status) VALUES ('public-module','public-rule','public-alert','warning','public-alert','{}'::jsonb,'open'); CREATE TABLE user_data.runtime_dynamic(id bigserial primary key); ALTER TABLE user_data.runtime_dynamic ADD COLUMN note text; DROP TABLE user_data.runtime_dynamic; CREATE TABLE user_data.runtime_visible(marker text); INSERT INTO user_data.runtime_visible VALUES ('user_data'); CREATE TABLE user_data.legacy_runtime(marker text); INSERT INTO user_data.legacy_runtime VALUES ('user_data'); CREATE TABLE user_data.users(username text primary key, marker text); INSERT INTO user_data.users VALUES ('admin','shadow'); CREATE TABLE user_data.unified_sales(marker text); INSERT INTO user_data.unified_sales VALUES ('shadow'); CREATE TABLE user_data.settings(key text primary key, value text); INSERT INTO user_data.settings VALUES ('runtime_schema','shadow'); CREATE TABLE user_data.alerts (LIKE public.alerts INCLUDING ALL); INSERT INTO user_data.alerts(module_code,rule_key,rule_label,severity,message,detail,status) VALUES ('shadow-module','shadow-rule','shadow-alert','critical','shadow-alert','{}'::jsonb,'open')" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "ec_app CRUD or user_data DDL failed" }

    docker exec -w /app/apps/api -e ADMIN_PASSWORD=$env:ADMIN_PASSWORD $env:API_CONTAINER_NAME `
      ./node_modules/.bin/tsx scripts/seed.ts | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "admin seed failed with user_data shadow tables" }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    docker exec -e PGPASSWORD=$env:APP_DB_PASSWORD $env:POSTGRES_CONTAINER_NAME `
      psql -v ON_ERROR_STOP=1 -U ec_app -d ec_data -c "CREATE TABLE public.forbidden_runtime(id int)" 2>$null | Out-Null
    $createExit = $LASTEXITCODE
    docker exec -e PGPASSWORD=$env:APP_DB_PASSWORD $env:POSTGRES_CONTAINER_NAME `
      psql -v ON_ERROR_STOP=1 -U ec_app -d ec_data -c "ALTER TABLE public.users ADD COLUMN forbidden_runtime int" 2>$null | Out-Null
    $alterExit = $LASTEXITCODE
    docker exec -e PGPASSWORD=$env:APP_DB_PASSWORD $env:POSTGRES_CONTAINER_NAME `
      psql -v ON_ERROR_STOP=1 -U ec_app -d ec_data -c "DROP TABLE public.users" 2>$null | Out-Null
    $dropExit = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($createExit -eq 0 -or $alterExit -eq 0 -or $dropExit -eq 0) {
      throw "ec_app unexpectedly changed public DDL"
    }

    $workflow = @'
import { importExcel } from "./src/services/import-excel.ts";
import { runDefaultTransform } from "./src/modules/default-transform.ts";
import { db, sql } from "./src/db/client.ts";
import { settings, users } from "./src/db/schema.ts";
import { eq } from "drizzle-orm";
(async () => {
  const imported = await importExcel(Buffer.from("value,qty,note\nalpha,2,ok\n"), "runtime.csv", "runtime");
  const module: any = {
    code: "runtime_smoke", name: "Runtime", description: "runtime",
    columns: [{ name: "value", source: "value", type: "text", required: true, computed: false }],
    platforms: [{ code: "runtime", name: "Runtime", filePattern: ".*", patternFlags: "i", enabled: true }],
    usages: [], enabled: true, hasTransform: false
  };
  await runDefaultTransform({ module, platform: "runtime", rawFileName: "runtime.csv", extra: { sourceId: imported.sourceId } } as any);
  const [admin] = await db.select({ username: users.username, isAdmin: users.isAdmin }).from(users).where(eq(users.username, "admin"));
  const [setting] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, "runtime_schema"));
  const [result] = await sql`SELECT
    (SELECT table_schema FROM information_schema.tables WHERE table_name=${imported.tableName}) AS upload_schema,
    (SELECT table_schema FROM information_schema.tables WHERE table_name='unified_runtime_smoke') AS transform_schema,
    (SELECT count(*)::int FROM unified_runtime_smoke WHERE "_source_id"=${imported.sourceId}) AS rows,
    (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='users'::regclass) AS users_ref_schema,
    (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='unified_sales'::regclass) AS sales_ref_schema,
    (SELECT marker FROM runtime_visible LIMIT 1) AS runtime_visible,
    (SELECT marker FROM legacy_runtime LIMIT 1) AS legacy_runtime,
    (SELECT count(*)::int FROM user_data.users) AS shadow_users,
    (SELECT value FROM user_data.settings WHERE key='runtime_schema') AS shadow_setting`;
  console.log(JSON.stringify({ ...result, admin, setting }));
  await sql.end();
})().catch((error) => { console.error(error); process.exit(1); });
'@
    [IO.File]::WriteAllText($workflowFile, $workflow, [Text.UTF8Encoding]::new($false))
    docker cp $workflowFile "$($env:API_CONTAINER_NAME):/app/apps/api/runtime-smoke.ts" | Out-Null
    $result = docker exec -w /app/apps/api $env:API_CONTAINER_NAME `
      ./node_modules/.bin/tsx runtime-smoke.ts | Select-Object -Last 1 | ConvertFrom-Json
    if ($result.upload_schema -ne "user_data" -or $result.transform_schema -ne "user_data" -or $result.rows -ne 1 `
      -or $result.users_ref_schema -ne "public" -or $result.sales_ref_schema -ne "public" `
      -or $result.runtime_visible -ne "user_data" -or $result.legacy_runtime -ne "public" `
      -or $result.shadow_users -ne 1 -or $result.shadow_setting -ne "shadow" `
      -or $result.admin.username -ne "admin" -or -not $result.admin.isAdmin -or $result.setting.value -ne "public") {
      throw "upload/default-transform or public ORM shadowing assertion failed"
    }

    $body = @{ username = "admin"; password = $env:ADMIN_PASSWORD } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Uri "http://127.0.0.1:$script:ApiHostPortNumber/api/auth/login" `
      -Method Post -ContentType "application/json" -Body $body
    if (-not $login.ok -or -not $login.data.token) { throw "admin login failed" }

    $headers = @{ Authorization = "Bearer $($login.data.token)" }
    $folderResult = Invoke-RestMethod -Uri "http://127.0.0.1:$script:ApiHostPortNumber/api/etl/folder" `
      -Headers $headers
    $alertResult = Invoke-RestMethod -Uri "http://127.0.0.1:$script:ApiHostPortNumber/api/alerts" `
      -Headers $headers
    if ($folderResult.data.folder -ne "public-folder" -or $alertResult.data.summary.openTotal -ne 1 `
      -or @($alertResult.data.rows).Count -ne 1 -or $alertResult.data.rows[0].ruleLabel -ne "public-alert") {
      throw "raw settings/alerts queries were shadowed by user_data tables"
    }

    docker compose -p $project -f $composeFile run --rm --no-deps migrate | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "second migration run failed" }

    $jobScript = {
      param($root, $projectName, $file, $password)
      Set-Location $root
      $env:POSTGRES_PASSWORD = $password
      docker compose -p $projectName -f $file run --rm --no-deps migrate 2>&1 | Out-Null
      return $LASTEXITCODE
    }
    $job1 = Start-Job -ScriptBlock $jobScript -ArgumentList $repoRoot, $project, $composeFile, $env:POSTGRES_PASSWORD
    $job2 = Start-Job -ScriptBlock $jobScript -ArgumentList $repoRoot, $project, $composeFile, $env:POSTGRES_PASSWORD
    Wait-Job $job1, $job2 | Out-Null
    $exit1 = [int](Receive-Job $job1 | Select-Object -Last 1)
    $exit2 = [int](Receive-Job $job2 | Select-Object -Last 1)
    Remove-Job $job1, $job2
    if ($exit1 -ne 0 -or $exit2 -ne 0) { throw "concurrent migrators failed" }

    Write-Output "fresh: health/login/seed/public-shadow/CRUD/two-schema/ETL/second-run/concurrency passed"
  } catch {
    $scenarioError = $_.Exception
  } finally {
    Complete-IsolatedProject $project $scenarioError @($workflowFile)
  }
}

function Invoke-LegacySmoke {
  $project = "ecmig-legacy-" + (Get-Date -Format "HHmmssfff")
  Set-IsolatedEnvironment $project
  $scenarioError = $null
  try {
    docker compose -p $project -f $composeFile up -d --wait postgres | Out-Null
    Initialize-LegacySchema
    docker exec -e PGPASSWORD=$env:APP_DB_PASSWORD $env:POSTGRES_CONTAINER_NAME `
      psql -U ec_app -d ec_data -v ON_ERROR_STOP=1 -c `
      "CREATE TABLE public.uf_4242(id bigserial primary key,payload text); INSERT INTO public.uf_4242(payload) VALUES ('kept')" | Out-Null
    docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -v ON_ERROR_STOP=1 -c `
      "CREATE TABLE public.uf_4343(id bigserial primary key,payload text); INSERT INTO public.uf_4343(payload) VALUES ('owner-kept'); CREATE SCHEMA IF NOT EXISTS user_data AUTHORIZATION ec; CREATE TABLE user_data.uf_4444(id bigserial primary key,payload text); INSERT INTO user_data.uf_4444(payload) VALUES ('already-moved')" | Out-Null
    $migrationRunnerPassword = [guid]::NewGuid().ToString("N")
    docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -v ON_ERROR_STOP=1 -c `
      "CREATE ROLE migration_runner WITH LOGIN SUPERUSER PASSWORD '$migrationRunnerPassword'" | Out-Null
    docker compose -p $project -f $composeFile run --rm --no-deps `
      -e "MIGRATION_DATABASE_URL=postgres://migration_runner:${migrationRunnerPassword}@postgres:5432/ec_data" migrate | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "exact legacy adoption failed" }
    $state = docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -Atqc `
      "SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) || '|' || (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner<>'ec') || '|' || (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('uf_4242','uf_4343')) || '|' || (SELECT tableowner FROM pg_tables WHERE schemaname='user_data' AND tablename='uf_4242') || '|' || (SELECT count(*) FROM user_data.uf_4242) || '|' || (SELECT sequenceowner FROM pg_sequences WHERE schemaname='user_data' AND sequencename='uf_4242_id_seq') || '|' || (SELECT tableowner FROM pg_tables WHERE schemaname='user_data' AND tablename='uf_4343') || '|' || (SELECT count(*) FROM user_data.uf_4343) || '|' || (SELECT sequenceowner FROM pg_sequences WHERE schemaname='user_data' AND sequencename='uf_4343_id_seq') || '|' || (SELECT tableowner FROM pg_tables WHERE schemaname='user_data' AND tablename='uf_4444') || '|' || (SELECT count(*) FROM user_data.uf_4444) || '|' || (SELECT sequenceowner FROM pg_sequences WHERE schemaname='user_data' AND sequencename='uf_4444_id_seq')"
    $expectedState = "$($migrationSqlFiles.Count)|0|0|ec_app|1|ec_app|ec_app|1|ec_app|ec_app|1|ec_app"
    if ($state -ne $expectedState) {
      throw "legacy ownership/data assertion failed: expected=$expectedState actual=$state"
    }
    Write-Output "legacy: exact validation/ownership transfer/dynamic preservation passed"
  } catch {
    $scenarioError = $_.Exception
  } finally {
    Complete-IsolatedProject $project $scenarioError
  }
}

function Invoke-DriftSmoke {
  $project = "ecmig-drift-" + (Get-Date -Format "HHmmssfff")
  Set-IsolatedEnvironment $project
  $scenarioError = $null
  try {
    docker compose -p $project -f $composeFile up -d --wait postgres | Out-Null
    Initialize-LegacySchema
    docker exec -e PGPASSWORD=$env:APP_DB_PASSWORD $env:POSTGRES_CONTAINER_NAME `
      psql -U ec_app -d ec_data -c "ALTER TABLE public.users DROP COLUMN display_name" | Out-Null

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $migrationOutput = docker compose -p $project -f $composeFile run --rm --no-deps migrate 2>&1
    $migrationExit = $LASTEXITCODE
    $ErrorActionPreference = $previous
    $joined = [string]::Join([Environment]::NewLine, $migrationOutput)
    if ($migrationExit -eq 0 -or $joined -notmatch "legacy schema validation failed" -or $joined -notmatch "users.*column order") {
      throw "incomplete legacy schema was not rejected actionably"
    }
    $journalAbsent = docker exec $env:POSTGRES_CONTAINER_NAME psql -U ec -d ec_data -Atqc `
      "SELECT to_regclass('drizzle.__drizzle_migrations') IS NULL"
    if ($journalAbsent -ne "t") { throw "drifted schema was journaled" }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    docker compose -p $project -f $composeFile up -d redis api 2>$null | Out-Null
    $gateExit = $LASTEXITCODE
    $apiRunning = docker inspect -f '{{.State.Running}}' $env:API_CONTAINER_NAME 2>$null
    $ErrorActionPreference = $previous
    if ($gateExit -eq 0 -or $apiRunning -ne "false") { throw "API started after migration failure" }
    Write-Output "drift: actionable rejection/no journal/API gate passed"
  } catch {
    $scenarioError = $_.Exception
  } finally {
    Complete-IsolatedProject $project $scenarioError
  }
}

$originalContainers = docker ps --filter "name=^/ec-data-" --format "{{.ID}} {{.Names}}" | Sort-Object
$smokeFailures = [Collections.Generic.List[Exception]]::new()
foreach ($scenario in @("Invoke-FreshSmoke", "Invoke-LegacySmoke", "Invoke-DriftSmoke")) {
  try {
    & $scenario
  } catch {
    $smokeFailures.Add($_.Exception)
    Write-Error "$scenario failed: $($_.Exception.ToString())" -ErrorAction Continue
  }
}
try {
  $currentContainers = docker ps --filter "name=^/ec-data-" --format "{{.ID}} {{.Names}}" | Sort-Object
  if ([string]::Join("`n", $originalContainers) -ne [string]::Join("`n", $currentContainers)) {
    throw "original ec-data containers changed during migration smoke"
  }
} catch {
  $smokeFailures.Add($_.Exception)
}
if ($smokeFailures.Count -gt 0) {
  throw [AggregateException]::new("Migration runtime smoke failed", [Exception[]]$smokeFailures.ToArray())
}
Write-Output "migration runtime smoke passed; all isolated resources cleaned"
