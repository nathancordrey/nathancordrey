"""Build PhotoSwipe image descriptors without making album assets public.

Images always load through the existing Flask authorization and X-Accel routes.
Only dimensions are read from private files while rendering the page.
"""
from pathlib import Path

from PIL import Image, UnidentifiedImageError



def ensure_private_thumbnail(revision_dir: Path, number: int) -> bool:
    """Create a small cached JPEG under the private revisions directory.

    Cache invalidates when the spread source changes. The source is never
    overwritten and the thumbnail is never copied into Git/public static/.
    """
    import os
    import tempfile

    source_dir = revision_dir / "spreads"
    source = source_dir / ("spread-%02d.jpg" % number)
    if source.is_symlink() or not source.is_file():
        return False
    thumb_dir = revision_dir / "thumbs"
    if thumb_dir.is_symlink():
        return False
    thumb_dir.mkdir(mode=0o2750, exist_ok=True)
    thumb_dir.chmod(0o2750)
    target = thumb_dir / ("thumb-%02d.jpg" % number)
    if target.is_symlink():
        return False
    if target.is_file() and target.stat().st_mtime_ns >= source.stat().st_mtime_ns:
        return True
    temp_name = None
    try:
        with Image.open(source) as original:
            original.load()
            small = original.convert("RGB")
            small.thumbnail((420, 280), Image.Resampling.LANCZOS)
            if small.width <= 0 or small.height <= 0:
                return False
            with tempfile.NamedTemporaryFile(
                mode="wb", suffix=".jpg", prefix=".thumb-",
                dir=thumb_dir, delete=False,
            ) as temporary:
                temp_name = Path(temporary.name)
                small.save(temporary, format="JPEG", quality=78, optimize=True)
        temp_name.chmod(0o640)
        os.replace(temp_name, target)
        temp_name = None
        return True
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return False
    finally:
        if temp_name is not None:
            temp_name.unlink(missing_ok=True)


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
