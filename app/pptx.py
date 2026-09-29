from pathlib import Path
from zipfile import ZipFile
from lxml import etree

class PPTXPackage:
    def __init__(self, path: Path):
        self.path = path
        self.zip = ZipFile(path, "r")
        self.files = set(self.zip.namelist())

    def exists(self, part: str) -> bool:
        return part in self.files

    def read(self, part: str) -> bytes:
        return self.zip.read(part)

    def xml(self, part: str) -> etree._Element:
        return etree.fromstring(self.read(part))

    def list(self, prefix: str) -> list[str]:
        return sorted(name for name in self.files if name.startswith(prefix))

    def close(self):
        self.zip.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
