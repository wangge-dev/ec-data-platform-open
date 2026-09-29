#!/usr/bin/env python3
"""Prepare a fresh Ubuntu single-tenant host around an unchanged offline release."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import urllib.request

KIT = Path(__file__).resolve().parent
IMAGES = {"caddy": "caddy:2.11.4-alpine", "gateway": "nginx:1.30.4-alpine"}


def fail(message):
    raise ValueError(message)


def write_new(path, content):
    # O_EXCL protects existing instance secrets/configuration even on repeat runs.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(content)


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def runtime_environment():
    # Same target boundary as the existing backup scripts: do not inherit overrides.
    if any(k.startswith(("DOCKER_", "COMPOSE_")) for k in os.environ):
        fail("Remove process-level DOCKER_/COMPOSE_ overrides before running this command.")
    return dict(os.environ)


def prepare(args):
    domain = args.domain.lower()
    if len(domain) > 253 or not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
        fail("Domain must be a DNS hostname, without a URL, wildcard or port.")
    if not re.fullmatch(r"[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,63}", args.email):
        fail("Supply a valid certificate contact email.")
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,39}", args.instance):
        fail("Instance must be 3-40 lowercase letters, digits or hyphens, starting with a letter.")
    if not 2 <= args.local_backup_keep <= 90:
        fail("Local backup retention must keep between 2 and 90 successful backups.")
    release, state = Path(args.release).resolve(), Path(args.state).resolve()
    if release == state or release in state.parents or state in release.parents:
        fail("State and release must be separate directories, not nested.")
    if any(re.search(r'[\s%\"\x00-\x1f]', str(p)) for p in (release, state)):
        fail("Use deployment paths without whitespace, quotes or percent signs.")
    for name in ("release-manifest.json", "release-image-ids.txt", "ec-data-images.tar",
                 "start.sh", "backup.sh", "restore.sh", "deploy/docker-compose.yml"):
        if not (release / name).is_file() or (release / name).is_symlink():
            fail(f"A complete extracted release is required; missing/unsafe: {name}")
    manifest = json.loads((release / "release-manifest.json").read_text(encoding="utf-8-sig"))
    if manifest.get("name") != release.name or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("sourceRevision", "")):
        fail("Keep the original release directory name and valid sourceRevision.")
    if state.exists() or (release / "deploy/.env").exists() or (release / "deploy/.env").is_symlink():
        fail("Fresh instances only: existing state or deploy/.env will not be overwritten.")
    templates = {name: (KIT / (name + ".template")).read_text(encoding="utf-8")
                 for name in ("Caddyfile", "nginx.conf", "compose.yml")}
    state.mkdir(parents=True, mode=0o700)
    state.chmod(0o700)
    for child in ("backups", "caddy-data", "caddy-config", "systemd"):
        (state / child).mkdir(mode=0o700)
    config = {"release": str(release), "state": str(state), "domain": domain,
              "email": args.email, "instance": args.instance,
              "sourceRevision": manifest["sourceRevision"],
              "localBackupKeep": args.local_backup_keep}
    env = {name: secrets.token_hex(32) for name in (
        "POSTGRES_PASSWORD", "APP_DB_PASSWORD", "ADMIN_PASSWORD", "JWT_SECRET", "ENCRYPTION_KEY")}
    env.update({"INSTANCE_ID": args.instance, "COMPOSE_PROJECT_NAME": args.instance,
                "CORS_ORIGIN": f"https://{domain}", "ALLOW_PRIVATE_SQL_HOST": "0"})
    for service, port in (("POSTGRES", 5432), ("REDIS", 6379), ("API", 4000), ("WEB", 3997)):
        env[f"{service}_HOST_PORT"] = f"127.0.0.1:{port}"
        env[f"{service}_CONTAINER_NAME"] = f"{args.instance}-{service.lower()}"
    env["MIGRATE_CONTAINER_NAME"] = f"{args.instance}-migrate"
    write_new(release / "deploy/.env", "".join(f"{k}={v}\n" for k, v in env.items()))
    write_new(state / "instance.json", json.dumps(config, indent=2) + "\n")
    write_new(state / "cloud.py", Path(__file__).read_text(encoding="utf-8"))
    for name, template in templates.items():
        for key, value in {"DOMAIN": domain, "EMAIL": args.email, "INSTANCE": args.instance,
                           "CADDY_IMAGE": IMAGES["caddy"], "NGINX_IMAGE": IMAGES["gateway"]}.items():
            template = template.replace(f"@@{key}@@", value)
        write_new(state / name, template)
    write_new(state / "restic.env.example", "# Copy to restic.env; keep mode 600. No shell quotes.\n"
              "RESTIC_REPOSITORY=s3:https://OBJECT-ENDPOINT/BUCKET/ec-data\n"
              "RESTIC_PASSWORD_FILE=/secure/separate/restic-password\n"
              "AWS_ACCESS_KEY_ID=REPLACE\nAWS_SECRET_ACCESS_KEY=REPLACE\n")
    for job, schedule in (("backup", "OnCalendar=*-*-* 03:15:00\nPersistent=true"),
                          ("check", "OnBootSec=5min\nOnUnitActiveSec=5min")):
        unit = f"ec-{args.instance}-{job}"
        write_new(state / "systemd" / (unit + ".service"),
                  f"[Unit]\nDescription=EC {job} ({args.instance})\nAfter=docker.service network-online.target\n"
                  f"[Service]\nType=oneshot\nUMask=0077\n"
                  f'ExecStart=/usr/bin/python3 "{state / "cloud.py"}" {job} --state "{state}"\n')
        write_new(state / "systemd" / (unit + ".timer"),
                  f"[Unit]\nDescription=EC {job} schedule\n[Timer]\n{schedule}\n"
                  f"RandomizedDelaySec=60\n[Install]\nWantedBy=timers.target\n")
    print(f"Prepared {args.instance}. No containers or public services started.\n"
          f"Runtime: {release}\nPrivate state: {state}\n"
          "Initial admin password is in deploy/.env (ADMIN_PASSWORD); it was not printed.\n"
          "Keep this environment file; changing it does not reset an existing user password.")


def load_config(state):
    state = Path(state).resolve()
    config = json.loads((state / "instance.json").read_text(encoding="utf-8"))
    if Path(config["state"]).resolve() != state:
        fail("State directory moved; review instance.json and systemd paths first.")
    return config, state, Path(config["release"])


def compose(state, *args):
    return ["docker", "compose", "--project-directory", str(state), "-f", str(state / "compose.yml"), *args]


def check_runtime_boundary(config, release, env):
    endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
                   capture_output=True, text=True, env=env).stdout.strip()
    if endpoint != "unix:///var/run/docker.sock":
        fail("This kit operates the local rootful Docker socket only; select the server's default context.")
    output = run(["docker", "compose", "--env-file", str(release / "deploy/.env"),
                  "-f", str(release / "deploy/docker-compose.yml"), "config", "--format", "json"],
                 capture_output=True, text=True, env=env)
    spec = json.loads(output.stdout)
    if spec.get("name") != config["instance"]:
        fail("Runtime project no longer matches the configured instance.")
    for service in ("postgres", "redis", "api", "web"):
        ports = spec["services"][service].get("ports", [])
        if not ports or any(p.get("host_ip") != "127.0.0.1" for p in ports):
            fail(f"Cloud runtime requires loopback-only ports: {service}")
    # A same-name Compose project in another folder must not be replaced.
    ids = run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={config['instance']}"],
              capture_output=True, text=True, env=env).stdout.split()
    if ids:
        containers = json.loads(run(["docker", "inspect", *ids], capture_output=True, text=True, env=env).stdout)
        for container in containers:
            origin = container["Config"]["Labels"].get("com.docker.compose.project.config_files", "")
            if origin != str(release / "deploy/docker-compose.yml"):
                fail("An existing same-name Docker project belongs to a different release path; use the upgrade guide.")


def health(url):
    # Keep TLS verification enabled and avoid environment proxy overrides on loopback.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url, timeout=15) as response:
        payload = json.load(response)
    if payload.get("ok") is not True or payload.get("db") != "connected":
        fail("API health did not confirm a database connection.")


def restic_environment(state):
    env = runtime_environment()
    permitted = {"RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE", "AWS_ACCESS_KEY_ID",
                 "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_SESSION_TOKEN"}
    values = {}
    for line in (state / "restic.env").read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or key not in permitted or key in values or not value:
            fail("Invalid restic.env entry; see restic.env.example.")
        values[key] = value
    if not {"RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE"} <= values.keys():
        fail("restic.env must set a repository and password file.")
    if not Path(values["RESTIC_PASSWORD_FILE"]).is_file():
        fail("The separate restic password file does not exist.")
    env.update(values)
    return env


def prune_local_backups(config, state):
    """Bound local storage while deleting only validated backups from this instance."""
    keep = config.get("localBackupKeep")
    if not isinstance(keep, int) or isinstance(keep, bool) or not 2 <= keep <= 90:
        fail("instance.json has an invalid localBackupKeep value.")
    backup_root = state / "backups"
    pattern = re.compile(rf"ec-data-instance-backup-{re.escape(config['instance'])}-\d{{8}}T\d{{6}}Z")
    candidates = []
    for child in backup_root.iterdir():
        if not pattern.fullmatch(child.name):
            continue
        if child.is_symlink() or not child.is_dir():
            fail(f"Refusing unsafe local backup retention candidate: {child.name}")
        manifest = child / "backup-manifest.txt"
        dump = child / "ec_data.dump"
        if manifest.is_symlink() or dump.is_symlink() or not manifest.is_file() or not dump.is_file():
            fail(f"Refusing incomplete local backup retention candidate: {child.name}")
        values = {}
        for line in manifest.read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if not separator or not key or key in values:
                fail(f"Refusing invalid local backup manifest: {child.name}")
            values[key] = value
        if (values.get("schemaVersion") != "instance-backup/v1" or
                values.get("sourceInstanceId") != config["instance"] or
                values.get("fileName") != "ec_data.dump"):
            fail(f"Refusing foreign local backup retention candidate: {child.name}")
        candidates.append(child)
    removed = []
    for child in sorted(candidates, key=lambda path: path.name)[:-keep]:
        shutil.rmtree(child)
        removed.append(child.name)
    print(f"Local backup retention: kept {min(len(candidates), keep)} latest validated backup(s); "
          f"removed {len(removed)} older backup(s).")
    return removed


def backup(config, state, release):
    import fcntl  # Linux-only commands; prevents timer/manual overlaps.
    with (state / "backup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = runtime_environment()
        env["BASH_ENV"] = "/dev/null"
        run(["bash", str(release / "backup.sh"), "--output-root", str(state / "backups")], env=env)
        prune_local_backups(config, state)
        result = {"localAt": datetime.now(timezone.utc).isoformat(), "offsiteAt": None}
        restic_env = state / "restic.env"
        if restic_env.exists():
            env.update(restic_environment(state))
            # No init/forget/prune here: repository setup and retention are explicit operator actions.
            run(["restic", "backup", "--tag", config["instance"], str(state / "backups"),
                 str(release / "deploy/.env"), str(state / "instance.json"),
                 str(state / "caddy-data"), str(state / "Caddyfile"), str(state / "nginx.conf"),
                 str(state / "compose.yml"), str(state / "cloud.py"), str(state / "systemd")], env=env)
            result["offsiteAt"] = datetime.now(timezone.utc).isoformat()
        else:
            print("WARNING: local backup only; configure encrypted offsite storage before cloud use.")
        temp = state / "last-backup.pending.json"
        with temp.open("w", encoding="utf-8") as stream:
            json.dump(result, stream)
        temp.replace(state / "last-backup.json")
        print("Backup completed with bounded local retention.")


def operate(args):
    if sys.platform != "linux":
        fail("Runtime operations require the target Ubuntu server. Prepare/tests can run offline.")
    os.umask(0o077)
    config, state, release = load_config(args.state)
    env = runtime_environment()
    if args.command == "start-local":
        check_runtime_boundary(config, release, env)
        env["BASH_ENV"] = "/dev/null"
        run(["bash", str(release / "start.sh")], cwd=release, env=env)
        health("http://127.0.0.1:3997/api/health")
        print("Local release healthy. HTTPS remains a separate deployment step.")
    elif args.command == "enable-https":
        check_runtime_boundary(config, release, env)
        health("http://127.0.0.1:3997/api/health")
        run(compose(state, "config", "--quiet"), env=env)
        run(compose(state, "pull"), env=env)
        run(compose(state, "run", "--rm", "--no-deps", "gateway", "nginx", "-t"), env=env)
        run(compose(state, "run", "--rm", "--no-deps", "caddy", "caddy", "validate",
                    "--config", "/etc/caddy/Caddyfile"), env=env)
        run(compose(state, "up", "-d", "--force-recreate"), env=env)
        print(f"HTTPS started: https://{config['domain']}. Certificate issuance depends on DNS and reachable TCP 443.")
        print("Run check after certificate issuance; container startup alone is not public acceptance.")
    elif args.command == "backup":
        backup(config, state, release)
    elif args.command == "init-backup":
        run(["restic", "init"], env=restic_environment(state))
    elif args.command == "install-timers":
        if os.geteuid() != 0:
            fail("Use sudo to install systemd timers.")
        units = list((state / "systemd").iterdir())
        for source in units:
            target = Path("/etc/systemd/system") / source.name
            if target.exists() and target.read_bytes() != source.read_bytes():
                fail(f"Existing different systemd unit requires review: {target.name}")
        for source in units:
            target = Path("/etc/systemd/system") / source.name
            if not target.exists():
                write_new(target, source.read_text(encoding="utf-8"))
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "--now", *[p.name for p in units if p.suffix == ".timer"]])
        print("Daily backup and 5-minute check enabled. Failures appear in systemd/journal; external alert routing is not configured.")
    elif args.command == "check":
        problems = []
        for url in ("http://127.0.0.1:3997/api/health", f"https://{config['domain']}/api/health"):
            try:
                health(url)
            except Exception:
                problems.append(f"Health/TLS failed: {url}")
        for path in (state, release, Path("/var/lib/docker")):
            if path.exists():
                usage = shutil.disk_usage(path)
                if usage.used / usage.total >= .85:
                    problems.append(f"Disk usage >=85%: {path}")
        marker = state / "last-backup.json"
        latest = json.loads(marker.read_text()) if marker.exists() else {}
        for key in ("localAt", "offsiteAt"):
            stamp = latest.get(key)
            if not stamp or (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds() > 26 * 3600:
                problems.append(f"No successful {key} backup within 26h")
        if problems:
            fail("; ".join(problems))
        print("Local API, HTTPS/TLS, disk and recent local/offsite backup checks passed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare", help="Generate fresh configuration without starting services")
    for name in ("release", "state", "domain", "email", "instance"):
        prep.add_argument("--" + name, required=True)
    prep.add_argument("--local-backup-keep", type=int, default=7,
                      help="Number of validated local backups to retain (default: 7, range: 2-90)")
    for action in ("start-local", "enable-https", "backup", "init-backup", "check", "install-timers"):
        cmd = sub.add_parser(action)
        cmd.add_argument("--state", required=True)
    args = parser.parse_args()
    try:
        prepare(args) if args.command == "prepare" else operate(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # Commands include paths, never credentials. Do not dump environment values.
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
