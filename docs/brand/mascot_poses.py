"""Generate the nexusPay mascot pose SVGs.

Usage (from repo root): python docs/brand/mascot_poses.py
Writes web/public/brand/mascot-<pose>.svg. Pure stdlib, no dependencies.
"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'web', 'public', 'brand')
DEFS = '<defs><linearGradient id="card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eaf8f2"/></linearGradient><filter id="sh" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#0b3f35" flood-opacity="0.22"/></filter><linearGradient id="chipG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22a584"/><stop offset="1" stop-color="#0c5144"/></linearGradient><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><g id="chip"><rect x="0" y="0" width="96" height="72" rx="14" fill="url(#chipG)"/><g fill="none" stroke="#7dffd9" stroke-width="2.6" stroke-linecap="round" filter="url(#glow)"><rect x="1.5" y="1.5" width="93" height="69" rx="12.5"/><rect x="32" y="16" width="32" height="40" rx="7"/><path d="M2 24H32M2 48H32M64 24H94M64 48H94M48 2V16M48 56V70M32 36H22M64 36H74"/></g></g></defs>'
G, GD, INK, MINT, PALE = '#177b65', '#126b57', '#103f37', '#7fe0bf', '#bcebdc'

def arm(d):
    return f'<path d="{d}" stroke="{G}" stroke-width="50" stroke-linecap="round" fill="none"/>'

LEGS = {
 'stand': f'<path d="M432 712V818M592 712V818" stroke="{GD}" stroke-width="50" stroke-linecap="round"/>'
          f'<path d="M404 832H446M570 832H612" stroke="{INK}" stroke-width="40" stroke-linecap="round"/>',
 'jump':  f'<path d="M432 712L392 800M592 712L636 796" stroke="{GD}" stroke-width="50" stroke-linecap="round"/>'
          f'<path d="M362 812H400M628 808H666" stroke="{INK}" stroke-width="40" stroke-linecap="round"/>',
}
EYES = {
 'open':  f'<rect x="410" y="430" width="50" height="108" rx="25" fill="{G}"/><rect x="564" y="430" width="50" height="108" rx="25" fill="{G}"/>'
          '<circle cx="436" cy="454" r="9" fill="#fff"/><circle cx="590" cy="454" r="9" fill="#fff"/>',
 'look':  f'<rect x="410" y="430" width="50" height="108" rx="25" fill="{G}"/><rect x="564" y="430" width="50" height="108" rx="25" fill="{G}"/>'
          '<circle cx="444" cy="448" r="10" fill="#fff"/><circle cx="598" cy="448" r="10" fill="#fff"/>',
 'happy': f'<path d="M405 500Q435 450 465 500M559 500Q589 450 619 500" stroke="{G}" stroke-width="26" stroke-linecap="round" fill="none"/>',
 'closed':f'<path d="M405 486Q435 516 465 486M559 486Q589 516 619 486" stroke="{G}" stroke-width="22" stroke-linecap="round" fill="none"/>',
 'stern': f'<rect x="410" y="462" width="50" height="72" rx="25" fill="{G}"/><rect x="564" y="462" width="50" height="72" rx="25" fill="{G}"/>'
          f'<path d="M402 438L464 452M622 438L560 452" stroke="{G}" stroke-width="16" stroke-linecap="round"/>',
}
MOUTH = {
 'smile': f'<path d="M488 566Q512 590 536 566" fill="none" stroke="{G}" stroke-width="14" stroke-linecap="round"/>',
 'open':  f'<path d="M482 560Q512 606 542 560Z" fill="{G}" stroke="{G}" stroke-width="10" stroke-linejoin="round"/>',
 'flat':  f'<path d="M496 574H528" stroke="{G}" stroke-width="14" stroke-linecap="round"/>',
 'o':     f'<ellipse cx="512" cy="576" rx="12" ry="9" fill="{G}"/>',
 'frown': f'<path d="M490 582Q512 562 534 582" fill="none" stroke="{G}" stroke-width="14" stroke-linecap="round"/>',
}
BODY = ('<g filter="url(#sh)"><rect x="232" y="330" width="560" height="390" rx="58" fill="url(#card)" stroke="#bcebdc" stroke-width="8"/></g>'
        f'<rect x="286" y="636" width="116" height="24" rx="12" fill="{PALE}"/><rect x="416" y="636" width="60" height="24" rx="12" fill="{PALE}"/>'
        '<use href="#chip" transform="translate(658 610)"/>')
CHEEKS = f'<ellipse cx="370" cy="560" rx="34" ry="18" fill="{PALE}"/><ellipse cx="654" cy="560" rx="34" ry="18" fill="{PALE}"/>'
ANT = lambda ball=MINT: (f'<path d="M512 336V262" stroke="{G}" stroke-width="24" stroke-linecap="round"/>'
                         f'<circle cx="512" cy="238" r="40" fill="{ball}"/><circle cx="500" cy="226" r="12" fill="#e6fff6" opacity=".8"/>')
def sparkle(x, y, s=1, c=MINT):
    return f'<path transform="translate({x} {y}) scale({s})" d="M0 -34Q4 -4 34 0Q4 4 0 34Q-4 4 -34 0Q-4 -4 0 -34Z" fill="{c}"/>'
COIN = (f'<g transform="translate(884 360)"><circle r="78" fill="{MINT}" stroke="{G}" stroke-width="12"/>'
        f'<circle r="54" fill="none" stroke="#e6fff6" stroke-width="6" opacity=".9"/>'
        f'<path d="M-28 2L-8 22L30 -20" fill="none" stroke="{G}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/></g>')

POSES = {
 'wave':    dict(tilt=-6, legs='stand', eyes='open', mouth='smile',
                 back=[arm('M236 560Q182 600 176 666'), arm('M788 540Q852 500 868 420')]),
 'cheer':   dict(tilt=4, lift=-50, legs='jump', eyes='happy', mouth='open',
                 back=[arm('M240 520Q168 470 168 372'), arm('M786 510Q858 460 858 364')],
                 over=sparkle(140, 300) + sparkle(900, 250, .7) + sparkle(930, 560, .5, PALE)),
 'think':   dict(tilt=-3, legs='stand', eyes='look', mouth='flat',
                 back=[arm('M236 570Q196 620 190 690'), arm('M788 520Q884 450 812 350')],
                 over=f'<circle cx="236" cy="236" r="14" fill="{PALE}"/><circle cx="196" cy="196" r="20" fill="{PALE}"/><circle cx="148" cy="148" r="28" fill="{MINT}"/>'),
 'approved':dict(tilt=-6, legs='stand', eyes='happy', mouth='smile',
                 back=[arm('M236 560Q182 600 176 666'), arm('M788 540Q840 500 850 440')],
                 top=COIN),
 'denied':  dict(tilt=0, legs='stand', eyes='stern', mouth='frown', cheeks=False,
                 back=[], front=[arm('M250 520Q380 640 640 700'), arm('M774 520Q644 640 384 700')]),
 'sleep':   dict(tilt=-8, legs='stand', eyes='closed', mouth='o', ball='#a9d9c6',
                 back=[arm('M236 580Q200 630 204 700'), arm('M788 560Q826 610 822 684')],
                 over='<g font-family="Arial Rounded MT Bold,Arial,sans-serif" font-weight="700" fill="#177b65">'
                      '<text x="760" y="250" font-size="96">Z</text><text x="860" y="170" font-size="64" opacity=".7">z</text>'
                      '<text x="920" y="112" font-size="44" opacity=".45">z</text></g>'),
}

EYES['down'] = (f'<rect x="410" y="430" width="50" height="108" rx="25" fill="{G}"/><rect x="564" y="430" width="50" height="108" rx="25" fill="{G}"/>'
                '<circle cx="436" cy="514" r="9" fill="#fff"/><circle cx="590" cy="514" r="9" fill="#fff"/>')
WALLET_COIN = (f'<g transform="translate(884 360)"><circle r="78" fill="{MINT}" stroke="{G}" stroke-width="12"/>'
        f'<circle r="54" fill="none" stroke="#e6fff6" stroke-width="6" opacity=".9"/>'
        f'<path d="M-30 -22H22L30 -14M-30 0H30M-22 22H30" stroke="{G}" stroke-width="12" stroke-linecap="round" fill="none"/></g>')
STACK = ''.join(f'<rect x="{800+i*18}" y="{470-i*22}" width="150" height="96" rx="18" fill="#fff" stroke="{PALE if i<2 else G}" stroke-width="8"/>' for i in range(3)) + \
        f'<path d="M866 440L884 458L914 426" stroke="{G}" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
SHIELD = (f'<g transform="translate(884 440)"><path d="M0 -86L70 -60V4Q70 62 0 94Q-70 62 -70 4V-60Z" fill="{G}" stroke="{INK}" stroke-width="8" stroke-linejoin="round"/>'
          f'<path d="M-26 4L-6 24L30 -16" stroke="#fff" stroke-width="14" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>')
LENS = (f'<path d="M906 376L950 420" stroke="{INK}" stroke-width="24" stroke-linecap="round"/>'
        f'<circle cx="860" cy="330" r="62" fill="#e6fff6" fill-opacity=".85" stroke="{G}" stroke-width="16"/>'
        f'<path d="M830 306Q846 290 866 290" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round"/>')
BOOK = (f'<g transform="translate(512 690)"><path d="M0 -6Q-80 -44 -160 -22V78Q-80 56 0 92Z" fill="#fff" stroke="{G}" stroke-width="10" stroke-linejoin="round"/>'
        f'<path d="M0 -6Q80 -44 160 -22V78Q80 56 0 92Z" fill="#f1fff9" stroke="{G}" stroke-width="10" stroke-linejoin="round"/>'
        f'<path d="M-124 8Q-76 -4 -34 12M-124 38Q-76 26 -34 42M34 12Q76 -4 124 8M34 42Q76 26 124 38" stroke="{PALE}" stroke-width="9" fill="none" stroke-linecap="round"/></g>')
BUBBLE = (f'<g transform="translate(700 90)"><rect width="250" height="140" rx="34" fill="{G}"/><path d="M60 134L40 190L110 134Z" fill="{G}"/>'
          f'<path d="M58 44L96 72L58 100" stroke="#fff" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
          f'<path d="M118 100H178" stroke="{MINT}" stroke-width="16" stroke-linecap="round"/></g>')
POSES.update({
 'wallet':  dict(tilt=-6, legs='stand', eyes='open', mouth='smile',
                 back=[arm('M236 560Q182 600 176 666'), arm('M788 540Q840 500 850 440')], top=WALLET_COIN),
 'tasks':   dict(tilt=-4, legs='stand', eyes='look', mouth='smile',
                 back=[arm('M236 570Q196 620 190 690'), arm('M788 580Q830 600 846 540')], top=STACK),
 'command': dict(tilt=-3, legs='stand', eyes='open', mouth='open',
                 back=[arm('M236 570Q196 620 190 690'), arm('M788 520Q850 470 846 390')], over=BUBBLE),
 'policy':  dict(tilt=-2, legs='stand', eyes='open', mouth='flat',
                 back=[arm('M236 570Q196 620 190 690'), arm('M788 540Q836 520 850 470')], top=SHIELD),
 'audit':   dict(tilt=-5, legs='stand', eyes='look', mouth='o',
                 back=[arm('M236 570Q196 620 190 690'), arm('M788 540Q900 520 946 426')], top=LENS),
 'docs':    dict(tilt=-4, legs='stand', eyes='down', mouth='smile',
                 back=[], front=[arm('M236 580Q262 700 380 716'), arm('M788 570Q762 690 644 712')], top=BOOK),
})

for name, p in POSES.items():
    lift = p.get('lift', 0)
    rot = f'rotate({p["tilt"]} 512 560)'
    char = (''.join(p.get('back', [])) + LEGS[p['legs']] + ANT(p.get('ball', MINT)) + BODY
            + EYES[p['eyes']] + (CHEEKS if p.get('cheeks', True) else '') + MOUTH[p['mouth']]
            + ''.join(p.get('front', [])) + p.get('top', ''))
    shadow_rx = 230 if not lift else 180
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">{DEFS}'
           f'<ellipse cx="512" cy="872" rx="{shadow_rx}" ry="26" fill="#0b3f35" opacity="{0.14 if not lift else 0.09}"/>'
           f'<g transform="translate(0 {lift}) {rot}">{char}</g>{p.get("over", "")}</svg>')
    with open(os.path.join(OUT, f'mascot-{name}.svg'), 'w', encoding='utf8', newline='\n') as f:
        f.write(svg + '\n')
print('wrote', len(POSES), 'poses to', os.path.normpath(OUT))
