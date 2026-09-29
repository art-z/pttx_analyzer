import unittest

from app.line_height import line_height_applicable


class LineHeightApplicableTest(unittest.TestCase):
    def test_display_number_ratio_is_not_applicable(self):
        self.assertFalse(line_height_applicable(0.643, size_pt=14.0))
        self.assertFalse(line_height_applicable(0.162, size_pt=48.0))

    def test_body_ratios_remain_applicable(self):
        self.assertTrue(line_height_applicable(0.9, size_pt=14.0))
        self.assertTrue(line_height_applicable(1.0, size_pt=14.0))
        self.assertTrue(line_height_applicable(1.1, size_pt=16.0))

    def test_resolves_from_points(self):
        self.assertTrue(line_height_applicable(size_pt=14.0, line_height_pt=14.0))
        self.assertFalse(line_height_applicable(size_pt=14.0, line_height_pt=8.96))


if __name__ == "__main__":
    unittest.main()
