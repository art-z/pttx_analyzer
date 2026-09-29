"""Slide bounds and shape visibility helpers."""

from .pptx import PPTXPackage

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
EMU_PER_PT = 12700


def slide_size_pt(package: PPTXPackage) -> tuple[float, float] | None:
    if not package.exists("ppt/presentation.xml"):
        return None
    size = package.xml("ppt/presentation.xml").find("p:sldSz", NS)
    if size is None:
        return None
    try:
        return int(size.get("cx")) / EMU_PER_PT, int(size.get("cy")) / EMU_PER_PT
    except (TypeError, ValueError):
        return None


def shape_geometry(shape) -> dict | None:
    if shape is None:
        return None
    transform = shape.find("p:spPr/a:xfrm", NS)
    if transform is None:
        return None
    off = transform.find("a:off", NS)
    ext = transform.find("a:ext", NS)
    if off is None or ext is None:
        return None
    try:
        return {
            key: round(int(value) / EMU_PER_PT, 2)
            for key, value in {
                "x_pt": off.get("x"),
                "y_pt": off.get("y"),
                "width_pt": ext.get("cx"),
                "height_pt": ext.get("cy"),
            }.items()
        }
    except (TypeError, ValueError):
        return None


def geometry_coverage(geometry: dict, slide_size: tuple[float, float]) -> float:
    slide_width, slide_height = slide_size
    if slide_width <= 0 or slide_height <= 0:
        return 0.0
    x = geometry["x_pt"]
    y = geometry["y_pt"]
    width = geometry["width_pt"]
    height = geometry["height_pt"]
    if width <= 0 or height <= 0:
        return 0.0
    visible_width = max(0.0, min(x + width, slide_width) - max(x, 0.0))
    visible_height = max(0.0, min(y + height, slide_height) - max(y, 0.0))
    return round((visible_width * visible_height) / (slide_width * slide_height), 4)


def is_within_slide(geometry: dict | None, slide_size: tuple[float, float] | None, min_coverage: float = 0.001) -> bool:
    if geometry is None or slide_size is None:
        return False
    return geometry_coverage(geometry, slide_size) >= min_coverage


def is_shape_visible(shape) -> bool:
    node = shape
    while node is not None:
        tag = node.tag.rsplit("}", 1)[-1]
        if tag in {"sp", "grpSp", "graphicFrame"}:
            hidden = node.find("p:nvSpPr/p:cNvPr", NS)
            if hidden is None:
                hidden = node.find("p:nvGraphicFramePr/p:cNvPr", NS)
            if hidden is not None and hidden.get("hidden") in {"1", "true", "True"}:
                return False
        node = node.getparent()
    return True


def shape_for_element(element):
    node = element
    while node is not None:
        tag = node.tag.rsplit("}", 1)[-1]
        if tag == "sp":
            return node
        node = node.getparent()
    return None


def visible_shape_context(element, slide_size: tuple[float, float] | None, min_coverage: float = 0.001):
    shape = shape_for_element(element)
    if shape is None or not is_shape_visible(shape):
        return None
    geometry = shape_geometry(shape)
    if not is_within_slide(geometry, slide_size, min_coverage):
        return None
    coverage = geometry_coverage(geometry, slide_size) if geometry and slide_size else 0.0
    return shape, geometry, coverage


def has_visible_slide_text(package: PPTXPackage, slide_size: tuple[float, float] | None) -> bool:
    for part in package.list("ppt/slides/"):
        if not part.endswith(".xml"):
            continue
        root = package.xml(part)
        for run in root.findall(".//a:r", NS):
            text = run.find("a:t", NS)
            if text is None or not (text.text or "").strip():
                continue
            if visible_shape_context(run, slide_size) is not None:
                return True
    return False
