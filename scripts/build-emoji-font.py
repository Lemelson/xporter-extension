#!/usr/bin/env python3
"""Build the bundled emoji font. Requires fonttools[woff] (build time only).
Prepare inputs using prepare-emoji-assets.cjs; this step is fully offline.
"""
import hashlib
import json
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._g_l_y_f import Glyph as OutlineGlyph, GlyphCoordinates
from fontTools.ttLib.tables.ttProgram import Program
from array import array
from fontTools.ttLib import newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.ttLib.tables.sbixGlyph import Glyph
from fontTools.ttLib.tables.sbixStrike import Strike
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'popup/emoji'
def build():
    manifest = json.loads((OUT / 'manifest.json').read_text())
    entries = manifest['emoji']
    EMOJI = [entry['emoji'] for entry in entries]
    for entry in entries:
        image = (OUT / entry['file']).read_bytes()
        if hashlib.sha256(image).hexdigest() != entry['sha256']:
            raise ValueError(f"Asset hash mismatch: {entry['file']}")
    # Only emoji have a cmap entry; every ordinary letter uses the existing UI font.
    codepoints = sorted({ord(c) for emoji in EMOJI for c in emoji if ord(c) != 0xfe0f})
    cmap = {cp: f'u{cp:X}' for cp in codepoints}
    glyph_order = ['.notdef'] + list(cmap.values())
    names = {}
    for entry in entries:
        cps = [ord(c) for c in entry['emoji'] if ord(c) != 0xfe0f]
        name = '_'.join(f'u{cp:X}' for cp in cps)
        names[entry['emoji']] = name
        if name not in glyph_order:
            glyph_order.append(name)
    fb = FontBuilder(800, isTTF=True)
    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap(cmap)
    glyphs = {}
    for name in glyph_order:
        # Two degenerate contours supply bounds without drawing an outline.
        glyph = OutlineGlyph()
        glyph.numberOfContours = 2
        glyph.coordinates = GlyphCoordinates([(0, 0), (800, 800)])
        glyph.endPtsOfContours = [0, 1]
        glyph.flags = array('B', [1, 1])
        glyph.program = Program()
        glyph.program.fromBytecode([])
        glyphs[name] = glyph
    # OTS rejects a zero-length glyf table, even when sbix supplies every image.
    pen = TTGlyphPen(None)
    pen.moveTo((80, 0))
    pen.lineTo((720, 0))
    pen.lineTo((720, 700))
    pen.lineTo((80, 700))
    pen.closePath()
    glyphs['.notdef'] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (1000, 0) for name in glyph_order})
    fb.setupHorizontalHeader(ascent=800, descent=-250)
    fb.setupNameTable({'familyName': 'XPorter UI Emoji', 'styleName': 'Regular',
                      'uniqueFontIdentifier': 'XPorterUIEmoji-1.0',
                      'fullName': 'XPorter UI Emoji', 'psName': 'XPorterUIEmoji',
                      'version': 'Version 1.0',
                      'copyright': 'Google Noto, Twemoji, Emojitwo and Microsoft Fluent artwork. See THIRD_PARTY_NOTICES.'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-250, usWinAscent=800, usWinDescent=250)
    fb.setupPost()
    uv = CmapSubtable.newSubtable(14)
    uv.platformID, uv.platEncID, uv.language = 0, 5, 0
    uv.cmap = {}
    uv.uvsDict = {0xfe0f: [(0x26a0, None), (0x27a1, None)]}
    fb.font['cmap'].tables.append(uv)
    ligatures = []
    for emoji, name in names.items():
        cps = [ord(c) for c in emoji if ord(c) != 0xfe0f]
        if len(cps) > 1:
            ligatures.append(f'sub {" ".join(cmap[cp] for cp in cps)} by {name};')
    # Move the complete glyph via GPOS, rather than a negative sbix origin
    # (which clips the bitmap in Chromium). Units scale with the text size.
    positioning = []
    for emoji, name in names.items():
        shift = -175 if emoji == '👥' else -100
        positioning.append(f'pos {name} <100 {shift} 0 0>;')
    addOpenTypeFeaturesFromString(fb.font, 'languagesystem DFLT dflt; feature rlig {\n' + '\n'.join(ligatures) + '\n} rlig; feature kern {\n' + '\n'.join(positioning) + '\n} kern;')
    sbix = newTable('sbix')
    strike = Strike(ppem=72, resolution=72)
    for entry in entries:
        name = names[entry['emoji']]
        # CoreText/Chromium clips sbix artwork with a negative bitmap origin.
        # Keep the image origin at zero; use font metrics for line placement.
        strike.glyphs[name] = Glyph(glyphName=name, originOffsetX=0, originOffsetY=0,
                                   graphicType='png ', imageData=(OUT / entry['file']).read_bytes())
    sbix.strikes = {72: strike}
    fb.font['sbix'] = sbix
    fb.font['head'].created = fb.font['head'].modified = 3786912000
    fb.font.recalcTimestamp = False
    fb.font.flavor = 'woff2'
    fb.font.save(OUT / 'ui-emoji.woff2')
    # GitHub Pages has a separate root from the packaged extension.
    (ROOT / 'docs/assets/ui-emoji.woff2').write_bytes((OUT / 'ui-emoji.woff2').read_bytes())
    print(f'Built {len(entries)} emoji, {(OUT / "ui-emoji.woff2").stat().st_size} bytes')

if __name__ == '__main__':
    build()
