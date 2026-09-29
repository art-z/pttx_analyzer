from pathlib import Path

from .text_revision_service import snapshot_prompt

PROMPTS_ROOT = Path(__file__).resolve().parent.parent / "prompts"


def load_prompt(name: str) -> str:
    path = PROMPTS_ROOT / name
    if not path.is_file():
        raise FileNotFoundError(f"Prompt file not found: {name}")
    snapshot_prompt(name)
    return path.read_text(encoding="utf-8").strip()


def load_default_brief() -> str:
    return load_prompt("default_breaf.md")
