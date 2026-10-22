"""Cut mascots off their pure-black backgrounds.

usage: python cutout.py <src.png> <out-stem> [<out-stem> ...]   (needs pillow, numpy, scipy)
Writes <out-stem>.png (1024 max side, trimmed) and <out-stem>.webp.
"""

import sys

import numpy as np
from PIL import Image
from scipy import ndimage

src, *stems = sys.argv[1:]
rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
m = rgb.max(2)

# Background: near-black pixels connected to the border. Bow ties and eyes are dark too, but
# they sit inside the sweet, so they never connect.
def border_connected(mask):
    labels, _ = ndimage.label(mask)
    ids = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    return np.isin(labels, ids[ids > 0])

strict = border_connected(m <= 8)
# The render glows dimly past its silhouette; take that halo too, but only right next to the
# true background and only where it is tinted like the sweet: the bow ties are neutral grey and
# poke past the outline.
warm = rgb[..., 0] - rgb[..., 2] >= 8
halo = (m <= 12) | ((m <= 45) & warm)
bg = strict | border_connected(halo & ndimage.binary_dilation(strict, iterations=8))

# Crevices along the outline (between boondi): black pockets the backdrop shows through that
# don't connect to it. Near the outline and ringed by the sweet's warm shading; a bow tie's own
# shadows are ringed by grey, so they stay.
near = ndimage.binary_dilation(bg, iterations=30)
labels, n = ndimage.label((m <= 30) & ~bg & near)
for i in range(1, n + 1):
    comp = labels == i
    ring = ndimage.binary_dilation(comp, iterations=3) & ~comp & ~bg
    if ring.any() and warm[ring].mean() > 0.6:
        bg |= comp

# Soft edge: the render darkens toward the silhouette, which reads as a black outline on light
# pages. Shave 1 px off the edge and feather the next 3 px.
fg = ~bg
dist = ndimage.distance_transform_edt(fg)
alpha = np.clip((dist - 1) / 3, 0, 1).astype(np.float32)
color = rgb
out = np.dstack([color, alpha * 255]).astype(np.uint8)

im = Image.fromarray(out, "RGBA")
im = im.crop(im.getbbox())
pad = int(max(im.size) * 0.02)
canvas = Image.new("RGBA", (im.width + 2 * pad, im.height + 2 * pad), (0, 0, 0, 0))
canvas.paste(im, (pad, pad))
canvas.thumbnail((1024, 1024), Image.LANCZOS)
for stem in stems:
    canvas.save(stem + ".png", optimize=True)
    canvas.save(stem + ".webp", quality=88, method=6)
print(src, canvas.size)
