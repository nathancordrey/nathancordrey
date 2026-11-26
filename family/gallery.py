"""Build PhotoSwipe image descriptors without making album assets public.

Images always load through the existing Flask authorization and X-Accel routes.
Only dimensions are read from private files while rendering the page.
"""
from pathlib import Path

from PIL import Image, UnidentifiedImageError


def gallery_items(spreads_dir: Path, spread_count: int, url_for_spread):
    items = []
    for number in range(1, spread_count + 1):
        path = spreads_dir / ("spread-%02d.jpg" % number)
        if not path.is_file() or path.is_symlink():
            continue
        try:
            with Image.open(path) as image:
                width, height = image.size
        except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
            # A corrupt fixture/preview should not break the album page.
            # The image endpoint will still perform its usual checks.
            width, height = (2400, 1200)
        if width <= 0 or height <= 0:
            continue
        items.append({
            "number": number,
            "width": width,
            "height": height,
            "url": url_for_spread(number),
        })
    return items
