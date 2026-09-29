"""Package only explicitly listed cloud preparation tools, never runtime state."""
import argparse
import json
from pathlib import Path
import re
import zipfile

FILES = ("cloud.py", "install-ubuntu.sh", "compose.yml.template", "Caddyfile.template",
         "nginx.conf.template", "README.md")
LICENSE_FILES = ("LICENSE", "THIRD_PARTY_NOTICES.md")
ROOT = Path(__file__).resolve().parent.parent


def package(output, source_revision, release_tag):
    # Never walk the user's instance/backup directories or reuse the runtime ZIP.
    if not re.fullmatch(r"[0-9a-f]{40}", source_revision):
        raise ValueError("source_revision must be a lowercase 40-character Git commit ID")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", release_tag):
        raise ValueError("release_tag must be a public semantic-version tag")
    source = ROOT / "cloud-kit"
    for name in FILES:
        path = source / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Missing or unsafe cloud kit member: {name}")
    for name in LICENSE_FILES:
        path = ROOT / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"Missing or unsafe public license member: {name}")
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "name": "ec-cloud-kit",
        "sourceRevision": source_revision,
        "releaseTag": release_tag,
        "members": list(FILES + LICENSE_FILES),
    }
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(source / name, "ec-cloud-kit/" + name)
        for name in LICENSE_FILES:
            archive.write(ROOT / name, "ec-cloud-kit/" + name)
        archive.writestr("ec-cloud-kit/cloud-kit-manifest.json",
                         json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Cloud preparation kit: {output}")
    print("Companion only: also supply the verified complete offline Release and workbench ZIP.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--release-tag", required=True)
    args = parser.parse_args()
    package(args.output, args.source_revision, args.release_tag)
