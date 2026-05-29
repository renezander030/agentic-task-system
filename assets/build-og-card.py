#!/usr/bin/env python3
"""Generate the social-preview / OG card for Agentic Task System.

Reproducible: renders assets/logo.svg (via rsvg-convert) and composites the
brand lockup, thesis tagline, and install command onto a 1280x640 canvas.

    python3 assets/build-og-card.py        # -> assets/og-card.png

Requires: Pillow, rsvg-convert (librsvg). System fonts: Arial, SF Mono.
"""
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO_SVG = os.path.join(HERE, "logo.svg")
OUT = os.path.join(HERE, "og-card.png")

W, H = 1280, 640
SCALE = 2  # supersample for crisp text, downscale at the end

# Palette (GitHub-dark friendly)
BG = (13, 17, 23)
WHITE = (240, 243, 247)
MUTED = (139, 148, 158)
ACCENT = (175, 150, 252)   # light violet, readable on dark
BLUE = (79, 141, 253)
VIOLET = (168, 85, 247)
PILL_BG = (22, 27, 34)
PILL_BORDER = (48, 54, 61)

FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_MONO = "/System/Library/Fonts/SFNSMono.ttf"


def f(path, size):
    candidates = [path, FONT_BOLD, "/System/Library/Fonts/Helvetica.ttc"]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size * SCALE)
        except OSError:
            continue
    return ImageFont.load_default()


def tw(draw, text, font):
    return draw.textlength(text, font=font)


def render_logo(px):
    tmp = os.path.join(tempfile.gettempdir(), "ats-og-logo.png")
    subprocess.run(
        ["rsvg-convert", "-w", str(px), "-h", str(px), LOGO_SVG, "-o", tmp],
        check=True,
    )
    return Image.open(tmp).convert("RGBA")


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main():
    cw, ch = W * SCALE, H * SCALE
    img = Image.new("RGB", (cw, ch), BG)

    # Soft violet glow, top-right, for depth
    glow = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx, cy, r = int(cw * 0.82), int(ch * 0.12), int(cw * 0.42)
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(124, 92, 255, 90))
    glow = glow.filter(ImageFilter.GaussianBlur(150 * SCALE))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")

    draw = ImageDraw.Draw(img)
    PAD = 84 * SCALE

    # --- Brand lockup: logo + wordmark ---
    logo_px = 104 * SCALE
    logo = render_logo(logo_px)
    ly = 70 * SCALE
    img.paste(logo, (PAD, ly), logo)
    wm_font = f(FONT_BOLD, 38)
    wm = "Agentic Task System"
    wm_x = PAD + logo_px + 28 * SCALE
    wm_y = ly + (logo_px - (wm_font.getbbox(wm)[3] - wm_font.getbbox(wm)[1])) // 2 - 6 * SCALE
    draw.text((wm_x, wm_y), wm, font=wm_font, fill=WHITE)
    # small uppercase kicker under wordmark
    kick_font = f(FONT_BOLD, 17)
    draw.text((wm_x + 2 * SCALE, wm_y + 46 * SCALE), "A G E N T   C O N T E X T   L A Y E R",
              font=kick_font, fill=MUTED)

    # --- Hero: the thesis ---
    hero = f(FONT_BOLD, 58)
    line_h = 76 * SCALE
    hy = 252 * SCALE
    draw.text((PAD, hy), "Your task manager is the best", font=hero, fill=WHITE)
    # line 2 with accented phrase
    seg1 = "agent memory"
    seg2 = " you're not using."
    draw.text((PAD, hy + line_h), seg1, font=hero, fill=ACCENT)
    w1 = tw(draw, seg1, hero)
    draw.text((PAD + w1, hy + line_h), seg2, font=hero, fill=WHITE)

    # --- Install pill ---
    pill_font = f(FONT_MONO, 27)
    cmd = "$  npm i -g @reneza/ats-cli"
    py0 = 472 * SCALE
    pad_x, pad_y = 30 * SCALE, 20 * SCALE
    tb = draw.textbbox((0, 0), cmd, font=pill_font)
    pw, ph = tb[2] - tb[0], tb[3] - tb[1]
    px1, py1 = PAD, py0
    px2, py2 = PAD + pw + pad_x * 2, py0 + ph + pad_y * 2
    draw.rounded_rectangle([px1, py1, px2, py2], radius=16 * SCALE,
                           fill=PILL_BG, outline=PILL_BORDER, width=2 * SCALE)
    # accent left edge
    draw.rounded_rectangle([px1, py1, px1 + 8 * SCALE, py2], radius=4 * SCALE, fill=VIOLET)
    draw.text((px1 + pad_x - tb[0], py1 + pad_y - tb[1]), cmd, font=pill_font, fill=(201, 209, 217))

    # --- Footer ---
    foot_font = f(FONT_REG, 24)
    draw.text((PAD, 566 * SCALE),
              "github.com/renezander030/agentic-task-system   ·   MIT   ·   hybrid retrieval · RRF · pluggable adapters",
              font=foot_font, fill=MUTED)

    # --- Bottom accent bar (blue -> violet) ---
    bar_h = 8 * SCALE
    bar = Image.new("RGB", (cw, bar_h), BG)
    bd = ImageDraw.Draw(bar)
    for x in range(cw):
        bd.line([(x, 0), (x, bar_h)], fill=lerp(BLUE, VIOLET, x / cw))
    img.paste(bar, (0, ch - bar_h))

    img = img.resize((W, H), Image.LANCZOS)
    img.save(OUT)
    print("wrote", OUT, img.size)


if __name__ == "__main__":
    main()
