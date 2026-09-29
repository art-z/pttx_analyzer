import base64
import unittest
import zipfile
from io import BytesIO

from app.slides_export import build_pptx_from_slide_images, decode_data_url

PNG_1X1 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class SlidesExportTest(unittest.TestCase):
    def test_decode_data_url(self):
        payload = decode_data_url(PNG_1X1)
        self.assertTrue(payload.startswith(b"\x89PNG"))

    def test_build_pptx_from_slide_images(self):
        pptx_bytes = build_pptx_from_slide_images([PNG_1X1, PNG_1X1], 960, 540)
        with zipfile.ZipFile(BytesIO(pptx_bytes)) as archive:
            slide_parts = [name for name in archive.namelist() if name.startswith("ppt/slides/slide") and name.endswith(".xml")]
        self.assertEqual(len(slide_parts), 2)
