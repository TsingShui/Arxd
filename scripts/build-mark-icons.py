#!/usr/bin/env python3
"""Rasterize the Arxd mono glyph (assets/rxd-mono.svg) into the PNG assets Expo needs.

The glyph is pure vector geometry, so it is rendered here with a tiny path
flattener and supersampled scanline filler instead of an external SVG
rasterizer. This keeps icon generation reproducible with the Python standard
library only, on any platform.

Usage: python3 scripts/build-mark-icons.py
"""

from __future__ import annotations

import math
import re
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
SOURCE = ASSETS / "rxd-mono.svg"

# Background and foreground pairs follow theme.ts: fire is the default palette.
DARK = (0x17, 0x16, 0x14)
WHITE = (0xFF, 0xFF, 0xFF)

SUPERSAMPLE = 4


def parse_path(d: str) -> list[list[tuple[float, float]]]:
    """Flatten an SVG path made of M/L/C/c/s/S/Z into closed polylines."""
    tokens = re.findall(r"[MLCScszZ]|-?\d*\.?\d+(?:e-?\d+)?", d)
    contours: list[list[tuple[float, float]]] = []
    points: list[tuple[float, float]] = []
    current = (0.0, 0.0)
    start = (0.0, 0.0)
    previous_control: tuple[float, float] | None = None
    command = ""
    index = 0

    def number() -> float:
        nonlocal index
        value = float(tokens[index])
        index += 1
        return value

    def cubic(c1, c2, end) -> None:
        steps = max(8, int(math.dist(current, end) / 2) + 8)
        for step in range(1, steps + 1):
            t = step / steps
            u = 1 - t
            x = u * u * u * current[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0]
            y = u * u * u * current[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1]
            points.append((x, y))

    while index < len(tokens):
        token = tokens[index]
        if token in "MLCScszZ":
            command = token
            index += 1
            if command in "Zz":
                if points:
                    contours.append(points)
                points = [start]
                current = start
                previous_control = None
                continue
        relative = command.islower()
        base = current if relative else (0.0, 0.0)
        upper = command.upper()
        if upper == "M":
            end = (base[0] + number(), base[1] + number())
            if points:
                contours.append(points)
            points = [end]
            start = current = end
            previous_control = None
            command = "l" if relative else "L"
        elif upper == "L":
            end = (base[0] + number(), base[1] + number())
            points.append(end)
            current = end
            previous_control = None
        elif upper == "C":
            c1 = (base[0] + number(), base[1] + number())
            c2 = (base[0] + number(), base[1] + number())
            end = (base[0] + number(), base[1] + number())
            cubic(c1, c2, end)
            current = end
            previous_control = c2
        elif upper == "S":
            if previous_control is None:
                c1 = current
            else:
                c1 = (2 * current[0] - previous_control[0], 2 * current[1] - previous_control[1])
            c2 = (base[0] + number(), base[1] + number())
            end = (base[0] + number(), base[1] + number())
            cubic(c1, c2, end)
            current = end
            previous_control = c2
        else:
            raise ValueError(f"unsupported path command {token!r} in {d!r}")
    if points:
        contours.append(points)
    return contours


def load_shapes() -> list[list[list[tuple[float, float]]]]:
    svg = SOURCE.read_text(encoding="utf-8")
    return [parse_path(d) for d in re.findall(r'<path d="([^"]+)"', svg)]


def contains(polygon: list[tuple[float, float]], x: float, y: float) -> bool:
    inside = False
    count = len(polygon)
    for i in range(count):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % count]
        if (y1 > y) != (y2 > y):
            crossing = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if crossing > x:
                inside = not inside
    return inside


def render(size: int, coverage_fraction: float, foreground, background) -> bytes:
    """Return RGBA pixel bytes with the glyph centered at the requested scale."""
    shapes = load_shapes()
    pixels = bytearray(size * size * 4)
    if background is None:
        pixels[3::4] = b"\x00" * (size * size)
    else:
        pixels[0::4] = bytes([background[0]]) * (size * size)
        pixels[1::4] = bytes([background[1]]) * (size * size)
        pixels[2::4] = bytes([background[2]]) * (size * size)
        pixels[3::4] = bytes([0xFF]) * (size * size)

    scale = size * coverage_fraction / 256.0
    offset = (size - 256.0 * scale) / 2.0
    step = 1.0 / SUPERSAMPLE
    total = SUPERSAMPLE * SUPERSAMPLE

    for contours in shapes:
        xs = [x for contour in contours for x, _ in contour]
        ys = [y for contour in contours for _, y in contour]
        left = max(0, int(math.floor(offset + min(xs) * scale)) - 1)
        right = min(size, int(math.ceil(offset + max(xs) * scale)) + 1)
        top = max(0, int(math.floor(offset + min(ys) * scale)) - 1)
        bottom = min(size, int(math.ceil(offset + max(ys) * scale)) + 1)
        for row in range(top, bottom):
            for column in range(left, right):
                hits = 0
                for sy in range(SUPERSAMPLE):
                    y = (row + (sy + 0.5) * step - offset) / scale
                    for sx in range(SUPERSAMPLE):
                        x = (column + (sx + 0.5) * step - offset) / scale
                        if any(contains(contour, x, y) for contour in contours):
                            hits += 1
                if not hits:
                    continue
                coverage = hits / total
                at = (row * size + column) * 4
                if background is None:
                    alpha = coverage
                    pixels[at : at + 3] = bytes(foreground)
                    pixels[at + 3] = max(pixels[at + 3], round(alpha * 255))
                else:
                    for channel in range(3):
                        pixels[at + channel] = round(
                            pixels[at + channel] * (1 - coverage) + foreground[channel] * coverage
                        )
    return bytes(pixels)


def write_png(path: Path, size: int, pixels: bytes) -> None:
    raw = b"".join(b"\x00" + pixels[row * size * 4 : (row + 1) * size * 4] for row in range(size))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    )


TARGETS = [
    # file, size, glyph coverage of the canvas, foreground, background
    ("icon.png", 1024, 0.78, WHITE, DARK),
    ("android-icon-foreground.png", 1024, 0.55, WHITE, None),
    ("android-icon-monochrome.png", 1024, 0.55, WHITE, None),
    ("splash-icon.png", 1024, 0.86, WHITE, None),
    ("favicon.png", 196, 0.72, WHITE, DARK),
]


def main() -> None:
    for name, size, fraction, foreground, background in TARGETS:
        write_png(ASSETS / name, size, render(size, fraction, foreground, background))
        print(f"wrote assets/{name} ({size}x{size})")
    background_pixels = bytes(DARK + (0xFF,)) * (1024 * 1024)
    write_png(ASSETS / "android-icon-background.png", 1024, background_pixels)
    print("wrote assets/android-icon-background.png (1024x1024 solid)")


if __name__ == "__main__":
    main()
