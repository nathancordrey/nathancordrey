"""Export private, EXIF-free spread JPGs from an approved album review PDF.

Run OFF-SERVER on a trusted computer with PyMuPDF + Pillow installed:
 python family/scripts/export_spreads.py \
   --revision 2 --input /private/path/revision-2-review.pdf \
   --output-root /private/path/family-asset-export

Generates revision-2/spreads/spread-01.jpg etc.
Keep originals and output files outside the public Git checkout / web root.
"""
import argparse
from pathlib import Path

import fitz
from PIL import Image


SPREAD_COUNT = {1: 18, 2: 20}


def export(revision: int, source: Path, root: Path, max_width: int = 3200):
    if revision not in SPREAD_COUNT:
        raise ValueError("Unknown revision")
    if not source.is_file() or source.suffix.lower() != ".pdf":
        raise ValueError("Source must be a local PDF")
    if max_width < 1200 or max_width > 4000:
        raise ValueError("max-width must be between 1200 and 4000")
    destination = root / ("revision-%d" % revision) / "spreads"
    if destination.exists() and any(destination.iterdir()):
        raise FileExistsError("Refusing to overwrite an existing non-empty spread directory")
    with fitz.open(source) as doc:
        if len(doc) != SPREAD_COUNT[revision]:
            raise ValueError("Expected %d spreads, got %d" % (SPREAD_COUNT[revision], len(doc)))
        destination.mkdir(parents=True, exist_ok=True)
        for index, page in enumerate(doc, start=1):
            scale = max_width / page.rect.width
            image_data = page.get_pixmap(
                matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False
            )
            image = Image.frombytes(
                "RGB", (image_data.width, image_data.height), image_data.samples
            )
            target = destination / ("spread-%02d.jpg" % index)
            image.save(target, "JPEG", quality=85, optimize=True)
            # Rasterizing removes source metadata. Verify no EXIF is in the output.
            with Image.open(target) as checked:
                if checked.getexif():
                    raise ValueError("Metadata was unexpectedly retained in " + str(target))
            print(target, image_data.width, image_data.height)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", type=int, choices=sorted(SPREAD_COUNT), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--max-width", type=int, default=3200)
    args = parser.parse_args()
    export(args.revision, args.input, args.output_root, args.max_width)


if __name__ == "__main__":
    main()
