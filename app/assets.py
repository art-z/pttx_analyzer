import re
import hashlib
import io
import mimetypes
import posixpath
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote

from PIL import Image
import imagehash
from lxml import etree

from .pptx import PPTXPackage

REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"p": P_NS, "a": A_NS}
EMU_PER_PT = 12700

RASTER_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


def extract_assets(package: PPTXPackage, output_dir: Path) -> dict:
    media_dir = output_dir / "assets"
    media_dir.mkdir(parents=True, exist_ok=True)

    usage = _collect_asset_usage(package, _slide_size(package))
    media_files = []

    for part in package.list("ppt/media/"):
        if part.endswith("/"):
            continue

        data = package.read(part)
        filename = Path(part).name
        suffix = Path(filename).suffix.lower()
        mime, _ = mimetypes.guess_type(filename)
        sha256 = hashlib.sha256(data).hexdigest()

        target = media_dir / filename
        target.write_bytes(data)

        width = height = None
        phash = None

        if suffix in RASTER_EXTS:
            try:
                with Image.open(io.BytesIO(data)) as im:
                    width, height = im.size
                    # Convert to RGB so palette/alpha modes don't affect hashing behavior.
                    phash = str(imagehash.phash(im.convert("RGB")))
            except Exception:
                pass
        elif suffix == ".svg":
            width, height = _svg_dimensions(data)

        u = usage.get(part, {"occurrences": 0, "slides": set(), "sources": []})

        media_files.append({
            "asset_id": f"sha256:{sha256}",
            "source": part,
            "filename": filename,
            "extension": suffix,
            "mime": mime,
            "bytes": len(data),
            "sha256": sha256,
            "phash": phash,
            "width": width,
            "height": height,
            "occurrences": u["occurrences"],
            "slides_used": len(u["slides"]),
            "slide_numbers": sorted(u["slides"]),
            "sources": u["sources"],
        })

    exact_groups = _build_exact_groups(media_files)
    visual_groups = _build_visual_groups(media_files)

    # Annotate every physical media file with group information.
    exact_by_file = {}
    for group in exact_groups:
        for filename in group["files"]:
            exact_by_file[filename] = group

    visual_by_file = {}
    for group in visual_groups:
        for filename in group["files"]:
            visual_by_file[filename] = group

    for asset in media_files:
        eg = exact_by_file.get(asset["filename"])
        vg = visual_by_file.get(asset["filename"])
        asset["exact_group_id"] = eg["group_id"] if eg else None
        asset["exact_duplicates"] = len(eg["files"]) if eg else 1
        asset["visual_group_id"] = vg["group_id"] if vg else None
        asset["visual_duplicates"] = len(vg["files"]) if vg else 1

    background_candidates = _classify_backgrounds(media_files)
    icon_groups = _classify_icons(media_files)

    media_files.sort(key=lambda a: (-a["occurrences"], -a["slides_used"], a["filename"]))

    return {
        "media_files": media_files,
        "exact_groups": exact_groups,
        "visual_groups": visual_groups,
        "background_candidates": background_candidates,
        "icon_groups": icon_groups,
    }


def _collect_asset_usage(package: PPTXPackage, slide_size: tuple[int, int] | None) -> dict:
    usage = defaultdict(lambda: {"occurrences": 0, "slides": set(), "sources": []})

    source_parts = []
    source_parts += [p for p in package.list("ppt/slides/") if p.endswith(".xml")]
    source_parts += [p for p in package.list("ppt/slideLayouts/") if p.endswith(".xml")]
    source_parts += [p for p in package.list("ppt/slideMasters/") if p.endswith(".xml")]

    for source_part in source_parts:
        rels_part = _rels_path(source_part)
        if not package.exists(rels_part):
            continue

        rels_root = package.xml(rels_part)
        image_rels = {}

        for rel in rels_root.findall("r:Relationship", REL_NS):
            if rel.get("Type") != IMAGE_REL_TYPE:
                continue
            rid = rel.get("Id")
            target = rel.get("Target")
            if not rid or not target:
                continue
            image_rels[rid] = _resolve_target(source_part, target)

        if not image_rels:
            continue

        root = package.xml(source_part)
        slide_number = _slide_number(source_part)

        # Count every actual reference to an image relationship.
        for node in root.iter():
            for attr_name, attr_value in node.attrib.items():
                if not attr_name.startswith("{" + DOC_REL_NS + "}"):
                    continue
                if attr_value not in image_rels:
                    continue

                media_part = image_rels[attr_value]
                if not media_part.startswith("ppt/media/"):
                    continue

                item = usage[media_part]
                item["occurrences"] += 1

                if slide_number is not None:
                    item["slides"].add(slide_number)

                item["sources"].append({
                    "part": source_part,
                    "relationship_id": attr_value,
                    "placement": _image_placement(node, slide_size),
                })

    return usage


def _slide_size(package: PPTXPackage) -> tuple[int, int] | None:
    if not package.exists("ppt/presentation.xml"):
        return None
    size = package.xml("ppt/presentation.xml").find("p:sldSz", NS)
    if size is None:
        return None
    try:
        return int(size.get("cx")), int(size.get("cy"))
    except (TypeError, ValueError):
        return None


def _image_placement(node, slide_size: tuple[int, int] | None) -> dict:
    parent = node
    shape = None
    while parent is not None:
        if parent.tag == f"{{{P_NS}}}bg":
            return {"role": "background", "coverage": 1.0}
        if parent.tag in {f"{{{P_NS}}}pic", f"{{{P_NS}}}sp"}:
            shape = parent
            break
        parent = parent.getparent()

    role = "picture" if shape is not None and shape.tag == f"{{{P_NS}}}pic" else "shape_fill" if shape is not None else "other"
    placement = {"role": role}
    if shape is None or slide_size is None:
        return placement
    transform = shape.find("p:spPr/a:xfrm", NS)
    if transform is None:
        return placement
    offset = transform.find("a:off", NS)
    extent = transform.find("a:ext", NS)
    if offset is None or extent is None:
        return placement
    try:
        x, y = int(offset.get("x")), int(offset.get("y"))
        width, height = int(extent.get("cx")), int(extent.get("cy"))
    except (TypeError, ValueError):
        return placement
    slide_width, slide_height = slide_size
    if slide_width <= 0 or slide_height <= 0 or width <= 0 or height <= 0:
        return placement
    visible_width = max(0, min(x + width, slide_width) - max(x, 0))
    visible_height = max(0, min(y + height, slide_height) - max(y, 0))
    placement.update({
        "x_pt": round(x / EMU_PER_PT, 2),
        "y_pt": round(y / EMU_PER_PT, 2),
        "width_pt": round(width / EMU_PER_PT, 2),
        "height_pt": round(height / EMU_PER_PT, 2),
        "width_ratio": round(width / slide_width, 3),
        "height_ratio": round(height / slide_height, 3),
        "coverage": round(visible_width * visible_height / (slide_width * slide_height), 3),
    })
    return placement


def _background_score(source: dict) -> tuple[float, str | None]:
    placement = source.get("placement", {})
    if placement.get("role") == "background":
        return 1.0, "Фоновая заливка слайда"
    coverage = placement.get("coverage", 0)
    width = placement.get("width_ratio", 0)
    height = placement.get("height_ratio", 0)
    if coverage >= 0.93 and width >= 0.9 and height >= 0.9:
        return 0.95, "Изображение покрывает почти весь слайд"
    if coverage >= 0.8 and width >= 0.8 and height >= 0.8:
        return 0.85, "Крупная подложка слайда"
    part = source.get("part", "")
    if ("slideMasters/" in part or "slideLayouts/" in part) and coverage >= 0.4 and (width >= 0.85 or height >= 0.85):
        return 0.7, "Крупное изображение в шаблоне"
    return 0.0, None


def _classify_backgrounds(media_files: list[dict]) -> list[dict]:
    candidates = []
    for asset in media_files:
        scored = [_background_score(source) for source in asset["sources"]]
        score, reason = max(scored, default=(0.0, None), key=lambda item: item[0])
        asset["background_likelihood"] = score
        asset["background_reason"] = reason
        if score >= 0.7:
            candidates.append({
                "filename": asset["filename"],
                "likelihood": score,
                "reason": reason,
                "slide_numbers": asset["slide_numbers"],
            })
    return sorted(candidates, key=lambda item: (-item["likelihood"], item["filename"]))


def _classify_icons(media_files: list[dict]) -> list[dict]:
    grouped = defaultdict(list)
    for asset in media_files:
        asset["icon_group_id"] = None
        if asset["background_likelihood"] >= 0.7 or not asset["width"] or not asset["height"]:
            continue
        grouped[(asset["extension"], asset["width"], asset["height"])].append(asset)

    groups = []
    for (extension, width, height), assets in grouped.items():
        if len(assets) < 2:
            continue
        small_pixels = max(width, height) <= 600
        small_on_slide = any(
            source.get("placement", {}).get("width_ratio", 1) <= 0.25
            and source.get("placement", {}).get("height_ratio", 1) <= 0.25
            for asset in assets for source in asset["sources"]
        )
        if not (small_pixels or small_on_slide):
            continue
        group_id = f"icons_{len(groups) + 1:04d}"
        reason = "Повторяются формат и размер; изображения компактные" if small_pixels else "Повторяются формат и размер; небольшое размещение на слайде"
        for asset in assets:
            asset["icon_group_id"] = group_id
            asset["icon_reason"] = reason
        groups.append({
            "group_id": group_id,
            "extension": extension,
            "width": width,
            "height": height,
            "file_count": len(assets),
            "files": [asset["filename"] for asset in assets],
            "reason": reason,
        })
    return sorted(groups, key=lambda group: (-group["file_count"], group["width"], group["height"]))


def _svg_dimensions(data: bytes) -> tuple[int | None, int | None]:
    try:
        root = etree.fromstring(data)
        view_box = root.get("viewBox")
        if view_box:
            values = re.split(r"[\s,]+", view_box.strip())
            if len(values) == 4:
                return round(float(values[2])), round(float(values[3]))
        width = re.match(r"^([\d.]+)", root.get("width", ""))
        height = re.match(r"^([\d.]+)", root.get("height", ""))
        if width and height:
            return round(float(width.group(1))), round(float(height.group(1)))
    except (ValueError, etree.XMLSyntaxError):
        pass
    return None, None


def _build_exact_groups(media_files: list[dict]) -> list[dict]:
    grouped = defaultdict(list)
    for asset in media_files:
        grouped[asset["sha256"]].append(asset)

    groups = []
    index = 1
    for sha256, items in grouped.items():
        slides = set()
        for item in items:
            slides.update(item["slide_numbers"])

        groups.append({
            "group_id": f"exact_{index:04d}",
            "sha256": sha256,
            "files": [x["filename"] for x in items],
            "file_count": len(items),
            "occurrences": sum(x["occurrences"] for x in items),
            "slides_used": len(slides),
            "slide_numbers": sorted(slides),
        })
        index += 1

    groups.sort(key=lambda g: (-g["occurrences"], -g["file_count"], g["group_id"]))
    return groups


def _build_visual_groups(media_files: list[dict], max_distance: int = 4) -> list[dict]:
    # Simple connected-components clustering over raster pHash values.
    raster = [a for a in media_files if a.get("phash")]
    if not raster:
        return []

    parent = list(range(len(raster)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    hashes = [imagehash.hex_to_hash(a["phash"]) for a in raster]

    for i in range(len(raster)):
        for j in range(i + 1, len(raster)):
            if hashes[i] - hashes[j] <= max_distance:
                union(i, j)

    components = defaultdict(list)
    for i, asset in enumerate(raster):
        components[find(i)].append(asset)

    groups = []
    index = 1
    for items in components.values():
        slides = set()
        for item in items:
            slides.update(item["slide_numbers"])

        groups.append({
            "group_id": f"visual_{index:04d}",
            "files": [x["filename"] for x in items],
            "file_count": len(items),
            "occurrences": sum(x["occurrences"] for x in items),
            "slides_used": len(slides),
            "slide_numbers": sorted(slides),
            "phash_max_distance": max_distance,
        })
        index += 1

    groups.sort(key=lambda g: (-g["occurrences"], -g["file_count"], g["group_id"]))
    return groups


def _rels_path(source_part: str) -> str:
    directory = posixpath.dirname(source_part)
    filename = posixpath.basename(source_part)
    return f"{directory}/_rels/{filename}.rels"


def _resolve_target(source_part: str, target: str) -> str:
    target = unquote(target).replace("\\", "/")
    base = posixpath.dirname(source_part)
    return posixpath.normpath(posixpath.join(base, target)).lstrip("/")


def _slide_number(part: str) -> int | None:
    match = re.search(r"ppt/slides/slide(\d+)\.xml$", part)
    return int(match.group(1)) if match else None
