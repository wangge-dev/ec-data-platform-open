"""Offline behavior tests. No real release, credentials or cloud host required."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cloud = load("cloud", ROOT / "cloud-kit/cloud.py")
packager = load("packager", ROOT / "scripts/package-cloud-kit.py")


class CloudKitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ec-cloud-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / "ec-data-platform-test"
        self.state = self.root / "private-state"
        (self.release / "deploy").mkdir(parents=True)
        for name in ("start.sh", "backup.sh", "restore.sh", "release-image-ids.txt", "ec-data-images.tar", "deploy/docker-compose.yml"):
            (self.release / name).write_text("test fixture only\n")
        (self.release / "release-manifest.json").write_text(json.dumps({"name": self.release.name, "sourceRevision": "a" * 40}))
        self.args = argparse.Namespace(release=str(self.release), state=str(self.state),
                                       domain="data.example.com", email="ops@example.com", instance="shop-a",
                                       local_backup_keep=7)

    def prepare(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch.object(cloud, "run", side_effect=AssertionError("prepare must not run services")):
            cloud.prepare(self.args)
        return output.getvalue()

    def test_fresh_instance_secrets_ports_and_no_secret_output(self):
        output = self.prepare()
        env = dict(line.split("=", 1) for line in (self.release / "deploy/.env").read_text().splitlines())
        secrets = [env[k] for k in ("POSTGRES_PASSWORD", "APP_DB_PASSWORD", "ADMIN_PASSWORD", "JWT_SECRET", "ENCRYPTION_KEY")]
        self.assertEqual(len(set(secrets)), 5)
        self.assertTrue(all(len(value) == 64 and value not in output for value in secrets))
        self.assertEqual(env["CORS_ORIGIN"], "https://data.example.com")
        for service in ("POSTGRES", "REDIS", "API", "WEB"):
            self.assertTrue(env[f"{service}_HOST_PORT"].startswith("127.0.0.1:"))
        self.assertEqual(env["INSTANCE_ID"], env["COMPOSE_PROJECT_NAME"])
        if os.name == "posix":
            self.assertEqual((self.release / "deploy/.env").stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_retry_preserves_passwords_and_configuration(self):
        self.prepare()
        before = (self.release / "deploy/.env").read_bytes()
        with self.assertRaisesRegex(ValueError, "overwritten"):
            cloud.prepare(self.args)
        self.assertEqual(before, (self.release / "deploy/.env").read_bytes())

    def test_invalid_inputs_never_create_state(self):
        for key, value in (("domain", "https://example.com"), ("domain", "data.example.com\nadmin off"),
                           ("email", "a@b.com\n}") , ("instance", "../another")):
            old = getattr(self.args, key)
            setattr(self.args, key, value)
            with self.assertRaises(ValueError):
                cloud.prepare(self.args)
            self.assertFalse(self.state.exists())
            self.assertFalse((self.release / "deploy/.env").exists())
            setattr(self.args, key, old)

    def test_refuses_missing_release_and_nested_state(self):
        self.args.state = str(self.release / "private-state")
        with self.assertRaisesRegex(ValueError, "not nested"):
            cloud.prepare(self.args)
        self.args.state = str(self.state)
        (self.release / "ec-data-images.tar").unlink()
        with self.assertRaisesRegex(ValueError, "complete extracted release"):
            cloud.prepare(self.args)

    def test_restic_parser_rejects_shell_override_and_does_not_execute(self):
        self.prepare()
        (self.state / "restic.env").write_text("RESTIC_REPOSITORY=s3:https://example/bucket\nDOCKER_HOST=tcp://bad\n")
        with self.assertRaisesRegex(ValueError, "Invalid restic"):
            cloud.restic_environment(self.state)

    def test_remote_docker_override_is_rejected(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://unrelated-host:2375"}):
            with self.assertRaisesRegex(ValueError, "overrides"):
                cloud.runtime_environment()

    def test_public_runtime_port_is_rejected_before_start(self):
        config = {"instance": "shop-a"}
        spec = {"name": "shop-a", "services": {"postgres": {"ports": [{"host_ip": "0.0.0.0"}]}}}
        responses = [argparse.Namespace(stdout="unix:///var/run/docker.sock\n"),
                     argparse.Namespace(stdout=json.dumps(spec))]
        with patch.object(cloud, "run", side_effect=responses):
            with self.assertRaisesRegex(ValueError, "loopback-only"):
                cloud.check_runtime_boundary(config, self.release, {})

    def test_same_name_other_release_is_not_replaced(self):
        config = {"instance": "shop-a"}
        spec = {"name": "shop-a", "services": {service: {"ports": [{"host_ip": "127.0.0.1"}]}
                                                for service in ("postgres", "redis", "api", "web")}}
        containers = [{"Config": {"Labels": {"com.docker.compose.project.config_files": "/other/compose.yml"}}}]
        responses = [argparse.Namespace(stdout="unix:///var/run/docker.sock\n"),
                     argparse.Namespace(stdout=json.dumps(spec)), argparse.Namespace(stdout="abc123\n"),
                     argparse.Namespace(stdout=json.dumps(containers))]
        with patch.object(cloud, "run", side_effect=responses):
            with self.assertRaisesRegex(ValueError, "different release"):
                cloud.check_runtime_boundary(config, self.release, {})

    def test_packaging_uses_allowlist_and_does_not_overwrite(self):
        output = self.root / "kit.zip"
        revision = "b" * 40
        packager.package(output, revision, "v0.1.0")
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()),
                             {"ec-cloud-kit/" + name for name in packager.FILES + packager.LICENSE_FILES} |
                             {"ec-cloud-kit/cloud-kit-manifest.json"})
            self.assertTrue(all(".env" not in name for name in archive.namelist()))
            manifest = json.loads(archive.read("ec-cloud-kit/cloud-kit-manifest.json"))
            self.assertEqual(manifest["sourceRevision"], revision)
            self.assertEqual(manifest["releaseTag"], "v0.1.0")
            self.assertEqual(manifest["members"], list(packager.FILES + packager.LICENSE_FILES))
        with self.assertRaises(FileExistsError):
            packager.package(output, revision, "v0.1.0")

    def test_local_backup_retention_keeps_latest_validated_set(self):
        self.prepare()
        unrelated = self.state / "backups" / "operator-notes"
        unrelated.mkdir()
        for day in range(1, 10):
            backup = self.state / "backups" / f"ec-data-instance-backup-shop-a-202609{day:02d}T031500Z"
            backup.mkdir()
            (backup / "ec_data.dump").write_bytes(b"synthetic")
            (backup / "backup-manifest.txt").write_text(
                "schemaVersion=instance-backup/v1\nsourceInstanceId=shop-a\nfileName=ec_data.dump\n")
        config, state, _ = cloud.load_config(self.state)
        removed = cloud.prune_local_backups(config, state)
        remaining = sorted(path.name for path in (state / "backups").iterdir()
                           if path.name.startswith("ec-data-instance-backup-"))
        self.assertEqual(len(removed), 2)
        self.assertEqual(len(remaining), 7)
        self.assertEqual(remaining[0], "ec-data-instance-backup-shop-a-20260903T031500Z")
        self.assertTrue(unrelated.is_dir())

    def test_local_backup_retention_refuses_incomplete_candidate_before_deletion(self):
        self.prepare()
        for day in range(1, 10):
            backup = self.state / "backups" / f"ec-data-instance-backup-shop-a-202609{day:02d}T031500Z"
            backup.mkdir()
            (backup / "ec_data.dump").write_bytes(b"synthetic")
            if day != 9:
                (backup / "backup-manifest.txt").write_text(
                    "schemaVersion=instance-backup/v1\nsourceInstanceId=shop-a\nfileName=ec_data.dump\n")
        config, state, _ = cloud.load_config(self.state)
        with self.assertRaisesRegex(ValueError, "incomplete"):
            cloud.prune_local_backups(config, state)
        self.assertEqual(len(list((state / "backups").iterdir())), 9)

    def test_derived_timers_run_private_copy(self):
        self.prepare()
        for job in ("backup", "check"):
            service = (self.state / "systemd" / f"ec-shop-a-{job}.service").read_text()
            self.assertIn(str(self.state / "cloud.py"), service)
            self.assertNotIn(str(ROOT), service)
            self.assertIn("UMask=0077", service)

    @unittest.skipUnless(sys.platform == "linux", "Linux fcntl backup serialization")
    def test_backup_does_not_claim_offsite_success_after_restic_failure(self):
        self.prepare()
        secret = self.root / "restic-password"
        secret.write_text("synthetic-test-password")
        (self.state / "restic.env").write_text(
            f"RESTIC_REPOSITORY=s3:https://example.test/bucket\nRESTIC_PASSWORD_FILE={secret}\n")
        config, state, release = cloud.load_config(self.state)

        def failing_run(args, **kwargs):
            if args[0] == "restic":
                raise subprocess.CalledProcessError(1, ["restic", "backup"])

        with patch.object(cloud, "run", side_effect=failing_run):
            with self.assertRaises(subprocess.CalledProcessError):
                cloud.backup(config, state, release)
        self.assertFalse((state / "last-backup.json").exists())
        with patch.object(cloud, "run") as runner:
            cloud.backup(config, state, release)
        marker = json.loads((state / "last-backup.json").read_text())
        self.assertTrue(marker["offsiteAt"])
        remote_args = runner.call_args_list[-1].args[0]
        self.assertIn(str(release / "deploy/.env"), remote_args)
        self.assertNotIn("synthetic-test-password", " ".join(remote_args))

    @unittest.skipUnless(sys.platform == "linux", "Linux fcntl backup serialization")
    def test_local_backup_is_explicitly_not_offsite(self):
        self.prepare()
        config, state, release = cloud.load_config(self.state)
        with patch.object(cloud, "run"), contextlib.redirect_stdout(io.StringIO()) as output:
            cloud.backup(config, state, release)
        self.assertIsNone(json.loads((state / "last-backup.json").read_text())["offsiteAt"])
        self.assertIn("local backup only", output.getvalue())

    @unittest.skipUnless(os.environ.get("CLOUD_DOCKER_TESTS") == "1", "opt-in Docker CLI/config validation")
    def test_configs_are_accepted_by_real_engines(self):
        self.prepare()
        for args in (
            ["docker", "compose", "-f", str(self.state / "compose.yml"), "config", "--quiet"],
            ["docker", "run", "--rm", "-v", f"{self.state}/Caddyfile:/etc/caddy/Caddyfile:ro",
             cloud.IMAGES["caddy"], "caddy", "validate", "--config", "/etc/caddy/Caddyfile"],
            ["docker", "run", "--rm", "-v", f"{self.state}/nginx.conf:/etc/nginx/nginx.conf:ro",
             cloud.IMAGES["gateway"], "nginx", "-t"],
        ):
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
