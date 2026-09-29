from __future__ import annotations

import argparse
import hashlib
import json
import os
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal


RevisionKind = Literal["prompt", "skill"]


class RevisionError(RuntimeError):
    """Base error for text revision storage."""


class RevisionIntegrityError(RevisionError):
    """Raised when an existing immutable snapshot does not match its index."""


@dataclass(frozen=True)
class RevisionInfo:
    kind: RevisionKind
    name: str
    revision: str
    short_revision: str
    created_at: str
    file: str
    created: bool

    def to_dict(self) -> dict[str, str | bool]:
        return asdict(self)


class TextRevisionService:
    """Content-addressed immutable history for prompt and skill markdown files."""

    def __init__(
        self,
        root: Path | str | None = None,
        *,
        short_revision_length: int = 12,
    ) -> None:
        self.root = Path(root) if root is not None else Path(__file__).resolve().parent.parent
        if not 7 <= short_revision_length <= 12:
            raise ValueError("short_revision_length must be between 7 and 12")
        self.short_revision_length = short_revision_length
        self._lock = threading.RLock()

    def snapshot_prompt(self, name: str) -> RevisionInfo:
        return self.snapshot("prompt", name)

    def snapshot_skill(self, name: str) -> RevisionInfo:
        return self.snapshot("skill", name)

    def snapshot(self, kind: RevisionKind, name: str) -> RevisionInfo:
        source_path, history_dir, normalized_name = self._paths(kind, name)
        try:
            content = source_path.read_bytes()
        except FileNotFoundError as exc:
            raise FileNotFoundError(f"{kind.capitalize()} file not found: {normalized_name}") from exc

        revision = hashlib.sha256(content).hexdigest()

        with self._lock:
            history_dir.mkdir(parents=True, exist_ok=True)
            index_path = history_dir / "index.json"
            index = self._read_index(index_path)
            existing = next(
                (item for item in index["versions"] if item.get("revision") == revision),
                None,
            )
            if existing is not None:
                self._verify_snapshot(history_dir, existing, revision)
                if index.get("current") != revision:
                    index["current"] = revision
                    self._write_index(index_path, index)
                return self._revision_info(kind, normalized_name, existing, created=False)

            now = datetime.now().astimezone()
            short_revision = revision[: self.short_revision_length]
            timestamp = now.strftime("%Y%m%d-%H%M%S")
            snapshot_name = f"{timestamp}_{short_revision}.md"
            snapshot_path = history_dir / snapshot_name
            if snapshot_path.exists():
                raise RevisionIntegrityError(
                    f"Snapshot filename collision for {kind} {normalized_name}: {snapshot_name}"
                )

            entry = {
                "revision": revision,
                "short_revision": short_revision,
                "created_at": now.isoformat(timespec="seconds"),
                "file": snapshot_name,
            }

            try:
                with snapshot_path.open("xb") as snapshot:
                    snapshot.write(content)
                    snapshot.flush()
                    os.fsync(snapshot.fileno())
                snapshot_path.chmod(0o444)
                index["versions"].append(entry)
                index["current"] = revision
                self._write_index(index_path, index)
            except Exception:
                if snapshot_path.exists() and not any(
                    item.get("file") == snapshot_name for item in index["versions"]
                ):
                    snapshot_path.unlink(missing_ok=True)
                raise

            return self._revision_info(kind, normalized_name, entry, created=True)

    def snapshot_all(self) -> list[RevisionInfo]:
        revisions: list[RevisionInfo] = []
        for kind, directory_name in (("prompt", "prompts"), ("skill", "skills")):
            source_dir = self.root / directory_name
            if not source_dir.is_dir():
                continue
            for source_path in sorted(source_dir.glob("*.md")):
                revisions.append(self.snapshot(kind, source_path.name))
        return revisions

    def _paths(self, kind: RevisionKind, name: str) -> tuple[Path, Path, str]:
        if kind not in {"prompt", "skill"}:
            raise ValueError(f"Unsupported revision kind: {kind}")
        candidate = Path(str(name).strip())
        if not candidate.name or candidate.name != str(candidate) or candidate.suffix not in {"", ".md"}:
            raise ValueError("name must be a markdown filename without directory components")
        filename = candidate.name if candidate.suffix == ".md" else f"{candidate.name}.md"
        stem = Path(filename).stem
        source_dir = self.root / ("prompts" if kind == "prompt" else "skills")
        history_root = self.root / (".prompt-history" if kind == "prompt" else ".skill-history")
        return source_dir / filename, history_root / stem, filename

    @staticmethod
    def _read_index(index_path: Path) -> dict:
        if not index_path.exists():
            return {"current": None, "versions": []}
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise RevisionIntegrityError(f"Cannot read revision index: {index_path}") from exc
        if not isinstance(index, dict) or not isinstance(index.get("versions"), list):
            raise RevisionIntegrityError(f"Invalid revision index: {index_path}")
        return index

    @staticmethod
    def _write_index(index_path: Path, index: dict) -> None:
        temporary = index_path.with_name(
            f".{index_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        payload = json.dumps(index, ensure_ascii=False, indent=2) + "\n"
        try:
            with temporary.open("x", encoding="utf-8") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, index_path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _verify_snapshot(history_dir: Path, entry: dict, revision: str) -> None:
        filename = entry.get("file")
        if not filename or Path(filename).name != filename:
            raise RevisionIntegrityError(f"Invalid snapshot filename in {history_dir / 'index.json'}")
        snapshot_path = history_dir / filename
        try:
            snapshot_revision = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
        except FileNotFoundError as exc:
            raise RevisionIntegrityError(f"Snapshot is missing: {snapshot_path}") from exc
        if snapshot_revision != revision:
            raise RevisionIntegrityError(f"Immutable snapshot was modified: {snapshot_path}")

    @staticmethod
    def _revision_info(
        kind: RevisionKind,
        name: str,
        entry: dict,
        *,
        created: bool,
    ) -> RevisionInfo:
        return RevisionInfo(
            kind=kind,
            name=name,
            revision=entry["revision"],
            short_revision=entry["short_revision"],
            created_at=entry["created_at"],
            file=entry["file"],
            created=created,
        )


class TextRevisionWatcher:
    def __init__(self, service: TextRevisionService, *, interval_seconds: float = 1.0) -> None:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be positive")
        self.service = service
        self.interval_seconds = interval_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_error: Exception | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="text-revision-watcher",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=timeout)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.service.snapshot_all()
                self.last_error = None
            except Exception as exc:  # keep the app alive; expose the error for diagnostics
                self.last_error = exc
            self._stop_event.wait(self.interval_seconds)


DEFAULT_REVISION_SERVICE = TextRevisionService()


def snapshot_prompt(name: str) -> RevisionInfo:
    return DEFAULT_REVISION_SERVICE.snapshot_prompt(name)


def snapshot_skill(name: str) -> RevisionInfo:
    return DEFAULT_REVISION_SERVICE.snapshot_skill(name)


def _main() -> None:
    parser = argparse.ArgumentParser(description="Snapshot or watch prompt/skill markdown files")
    parser.add_argument("command", choices=("snapshot-all", "watch"), nargs="?", default="snapshot-all")
    parser.add_argument("--root", type=Path, default=None)
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()
    service = TextRevisionService(args.root)
    if args.command == "snapshot-all":
        for revision in service.snapshot_all():
            print(json.dumps(revision.to_dict(), ensure_ascii=False))
        return

    watcher = TextRevisionWatcher(service, interval_seconds=args.interval)
    watcher.start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        watcher.stop()


if __name__ == "__main__":
    _main()
