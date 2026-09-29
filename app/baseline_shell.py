"""Resolve slide shell templates for baseline graphic component previews."""

from __future__ import annotations

from typing import Any

from .circular_chart_inference import circular_instance_diameter_pt, cluster_circular_instances

TITLE_ZONE_MAX_Y = 0.22
SHELL_BOTTOM = 0.96
CONTENT_REGION_MARGIN = 0.018
GRAPHIC_KINDS = frozenset({"table", "chart", "diagram"})
REMOVABLE_CONTENT_KINDS = frozenset({"table", "chart", "diagram", "image"})
CIRCULAR_CHART_TYPES = frozenset({"pie", "doughnut"})
CIRCULAR_LEGEND_BAND_RATIO = 0.16
TITLE_TOP_MAX_Y = 0.18
TITLE_TOP_MIN_WIDTH = 0.45
FULLWIDTH_CONTENT_MIN = 0.55
FULLWIDTH_CONTENT_MIN_HEIGHT = 0.18
SPLIT_SIDE_MIN_WIDTH = 0.28
SPLIT_SIDE_MIN_HEIGHT = 0.25
SPLIT_LEFT_MAX_CENTER = 0.48
SPLIT_RIGHT_MIN_CENTER = 0.52
SPLIT_MAX_WIDTH = 0.58
CANVAS_SIDE_MARGIN = 0.04
CANVAS_FULL_WIDTH = 0.92
SPATIAL_HEATMAP_WEIGHTS = {
    "text_regions": 0.30,
    "image_regions": 0.15,
    "repeated_groups": 0.40,
    "safe_space": 0.15,
}


def _dense_projection_range(values: list[float], threshold_ratio: float = 0.45) -> tuple[int, int] | None:
    peak = max(values, default=0.0)
    if peak <= 0:
        return None
    threshold = peak * threshold_ratio
    active = [index for index, value in enumerate(values) if value >= threshold]
    if not active:
        return None
    return active[0], active[-1]


def infer_spatial_content_bbox(
    spatial: dict[str, Any] | None,
    content_margins: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    components = {
        component.get("id"): component
        for component in (spatial or {}).get("components") or []
    }
    sources: list[tuple[str, float, dict[str, Any]]] = []
    for component_id, weight in SPATIAL_HEATMAP_WEIGHTS.items():
        heatmap = (components.get(component_id) or {}).get("heatmap") or {}
        matrix = heatmap.get("free_ratios") if component_id == "safe_space" else heatmap.get("counts")
        if heatmap.get("cols") and heatmap.get("rows") and isinstance(matrix, list):
            sources.append((component_id, weight, heatmap))
    if len(sources) < 2:
        return None

    cols = int(sources[0][2]["cols"])
    rows = int(sources[0][2]["rows"])
    sources = [source for source in sources if source[2].get("cols") == cols and source[2].get("rows") == rows]
    if len(sources) < 2:
        return None
    weight_total = sum(weight for _, weight, _ in sources)
    scores = [[0.0 for _ in range(cols)] for _ in range(rows)]
    for component_id, weight, heatmap in sources:
        normalized_weight = weight / weight_total
        max_count = max(1.0, float(heatmap.get("max_count") or 1))
        for row in range(rows):
            for col in range(cols):
                if component_id == "safe_space":
                    value = 1.0 - float(heatmap["free_ratios"][row][col])
                else:
                    value = float(heatmap["counts"][row][col]) / max_count
                scores[row][col] += max(0.0, min(1.0, value)) * normalized_weight

    row_projection = [sum(row) / cols for row in scores]
    col_projection = [sum(scores[row][col] for row in range(rows)) / rows for col in range(cols)]
    row_range = _dense_projection_range(row_projection)
    col_range = _dense_projection_range(col_projection)
    if not row_range or not col_range:
        return None

    left = max(0.0, col_range[0] / cols - 0.5 / cols)
    right = min(1.0, (col_range[1] + 1) / cols + 0.5 / cols)
    top = max(0.0, row_range[0] / rows - 0.5 / rows)
    bottom = min(1.0, (row_range[1] + 1) / rows + 0.5 / rows)
    margins = content_margins or {}
    if margins.get("left_norm") is not None:
        left = max(left, float(margins["left_norm"]))
    if margins.get("right_norm") is not None:
        right = min(right, 1.0 - float(margins["right_norm"]))
    if margins.get("top_norm") is not None:
        top = max(top, float(margins["top_norm"]))
    if margins.get("bottom_norm") is not None:
        bottom = min(bottom, 1.0 - float(margins["bottom_norm"]))
    width = right - left
    height = bottom - top
    if width < 0.55 or height < 0.30:
        return None
    return {
        "x": round(left, 4),
        "y": round(top, 4),
        "width": round(width, 4),
        "height": round(height, 4),
        "confidence": round(min(1.0, len(sources) / len(SPATIAL_HEATMAP_WEIGHTS)), 3),
        "source_ids": [component_id for component_id, _, _ in sources],
    }


def attach_baseline_previews(
    catalog: dict[str, Any],
    slides: dict[str, Any] | None,
    shell_templates: list[dict[str, Any]] | None,
    spatial: dict[str, Any] | None = None,
    content_margins: dict[str, Any] | None = None,
) -> dict[str, Any]:
    catalog = dict(catalog or {})
    resolver = BaselineShellResolver(slides, shell_templates, spatial, content_margins)
    for key in ("tables", "charts", "diagrams"):
        catalog[key] = [
            {**item, "baseline_preview": resolver.resolve(item)}
            if item.get("is_baseline")
            else item
            for item in catalog.get(key) or []
        ]
    return catalog


def _circular_component_geometry(
    plot_region: dict[str, Any],
    slide: dict[str, Any],
    *,
    legend_band_ratio: float = CIRCULAR_LEGEND_BAND_RATIO,
) -> dict[str, dict[str, Any]]:
    slide_size = BaselineShellResolver._slide_size(slide)
    width = float(slide_size["width"])
    height = float(slide_size["height"])
    plot_width = float(plot_region.get("width") or 0)
    plot_height = float(plot_region.get("height") or 0)
    source_width_pt = plot_width * width
    source_height_pt = plot_height * height
    square_side_pt = min(source_width_pt, source_height_pt) if source_width_pt and source_height_pt else max(source_width_pt, source_height_pt, width * 0.14)
    square_width = square_side_pt / width
    square_height = square_side_pt / height
    plot_x = float(plot_region.get("x") or 0) + max(0.0, (plot_width - square_width) / 2)
    plot_y = float(plot_region.get("y") or 0) + max(0.0, (plot_height - square_height) / 2)
    legend_height = square_side_pt * legend_band_ratio / height
    total_height = square_height + legend_height
    box = {
        "x": plot_x,
        "y": plot_y,
        "width": square_width,
        "height": total_height,
    }
    return {
        "norm": {key: round(box[key], 4) for key in box},
        "pt": {
            "x_pt": round(box["x"] * width, 2),
            "y_pt": round(box["y"] * height, 2),
            "width_pt": round(box["width"] * width, 2),
            "height_pt": round(box["height"] * height, 2),
        },
        "plot_norm": {
            "x": 0.0,
            "y": 0.0,
            "width": 1.0,
            "height": round(square_height / max(total_height, 0.01), 4),
        },
        "legend_norm": {
            "x": 0.0,
            "y": round(square_height / max(total_height, 0.01), 4),
            "width": 1.0,
            "height": round(legend_height / max(total_height, 0.01), 4),
        },
    }


class BaselineShellResolver:
    def __init__(
        self,
        slides: dict[str, Any] | None,
        shell_templates: list[dict[str, Any]] | None,
        spatial: dict[str, Any] | None = None,
        content_margins: dict[str, Any] | None = None,
    ) -> None:
        self.slide_list = list((slides or {}).get("slides") or [])
        self.slide_map = {slide["slide_number"]: slide for slide in self.slide_list}
        self.shell_templates = list(shell_templates or [])
        self.spatial_content_bbox = infer_spatial_content_bbox(spatial, content_margins)
        self.title_content_gap_norm = float((content_margins or {}).get("title_content_gap_norm") or 0)

    def resolve(self, component: dict[str, Any]) -> dict[str, Any]:
        kind = str(component.get("kind") or "table")
        native_circular = self._find_native_circular_chart(component)
        if native_circular:
            return self._mark_full_chart_canvas(native_circular, component)
        circular = self._find_circular_chart_example(component)
        if circular:
            return self._mark_full_chart_canvas(circular, component)
        replaced = self._find_replaceable_graphic(component, kind)
        if replaced:
            return self._mark_full_chart_canvas(replaced, component)
        fullwidth = self._find_replaceable_fullwidth_content(component, kind)
        if fullwidth:
            return self._mark_full_chart_canvas(fullwidth, component)
        split = self._find_replaceable_split_graphic(component, kind)
        if split:
            return self._mark_full_chart_canvas(split, component)
        canvas = self._find_title_top_canvas(component, kind)
        if canvas:
            return self._mark_full_chart_canvas(canvas, component)
        shelled = self._find_title_only_shell(component, kind)
        if shelled:
            return self._mark_full_chart_canvas(shelled, component)
        return self._mark_full_chart_canvas(self._synthetic_preview(component, kind), component)

    def _find_native_circular_chart(self, component: dict[str, Any]) -> dict[str, Any] | None:
        requested = str(component.get("chart_type") or "").lower()
        if requested not in CIRCULAR_CHART_TYPES:
            return None
        candidates: list[tuple[int, float, dict[str, Any], dict[str, Any]]] = []
        for slide in self.slide_list:
            for element in slide.get("content_elements") or []:
                if element.get("kind") != "chart":
                    continue
                actual = str(element.get("chart_type") or (element.get("chart") or {}).get("type") or "").lower()
                if actual == "donut":
                    actual = "doughnut"
                if actual not in CIRCULAR_CHART_TYPES:
                    continue
                box = self._element_box(element)
                exact = int(actual == requested)
                candidates.append((exact, self._box_area(box), slide, element))
        if not candidates:
            return None
        _, _, slide, element = max(candidates, key=lambda item: (item[0], item[1], -item[2]["slide_number"]))
        geometry = _circular_component_geometry(
            self._element_box(element),
            slide,
            legend_band_ratio=float(
                ((component.get("style_tokens") or {}).get("circular_layout") or {}).get("legend_band_ratio")
                or CIRCULAR_LEGEND_BAND_RATIO
            ),
        )
        return {
            "match_strategy": "native_circular_chart",
            "slide_number": slide["slide_number"],
            "layout_source": slide.get("layout_source"),
            "layout_name": slide.get("layout_name"),
            "shell_id": self._shell_id_for_slide(slide),
            "geometry_norm": geometry["norm"],
            "geometry_pt": geometry["pt"],
            "plot_region_norm": geometry["plot_norm"],
            "legend_region_norm": geometry["legend_norm"],
            "replaced_element_id": element.get("element_id"),
            "score": 1000,
        }

    def _mark_full_chart_canvas(self, preview: dict[str, Any], component: dict[str, Any]) -> dict[str, Any]:
        chart_type = str(component.get("chart_type") or "").lower()
        if component.get("kind") == "chart" and chart_type not in CIRCULAR_CHART_TYPES:
            preview["chart_canvas_full"] = True
            bbox = self.spatial_content_bbox
            if bbox:
                slide = self.slide_map.get(preview.get("slide_number")) or {}
                size = self._slide_size(slide)
                adjusted_bbox = self._spatial_bbox_below_title(bbox, slide)
                preview["geometry_source"] = "spatial_heatmap"
                preview["spatial_bbox_confidence"] = bbox["confidence"]
                preview["spatial_bbox_sources"] = bbox["source_ids"]
                preview["geometry_norm"] = {
                    key: adjusted_bbox[key] for key in ("x", "y", "width", "height")
                }
                preview["geometry_pt"] = {
                    "x_pt": round(adjusted_bbox["x"] * size["width"], 2),
                    "y_pt": round(adjusted_bbox["y"] * size["height"], 2),
                    "width_pt": round(adjusted_bbox["width"] * size["width"], 2),
                    "height_pt": round(adjusted_bbox["height"] * size["height"], 2),
                }
        return preview

    def _spatial_bbox_below_title(
        self,
        bbox: dict[str, Any],
        slide: dict[str, Any],
    ) -> dict[str, Any]:
        adjusted = dict(bbox)
        if not self.title_content_gap_norm or not slide:
            return adjusted
        title = self._pick_top_title(slide.get("content_elements") or [])
        if not title:
            return adjusted
        title_box = self._element_box(title)
        required_top = title_box["y"] + title_box["height"] + self.title_content_gap_norm
        current_top = float(bbox.get("y") or 0)
        bottom = current_top + float(bbox.get("height") or 0)
        next_top = max(current_top, required_top)
        if bottom - next_top < 0.30:
            return adjusted
        adjusted["y"] = round(next_top, 4)
        adjusted["height"] = round(bottom - next_top, 4)
        adjusted["title_clearance_norm"] = round(self.title_content_gap_norm, 4)
        return adjusted

    def _find_circular_chart_example(self, component: dict[str, Any]) -> dict[str, Any] | None:
        chart_type = str(component.get("chart_type") or "").lower()
        if chart_type not in CIRCULAR_CHART_TYPES:
            return None

        candidates: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
        for slide in self.slide_list:
            for instance in slide.get("inferred_circular_charts") or []:
                has_metric = bool(instance.get("center_metric"))

                score = float(instance.get("confidence") or 0) * 100
                if has_metric:
                    score += 18
                if (instance.get("center_metric") or {}).get("unit") == "%":
                    score += 8
                if any(self._is_title_element(element) for element in slide.get("content_elements") or []):
                    score += 12
                score -= len(slide.get("inferred_circular_charts") or []) * 2
                candidates.append((score, slide, instance))

        if not candidates:
            return None

        clusters = cluster_circular_instances([item[2] for item in candidates])
        dominant = max(
            clusters,
            key=lambda cluster: (
                sum(circular_instance_diameter_pt(instance) for instance in cluster) / max(len(cluster), 1),
                len(cluster),
                sum(
                    score
                    for score, _, instance in candidates
                    if any(instance is member for member in cluster)
                ) / max(len(cluster), 1),
            ),
        )
        dominant_ids = {id(instance) for instance in dominant}
        dominant_candidates = [item for item in candidates if id(item[2]) in dominant_ids]
        score, slide, instance = max(dominant_candidates, key=lambda item: (item[0], item[1]["slide_number"]))
        geometry = _circular_component_geometry(
            instance.get("plot_region_norm") or {},
            slide,
            legend_band_ratio=float(
                ((component.get("style_tokens") or {}).get("circular_layout") or {}).get("legend_band_ratio")
                or CIRCULAR_LEGEND_BAND_RATIO
            ),
        )
        return {
            "match_strategy": "circular_chart_example",
            "slide_number": slide["slide_number"],
            "layout_source": slide.get("layout_source"),
            "layout_name": slide.get("layout_name"),
            "shell_id": self._shell_id_for_slide(slide),
            "geometry_norm": geometry["norm"],
            "geometry_pt": geometry["pt"],
            "plot_region_norm": geometry["plot_norm"],
            "legend_region_norm": geometry["legend_norm"],
            "circular_instance": {
                "chart_type_guess": instance.get("chart_type_guess"),
                "confidence": instance.get("confidence"),
                "center_metric": instance.get("center_metric"),
                "center_text": instance.get("center_text"),
                "source_plot_region_norm": instance.get("plot_region_norm"),
            },
            "consumed_element_ids": list(instance.get("consumed_element_ids") or []),
            "score": round(score, 2),
        }

    def _find_replaceable_graphic(self, component: dict[str, Any], kind: str) -> dict[str, Any] | None:
        candidates: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
        for slide in self.slide_list:
            graphics = [
                element
                for element in slide.get("content_elements") or []
                if element.get("kind") == kind
            ]
            if not graphics:
                continue
            if kind == "table" and component.get("table_source") == "inferred_grid":
                sources = {
                    (element.get("table") or {}).get("source")
                    for element in graphics
                }
                if sources == {"native"} and "inferred_grid" not in sources:
                    pass
            graphics.sort(
                key=lambda element: -(
                    (element.get("geometry_norm") or {}).get("width", 0)
                    * (element.get("geometry_norm") or {}).get("height", 0)
                )
            )
            element = graphics[0]
            score = self._replace_graphic_score(slide, kind, len(graphics))
            candidates.append((score, slide, element))

        if not candidates:
            return None

        score, slide, element = max(candidates, key=lambda item: (item[0], -item[1]["slide_number"]))
        geometry_norm = dict(element.get("geometry_norm") or {})
        geometry_pt = dict(element.get("geometry_pt") or {})
        return {
            "match_strategy": "replace_graphic",
            "slide_number": slide["slide_number"],
            "layout_source": slide.get("layout_source"),
            "layout_name": slide.get("layout_name"),
            "shell_id": self._shell_id_for_slide(slide),
            "geometry_norm": geometry_norm,
            "geometry_pt": geometry_pt,
            "replaced_element_id": element.get("element_id"),
            "score": round(score, 2),
        }

    def _find_replaceable_fullwidth_content(self, component: dict[str, Any], kind: str) -> dict[str, Any] | None:
        candidates: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
        for slide in self.slide_list:
            elements = slide.get("content_elements") or []
            title = self._pick_top_title(elements)
            if not title:
                continue
            title_box = self._element_box(title)
            removable = [
                element
                for element in elements
                if element.get("kind") in REMOVABLE_CONTENT_KINDS
                and not element.get("component_ref")
                and self._is_fullwidth_content(element, title_box)
            ]
            if not removable:
                continue
            removable.sort(
                key=lambda element: -(
                    self._box_area(self._element_box(element))
                )
            )
            element = removable[0]
            score = self._fullwidth_content_score(slide, element, title_box, len(removable))
            candidates.append((score, slide, element))

        if not candidates:
            return None

        score, slide, element = max(candidates, key=lambda item: (item[0], -item[1]["slide_number"]))
        return self._replace_content_preview(
            slide,
            element,
            "replace_fullwidth_content",
            score,
            kind,
            component,
        )

    def _find_replaceable_split_graphic(self, component: dict[str, Any], kind: str) -> dict[str, Any] | None:
        candidates: list[tuple[float, dict[str, Any], dict[str, Any], str]] = []
        for slide in self.slide_list:
            elements = slide.get("content_elements") or []
            title = self._pick_top_title(elements)
            for element in elements:
                if element.get("kind") not in REMOVABLE_CONTENT_KINDS:
                    continue
                if element.get("component_ref"):
                    continue
                side = self._split_side(element)
                if not side:
                    continue
                if self._is_fullwidth_content(element, self._element_box(title) if title else {"y": 0.0, "height": 0.0}):
                    continue
                if not self._split_has_opposite_text(elements, element, side, title):
                    continue
                score = self._split_graphic_score(slide, element, side, title)
                candidates.append((score, slide, element, side))

        if not candidates:
            return None

        score, slide, element, side = max(
            candidates,
            key=lambda item: (item[0], -item[1]["slide_number"]),
        )
        preview = self._replace_content_preview(
            slide,
            element,
            "replace_split_graphic",
            score,
            kind,
            component,
        )
        preview["split_side"] = side
        return preview

    def _find_title_top_canvas(self, component: dict[str, Any], kind: str) -> dict[str, Any] | None:
        candidates: list[tuple[float, dict[str, Any], dict[str, Any], dict[str, Any]]] = []
        for slide in self.slide_list:
            elements = slide.get("content_elements") or []
            title = self._pick_top_title(elements)
            if not title:
                continue
            title_box = self._element_box(title)
            blocking = [
                element
                for element in elements
                if not element.get("component_ref")
                and element.get("element_id") != title.get("element_id")
                and self._blocks_title_canvas(element, title_box)
            ]
            if any(
                element.get("kind") in REMOVABLE_CONTENT_KINDS
                and self._is_fullwidth_content(element, title_box)
                for element in blocking
            ):
                continue
            canvas = self._canvas_below_top_title(title_box)
            if canvas["height"] < 0.28 or canvas["width"] < 0.55:
                continue
            score = self._title_top_canvas_score(title_box, canvas, blocking)
            geometry = self._fit_geometry_in_region(canvas, kind, slide, component)
            candidates.append((score, slide, canvas, geometry))

        if not candidates:
            return None

        score, slide, canvas, geometry = max(
            candidates,
            key=lambda item: (item[0], -item[1]["slide_number"]),
        )
        return {
            "match_strategy": "title_top_canvas",
            "slide_number": slide["slide_number"],
            "layout_source": slide.get("layout_source"),
            "layout_name": slide.get("layout_name"),
            "shell_id": self._shell_id_for_slide(slide),
            "content_region": canvas,
            "geometry_norm": geometry["norm"],
            "geometry_pt": geometry["pt"],
            "score": round(score, 2),
        }

    def _replace_content_preview(
        self,
        slide: dict[str, Any],
        element: dict[str, Any],
        strategy: str,
        score: float,
        kind: str,
        component: dict[str, Any],
    ) -> dict[str, Any]:
        box = self._element_box(element)
        geometry = self._fit_geometry_in_region(box, kind, slide, component)
        return {
            "match_strategy": strategy,
            "slide_number": slide["slide_number"],
            "layout_source": slide.get("layout_source"),
            "layout_name": slide.get("layout_name"),
            "shell_id": self._shell_id_for_slide(slide),
            "geometry_norm": geometry["norm"],
            "geometry_pt": geometry["pt"],
            "replaced_element_id": element.get("element_id"),
            "replaced_element_kind": element.get("kind"),
            "score": round(score, 2),
        }

    def _find_title_only_shell(self, component: dict[str, Any], kind: str) -> dict[str, Any] | None:
        candidates: list[tuple[float, dict[str, Any], dict[str, Any], dict[str, Any]]] = []
        for shell in self.shell_templates:
            preview_number = shell.get("preview_slide")
            preview_slide = self.slide_map.get(preview_number)
            content_region = shell.get("content_region") or {}
            if not preview_slide or not content_region.get("width"):
                continue
            score = self._title_only_shell_score(preview_slide, shell)
            geometry = self._fit_geometry_in_region(content_region, kind, preview_slide, component)
            candidates.append((score, shell, preview_slide, geometry))

        if not candidates:
            return None

        score, shell, slide, geometry = max(
            candidates,
            key=lambda item: (item[0], item[1].get("slide_count") or 0, -item[2]["slide_number"]),
        )
        return {
            "match_strategy": "title_only_shell",
            "slide_number": slide["slide_number"],
            "layout_source": shell.get("layout_source"),
            "layout_name": shell.get("layout_name") or slide.get("layout_name"),
            "shell_id": shell.get("shell_id"),
            "content_region": content_region if (content_region := shell.get("content_region")) else {},
            "geometry_norm": geometry["norm"],
            "geometry_pt": geometry["pt"],
            "score": round(score, 2),
        }

    def _synthetic_preview(self, component: dict[str, Any], kind: str) -> dict[str, Any]:
        slide_size = self._default_slide_size()
        chart_type = str(component.get("chart_type") or "").lower()
        if kind == "chart" and chart_type in CIRCULAR_CHART_TYPES:
            geometry_norm = dict(component.get("default_geometry_norm") or {})
            legend_ratio = float(
                ((component.get("style_tokens") or {}).get("circular_layout") or {}).get("legend_band_ratio")
                or CIRCULAR_LEGEND_BAND_RATIO
            )
            geometry_pt = component.get("default_geometry_pt") or {}
            diameter_pt = min(
                float(geometry_pt.get("width_pt") or float(geometry_norm.get("width") or 0) * slide_size["width"]),
                float(geometry_pt.get("height_pt") or float(geometry_norm.get("height") or 0) * slide_size["height"]),
            ) or slide_size["height"] * 0.42
            square_width = diameter_pt / slide_size["width"]
            square_height = diameter_pt / slide_size["height"]
            legend_height = square_height * legend_ratio
            total_height = square_height + legend_height
            x = (1 - square_width) / 2
            y = (1 - total_height) / 2
            geometry_norm = {
                "x": round(max(0.0, x), 4),
                "y": round(max(TITLE_ZONE_MAX_Y, y), 4),
                "width": round(square_width, 4),
                "height": round(total_height, 4),
            }
            return {
                "match_strategy": "synthetic",
                "slide_number": None,
                "layout_source": None,
                "layout_name": None,
                "shell_id": None,
                "geometry_norm": geometry_norm,
                "geometry_pt": {
                    "x_pt": round(geometry_norm["x"] * slide_size["width"], 2),
                    "y_pt": round(geometry_norm["y"] * slide_size["height"], 2),
                    "width_pt": round(geometry_norm["width"] * slide_size["width"], 2),
                    "height_pt": round(geometry_norm["height"] * slide_size["height"], 2),
                },
                "plot_region_norm": {
                    "x": 0.0,
                    "y": 0.0,
                    "width": 1.0,
                    "height": round(square_height / max(total_height, 0.01), 4),
                },
                "legend_region_norm": {
                    "x": 0.0,
                    "y": round(square_height / max(total_height, 0.01), 4),
                    "width": 1.0,
                    "height": round(legend_height / max(total_height, 0.01), 4),
                },
                "score": 0,
            }

        width_pt = slide_size["width"] * 0.62
        height_pt = slide_size["height"] * (0.42 if kind == "table" else 0.48)
        x_pt = (slide_size["width"] - width_pt) / 2
        y_pt = (slide_size["height"] - height_pt) / 2
        geometry_norm = {
            "x": round(x_pt / slide_size["width"], 4),
            "y": round(y_pt / slide_size["height"], 4),
            "width": round(width_pt / slide_size["width"], 4),
            "height": round(height_pt / slide_size["height"], 4),
        }
        return {
            "match_strategy": "synthetic",
            "slide_number": None,
            "layout_source": None,
            "layout_name": None,
            "shell_id": None,
            "geometry_norm": geometry_norm,
            "geometry_pt": {
                "x_pt": round(x_pt, 2),
                "y_pt": round(y_pt, 2),
                "width_pt": round(width_pt, 2),
                "height_pt": round(height_pt, 2),
            },
            "score": 0,
        }

    def _replace_graphic_score(self, slide: dict[str, Any], kind: str, graphic_count: int) -> float:
        elements = slide.get("content_elements") or []
        title_elements = [element for element in elements if self._is_title_element(element)]
        other_text = [
            element
            for element in elements
            if element.get("kind") == "text"
            and not self._is_title_element(element)
            and not element.get("component_ref")
        ]
        other_graphics = [
            element
            for element in elements
            if element.get("kind") in GRAPHIC_KINDS and element.get("kind") != kind
        ]
        component_instances = len(slide.get("component_instances") or [])

        score = 0.0
        if title_elements:
            score += 40
        if graphic_count == 1:
            score += 35
        else:
            score -= (graphic_count - 1) * 12
        score -= len(other_text) * 6
        score -= len(other_graphics) * 8
        score -= component_instances * 4
        score += min(len(title_elements), 1) * 5
        return score

    def _title_only_shell_score(self, preview_slide: dict[str, Any], shell: dict[str, Any]) -> float:
        score = float(shell.get("slide_count") or 0)
        region = shell.get("content_region") or {}
        score += (region.get("width") or 0) * 20
        score += (region.get("height") or 0) * 15

        if (region.get("width") or 0) < 0.72:
            score -= 40
        if (region.get("height") or 0) < 0.38:
            score -= 35
        if (region.get("y") or 0) > 0.42:
            score -= 30

        residual = [
            element
            for element in preview_slide.get("content_elements") or []
            if not self._is_title_element(element) and not element.get("component_ref")
        ]
        if not residual:
            score += 55
        else:
            score -= len(residual) * 10
            if any(element.get("kind") in GRAPHIC_KINDS for element in residual):
                score -= 25

        if self._pick_top_title(preview_slide.get("content_elements") or []):
            score += 18
        else:
            score -= 50

        if self._is_title_element(next(iter(preview_slide.get("content_elements") or []), {})):
            score += 10
        return score

    def _fit_geometry_in_region(
        self,
        region: dict[str, Any],
        kind: str,
        slide: dict[str, Any],
        component: dict[str, Any] | None = None,
    ) -> dict[str, dict[str, Any]]:
        slide_size = self._slide_size(slide)
        width = float(slide_size["width"])
        height = float(slide_size["height"])
        chart_type = str((component or {}).get("chart_type") or "").lower()
        is_cartesian_chart = kind == "chart" and chart_type not in CIRCULAR_CHART_TYPES
        pad_x = 0 if is_cartesian_chart else region["width"] * 0.03
        pad_y = 0 if is_cartesian_chart else region["height"] * 0.04
        box = {
            "x": region["x"] + pad_x,
            "y": region["y"] + pad_y,
            "width": max(0.08, region["width"] - pad_x * 2),
            "height": max(0.08, region["height"] - pad_y * 2),
        }
        if kind == "table":
            box["height"] = min(box["height"], region["height"] * 0.78)
        elif kind == "chart":
            if chart_type in CIRCULAR_CHART_TYPES:
                legend_ratio = float(
                    (((component or {}).get("style_tokens") or {}).get("circular_layout") or {}).get("legend_band_ratio")
                    or CIRCULAR_LEGEND_BAND_RATIO
                )
                side_pt = min(box["width"] * width, box["height"] * height / (1 + legend_ratio))
                side_width = side_pt / width
                side_height = side_pt / height
                total_height = side_height * (1 + legend_ratio)
                box = {
                    "x": region["x"] + (region["width"] - side_width) / 2,
                    "y": region["y"] + max(pad_y, (region["height"] - total_height) / 2),
                    "width": side_width,
                    "height": total_height,
                }
        return {
            "norm": {key: round(box[key], 4) for key in box},
            "pt": {
                "x_pt": round(box["x"] * width, 2),
                "y_pt": round(box["y"] * height, 2),
                "width_pt": round(box["width"] * width, 2),
                "height_pt": round(box["height"] * height, 2),
            },
        }

    def _fullwidth_content_score(
        self,
        slide: dict[str, Any],
        element: dict[str, Any],
        title_box: dict[str, float],
        removable_count: int,
    ) -> float:
        box = self._element_box(element)
        score = self._box_area(box) * 120
        score += 35 if title_box.get("width", 0) >= 0.7 else 20
        if element.get("kind") in {"table", "chart"}:
            score += 8
        score -= max(0, removable_count - 1) * 6
        score -= self._count_non_title_text(slide) * 10
        return score

    def _split_graphic_score(
        self,
        slide: dict[str, Any],
        element: dict[str, Any],
        side: str,
        title: dict[str, Any] | None,
    ) -> float:
        score = self._box_area(self._element_box(element)) * 90
        if title:
            score += 25
        score += 15
        score -= self._count_non_title_text(slide) * 8
        score -= side == "left" and 0 or 0
        return score

    def _title_top_canvas_score(
        self,
        title_box: dict[str, float],
        canvas: dict[str, float],
        blocking: list[dict[str, Any]],
    ) -> float:
        score = self._box_area(canvas) * 100
        score += 30 if title_box.get("width", 0) >= 0.7 else 15
        for element in blocking:
            area = self._box_area(self._element_box(element))
            if area < 0.02:
                score -= 2
            elif element.get("kind") == "text":
                score -= 12
            else:
                score -= 8
        return score

    def _count_non_title_text(self, slide: dict[str, Any]) -> int:
        return len([
            element
            for element in slide.get("content_elements") or []
            if element.get("kind") == "text"
            and not self._is_title_element(element)
            and not element.get("component_ref")
        ])

    def _pick_top_title(self, elements: list[dict[str, Any]]) -> dict[str, Any] | None:
        candidates = [element for element in elements if self._is_top_title(element)]
        if not candidates:
            return None
        return max(
            candidates,
            key=lambda element: (
                self._box_area(self._element_box(element)),
                -(self._element_box(element).get("y") or 1),
            ),
        )

    def _is_top_title(self, element: dict[str, Any]) -> bool:
        if element.get("kind") != "text" or element.get("component_ref"):
            return False
        box = self._element_box(element)
        role = str(
            element.get("placeholder_type")
            or element.get("text_role")
            or element.get("role")
            or element.get("name")
            or ""
        ).lower()
        if role in {"title", "ctrtitle", "ctr_title"} and box["y"] < TITLE_ZONE_MAX_Y:
            return True
        return box["y"] < TITLE_TOP_MAX_Y and box["width"] >= TITLE_TOP_MIN_WIDTH

    def _element_box(self, element: dict[str, Any] | None) -> dict[str, float]:
        geometry = (element or {}).get("geometry_norm") or {}
        return {
            "x": float(geometry.get("x") or 0),
            "y": float(geometry.get("y") or 0),
            "width": float(geometry.get("width") or 0),
            "height": float(geometry.get("height") or 0),
        }

    @staticmethod
    def _box_area(box: dict[str, float]) -> float:
        return max(0.0, box.get("width") or 0) * max(0.0, box.get("height") or 0)

    def _is_fullwidth_content(self, element: dict[str, Any], title_box: dict[str, float]) -> bool:
        box = self._element_box(element)
        if box["width"] < FULLWIDTH_CONTENT_MIN or box["height"] < FULLWIDTH_CONTENT_MIN_HEIGHT:
            return False
        title_bottom = title_box.get("y", 0) + title_box.get("height", 0)
        return box["y"] >= title_bottom - 0.05

    def _split_side(self, element: dict[str, Any]) -> str | None:
        box = self._element_box(element)
        if box["width"] > SPLIT_MAX_WIDTH or box["width"] < SPLIT_SIDE_MIN_WIDTH:
            return None
        if box["height"] < SPLIT_SIDE_MIN_HEIGHT:
            return None
        center_x = box["x"] + box["width"] / 2
        if center_x <= SPLIT_LEFT_MAX_CENTER:
            return "left"
        if center_x >= SPLIT_RIGHT_MIN_CENTER:
            return "right"
        return None

    def _split_has_opposite_text(
        self,
        elements: list[dict[str, Any]],
        graphic: dict[str, Any],
        side: str,
        title: dict[str, Any] | None,
    ) -> bool:
        graphic_box = self._element_box(graphic)
        title_id = title.get("element_id") if title else None
        for element in elements:
            if element.get("kind") != "text" or element.get("component_ref"):
                continue
            if element.get("element_id") == title_id:
                continue
            if title and self._is_top_title(element):
                continue
            box = self._element_box(element)
            center_x = box["x"] + box["width"] / 2
            if side == "left" and center_x >= SPLIT_RIGHT_MIN_CENTER:
                return True
            if side == "right" and center_x <= SPLIT_LEFT_MAX_CENTER:
                return True
            overlap_y = min(graphic_box["y"] + graphic_box["height"], box["y"] + box["height"]) - max(graphic_box["y"], box["y"])
            if overlap_y <= graphic_box["height"] * 0.25:
                continue
            if side == "left" and center_x > graphic_box["x"] + graphic_box["width"]:
                return True
            if side == "right" and center_x < graphic_box["x"]:
                return True
        return False

    def _blocks_title_canvas(self, element: dict[str, Any], title_box: dict[str, float]) -> bool:
        if element.get("kind") == "text" and self._is_top_title(element):
            return False
        box = self._element_box(element)
        canvas_top = title_box["y"] + title_box["height"] + CONTENT_REGION_MARGIN
        if box["y"] + box["height"] <= canvas_top + 0.01:
            return self._box_area(box) >= 0.02
        return True

    def _canvas_below_top_title(self, title_box: dict[str, float]) -> dict[str, float]:
        y = min(SHELL_BOTTOM - 0.08, title_box["y"] + title_box["height"] + CONTENT_REGION_MARGIN)
        if title_box["width"] >= 0.6:
            x = CANVAS_SIDE_MARGIN
            width = CANVAS_FULL_WIDTH
        else:
            x = max(CANVAS_SIDE_MARGIN, title_box["x"])
            width = min(CANVAS_FULL_WIDTH, max(title_box["width"], 0.72))
        return {
            "x": round(x, 4),
            "y": round(y, 4),
            "width": round(width, 4),
            "height": round(max(0.08, SHELL_BOTTOM - y), 4),
        }

    def _shell_id_for_slide(self, slide: dict[str, Any]) -> str | None:
        layout_source = slide.get("layout_source")
        for shell in self.shell_templates:
            if shell.get("layout_source") == layout_source:
                return shell.get("shell_id")
        return None

    def _default_slide_size(self) -> dict[str, float]:
        for slide in self.slide_list:
            size = self._slide_size(slide)
            if size["width"] and size["height"]:
                return size
        return {"width": 960.0, "height": 540.0}

    @staticmethod
    def _slide_size(slide: dict[str, Any]) -> dict[str, float]:
        size = (slide.get("render") or {}).get("slide_size_pt") or {}
        return {
            "width": float(size.get("width") or 960),
            "height": float(size.get("height") or 540),
        }

    @staticmethod
    def _is_title_element(element: dict[str, Any]) -> bool:
        if element.get("kind") != "text":
            return False
        geometry = element.get("geometry_norm") or {}
        if float(geometry.get("y") or 1) >= TITLE_ZONE_MAX_Y:
            return False
        role = str(
            element.get("placeholder_type")
            or element.get("text_role")
            or element.get("role")
            or element.get("name")
            or ""
        ).lower()
        if role in {"title", "ctrtitle", "ctr_title"}:
            return True
        return float(geometry.get("y") or 1) < 0.16
