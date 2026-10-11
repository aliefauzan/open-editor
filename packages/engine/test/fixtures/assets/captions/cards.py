"""Draw the burnt-in caption cards of `style-extract-10s.mp4` (plan phase 15, R7).

The Homebrew ffmpeg has no `drawtext` (D-17), so the captions are checked-in PNG cards that
`make.sh` overlays. Run once from the repo root when the card text changes:

    uv run --project py python -I packages/engine/test/fixtures/assets/captions/cards.py

Each card is white upper-case sans text on a near-black box, 960 px wide, transparent outside the box.
"""

from __future__ import annotations

import sys
from pathlib import Path

import AppKit

CARDS = ["EMPIRES RISE FAST", "BORDERS MOVE TOO", "MAPS TELL STORIES"]
WIDTH, HEIGHT = 960, 150
FONT = ("Helvetica-Bold", 84)
BOX = (0.08, 0.08, 0.08, 0.92)


def draw(text: str, out: Path) -> None:
    rep = AppKit.NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
        None, WIDTH, HEIGHT, 8, 4, True, False, AppKit.NSDeviceRGBColorSpace, 0, 0
    )
    ctx = AppKit.NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep)
    AppKit.NSGraphicsContext.saveGraphicsState()
    AppKit.NSGraphicsContext.setCurrentContext_(ctx)
    AppKit.NSColor.clearColor().set()
    AppKit.NSRectFill(((0, 0), (WIDTH, HEIGHT)))
    AppKit.NSColor.colorWithDeviceRed_green_blue_alpha_(*BOX).set()
    AppKit.NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(
        ((0, 0), (WIDTH, HEIGHT)), 18, 18
    ).fill()
    attrs = {
        AppKit.NSFontAttributeName: AppKit.NSFont.fontWithName_size_(*FONT),
        AppKit.NSForegroundColorAttributeName: AppKit.NSColor.whiteColor(),
    }
    s = AppKit.NSAttributedString.alloc().initWithString_attributes_(text, attrs)
    w, h = s.size()
    s.drawAtPoint_(((WIDTH - w) / 2, (HEIGHT - h) / 2))
    AppKit.NSGraphicsContext.restoreGraphicsState()
    data = rep.representationUsingType_properties_(AppKit.NSBitmapImageFileTypePNG, {})
    data.writeToFile_atomically_(str(out), True)


def main() -> int:
    here = Path(__file__).resolve().parent
    for i, text in enumerate(CARDS, start=1):
        draw(text, here / f"card-{i}.png")
    print(f"wrote {len(CARDS)} cards to {here}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
