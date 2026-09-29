import unittest

from app.structure_clustering import (
    cluster_instances_by_structure,
    instances_structurally_compatible,
    role_signature,
)


def _card_instance(slide_number: int, index: int, extra_image: bool = False) -> dict:
    slots = [
        {"role": "image", "kind": "image", "cx_norm": 0.5, "cy_norm": 0.2, "width_norm": 0.4, "height_norm": 0.35},
        {"role": "title", "kind": "text", "cx_norm": 0.5, "cy_norm": 0.55, "width_norm": 0.8, "height_norm": 0.12},
        {"role": "body", "kind": "text", "cx_norm": 0.5, "cy_norm": 0.78, "width_norm": 0.8, "height_norm": 0.12},
    ]
    if extra_image:
        slots.append(
            {"role": "image", "kind": "image", "cx_norm": 0.85, "cy_norm": 0.85, "width_norm": 0.2, "height_norm": 0.15},
        )
    return {
        "slide_number": slide_number,
        "group_index": index,
        "container": {"x_pt": 50 + index * 220, "y_pt": 100, "width_pt": 212, "height_pt": 166},
        "item_width_pt": 212,
        "item_height_pt": 166,
        "slots": slots,
    }


def _icon_instance(slide_number: int, index: int) -> dict:
    return {
        "slide_number": slide_number,
        "group_index": index,
        "container": {"x_pt": 20 + index * 30, "y_pt": 200, "width_pt": 24, "height_pt": 24},
        "item_width_pt": 24,
        "item_height_pt": 24,
        "slots": [
            {"role": "icon", "kind": "icon", "cx_norm": 0.5, "cy_norm": 0.5, "width_norm": 0.8, "height_norm": 0.8},
        ],
    }


class StructureClusteringTests(unittest.TestCase):
    def test_six_cards_with_one_extra_image_cluster_together(self):
        base_cards = [_card_instance(5, index) for index in range(1, 6)]
        variant_card = _card_instance(5, 6, extra_image=True)
        instances = base_cards + [variant_card]

        self.assertTrue(instances_structurally_compatible(base_cards[0], variant_card))

        clusters = cluster_instances_by_structure(instances)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]), 6)

    def test_forty_icons_form_one_component(self):
        instances = [_icon_instance(7, index) for index in range(1, 41)]
        clusters = cluster_instances_by_structure(instances)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]), 40)
        self.assertTrue(role_signature(clusters[0][0]["slots"]).startswith("icon:icon"))

    def test_different_structures_stay_separate(self):
        cards = [_card_instance(1, 1), _card_instance(1, 2)]
        icons = [_icon_instance(1, 3), _icon_instance(1, 4)]
        clusters = cluster_instances_by_structure(cards + icons)
        self.assertEqual(len(clusters), 2)
        sizes = sorted(len(cluster) for cluster in clusters)
        self.assertEqual(sizes, [2, 2])


if __name__ == "__main__":
    unittest.main()
