import hashlib
import json

import pytest

from app.text_revision_service import RevisionIntegrityError, TextRevisionService


def write_source(root, directory, name, content):
    source_dir = root / directory
    source_dir.mkdir(exist_ok=True)
    path = source_dir / name
    path.write_text(content, encoding="utf-8")
    return path


def test_snapshot_prompt_creates_content_addressed_immutable_version(tmp_path):
    source = write_source(tmp_path, "prompts", "analyze-slide.md", "Analyze this slide.\n")
    service = TextRevisionService(tmp_path, short_revision_length=7)

    revision = service.snapshot_prompt("analyze-slide")
    expected_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    history_dir = tmp_path / ".prompt-history" / "analyze-slide"
    index = json.loads((history_dir / "index.json").read_text(encoding="utf-8"))

    assert revision.created is True
    assert revision.revision == expected_hash
    assert revision.short_revision == expected_hash[:7]
    assert revision.file.endswith(f"_{expected_hash[:7]}.md")
    assert (history_dir / revision.file).read_bytes() == source.read_bytes()
    assert index == {
        "current": expected_hash,
        "versions": [{
            "revision": expected_hash,
            "short_revision": expected_hash[:7],
            "created_at": revision.created_at,
            "file": revision.file,
        }],
    }


def test_same_content_is_deduplicated_by_full_hash(tmp_path):
    write_source(tmp_path, "prompts", "select-template.md", "Pick one.\n")
    service = TextRevisionService(tmp_path)

    first = service.snapshot_prompt("select-template.md")
    second = service.snapshot_prompt("select-template.md")
    index_path = tmp_path / ".prompt-history" / "select-template" / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))

    assert first.created is True
    assert second.created is False
    assert second.revision == first.revision
    assert len(index["versions"]) == 1


def test_changed_content_adds_version_and_preserves_old_snapshot(tmp_path):
    source = write_source(tmp_path, "skills", "typography.md", "Version one\n")
    service = TextRevisionService(tmp_path)
    first = service.snapshot_skill("typography")
    first_snapshot = tmp_path / ".skill-history" / "typography" / first.file

    source.write_text("Version two\n", encoding="utf-8")
    second = service.snapshot_skill("typography")
    index = json.loads(
        (tmp_path / ".skill-history" / "typography" / "index.json").read_text(encoding="utf-8")
    )

    assert second.created is True
    assert second.revision != first.revision
    assert first_snapshot.read_text(encoding="utf-8") == "Version one\n"
    assert index["current"] == second.revision
    assert [item["revision"] for item in index["versions"]] == [first.revision, second.revision]


def test_reverting_content_reuses_old_revision_and_moves_current(tmp_path):
    source = write_source(tmp_path, "skills", "repeated-groups.md", "A")
    service = TextRevisionService(tmp_path)
    first = service.snapshot_skill("repeated-groups")
    source.write_text("B", encoding="utf-8")
    service.snapshot_skill("repeated-groups")
    source.write_text("A", encoding="utf-8")

    reverted = service.snapshot_skill("repeated-groups")
    index = json.loads(
        (tmp_path / ".skill-history" / "repeated-groups" / "index.json").read_text(encoding="utf-8")
    )

    assert reverted.created is False
    assert reverted.revision == first.revision
    assert index["current"] == first.revision
    assert len(index["versions"]) == 2


def test_snapshot_all_handles_prompts_and_skills(tmp_path):
    write_source(tmp_path, "prompts", "one.md", "Prompt")
    write_source(tmp_path, "skills", "two.md", "Skill")

    revisions = TextRevisionService(tmp_path).snapshot_all()

    assert {(item.kind, item.name) for item in revisions} == {
        ("prompt", "one.md"),
        ("skill", "two.md"),
    }


def test_snapshot_rejects_path_traversal(tmp_path):
    service = TextRevisionService(tmp_path)
    with pytest.raises(ValueError):
        service.snapshot_prompt("../secret.md")


def test_modified_snapshot_is_reported_as_integrity_error(tmp_path):
    write_source(tmp_path, "prompts", "safe.md", "Original")
    service = TextRevisionService(tmp_path)
    revision = service.snapshot_prompt("safe")
    snapshot = tmp_path / ".prompt-history" / "safe" / revision.file
    snapshot.chmod(0o644)
    snapshot.write_text("Tampered", encoding="utf-8")

    with pytest.raises(RevisionIntegrityError, match="was modified"):
        service.snapshot_prompt("safe")
