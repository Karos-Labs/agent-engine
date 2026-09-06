"""Unpack a client's branded-shorts asset bundle into a run's work directory.

    unpack_bundle.py --archive <bundle.zip|.tar|.tar.gz|.tgz> --dest <dir>

A client's brand assets for this product — `brand-profile.json` plus the
fonts, marks and (optionally) `library/` of real stills it references by
relative path — live outside the container image, because they are per
client and the image is per deploy. The portal ships them as ONE archive
in the media bucket; `video.materializeInputs` downloads it and hands it
here. Standard-library only (zipfile/tarfile), because Node has no built-in
archive reader and Python is already a hard requirement of this engine.

Refuses any member that would land outside `--dest` (zip-slip: "../" or
absolute member names) and any symlink member — a bundle is client-supplied
input, and the destination is a tenant's work directory. Exit 1 on any such
member, with nothing extracted; exit 0 prints `unpacked <n> files -> <dest>`.
"""
from __future__ import annotations

import argparse
import sys
import tarfile
import zipfile
from pathlib import Path


def _safe_target(dest: Path, member_name: str) -> Path:
    if not member_name or member_name.startswith(("/", "\\")) or ":" in member_name.split("/")[0]:
        raise ValueError(f"refusing absolute member {member_name!r}")
    target = (dest / member_name).resolve()
    if target != dest and dest not in target.parents:
        raise ValueError(f"refusing member {member_name!r}: escapes the destination")
    return target


def unpack(archive: Path, dest: Path) -> int:
    dest = dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    count = 0
    lower = archive.name.lower()
    if lower.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            members = [m for m in zf.infolist() if not m.is_dir()]
            targets = [_safe_target(dest, m.filename) for m in members]  # validate ALL before writing any
            for m, target in zip(members, targets):
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(m) as src, open(target, "wb") as out:
                    out.write(src.read())
                count += 1
        return count
    if lower.endswith((".tar", ".tar.gz", ".tgz")):
        with tarfile.open(archive) as tf:
            members = [m for m in tf.getmembers() if not m.isdir()]
            for m in members:
                if not m.isfile():
                    raise ValueError(f"refusing non-regular member {m.name!r} (symlink/device)")
            targets = [_safe_target(dest, m.name) for m in members]
            for m, target in zip(members, targets):
                target.parent.mkdir(parents=True, exist_ok=True)
                f = tf.extractfile(m)
                if f is None:
                    raise ValueError(f"could not read member {m.name!r}")
                with open(target, "wb") as out:
                    out.write(f.read())
                count += 1
        return count
    raise ValueError(f"unsupported archive type: {archive.name} (use .zip, .tar, .tar.gz or .tgz)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", type=Path, required=True)
    ap.add_argument("--dest", type=Path, required=True)
    a = ap.parse_args()
    try:
        n = unpack(a.archive, a.dest)
    except (ValueError, zipfile.BadZipFile, tarfile.TarError, OSError) as e:
        sys.exit(f"FAILED: {e}")
    print(f"unpacked {n} files -> {a.dest.resolve()}")


if __name__ == "__main__":
    main()
