# Regenerates the README banners from assets/logo.svg: python3 scripts/banner.py assets
import sys, re
out_dir = sys.argv[1]
logo = open(f"{out_dir}/logo.svg").read()
logo_inner = re.search(r"<svg[^>]*>(.*)</svg>", logo, re.S).group(1).replace('id="sea"', 'id="logosea"').replace("url(#sea)", "url(#logosea)").replace('id="bowl"', 'id="logobowl"').replace("url(#bowl)", "url(#logobowl)")

VARIANTS = {
  "en": dict(tagline1="Drop links into your group chat.", tagline2="Get them sorted, explained and searchable.",
             chips=["facebook.com/share/v/…", "threads.com/@pohuang…", "youtu.be/dQw4w9WgX…"],
             cards=[("Paperclip", "Agent frameworks", "#2459e0"), ("RealWonder", "Image &amp; video", "#c2410c"), ("ascii-sharks", "Design &amp; frontend", "#0f9f8f")],
             foot="LINE · Slack · Discord · Telegram · Chrome · MCP", font="-apple-system, 'Segoe UI', Inter, Helvetica, Arial, sans-serif"),
  "zh-TW": dict(tagline1="把連結丟進群組聊天室，", tagline2="自動分類、說明、整理成可搜尋的清單。",
             chips=["facebook.com/share/v/…", "threads.com/@pohuang…", "youtu.be/dQw4w9WgX…"],
             cards=[("Paperclip", "Agent 框架", "#2459e0"), ("RealWonder", "圖片影片", "#c2410c"), ("ascii-sharks", "設計前端", "#0f9f8f")],
             foot="LINE · Slack · Discord · Telegram · Chrome · MCP", font="-apple-system, 'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"),
}

def chip(x, y, text, opacity):
    return f'''<g transform="translate({x} {y})" opacity="{opacity}">
      <rect width="240" height="44" rx="22" class="chip"/>
      <g transform="translate(26 22) rotate(-30)" fill="none" class="chiplink" stroke-width="2.6">
        <rect x="-9" y="-4" width="11" height="8" rx="4"/><rect x="-2" y="-4" width="11" height="8" rx="4"/>
      </g>
      <text x="46" y="28" class="chiptext">{text}</text>
    </g>'''

def card(x, y, name, cat, color):
    return f'''<g transform="translate({x} {y})">
      <rect width="236" height="64" rx="14" class="card"/>
      <circle cx="26" cy="32" r="7" fill="{color}"/>
      <text x="46" y="28" class="cardname">{name}</text>
      <text x="46" y="48" class="cardcat">{cat}</text>
    </g>'''

for lang, v in VARIANTS.items():
    chips = "\n".join(chip(x, y, t, o) for (x, y, o), t in zip([(604, 96, .55), (624, 184, .8), (584, 272, 1)], v["chips"]))
    cards = "\n".join(card(1004, 86 + i * 84, *c) for i, c in enumerate(v["cards"]))
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 420" width="1280" height="420" role="img" aria-label="driftnet: {v['tagline1']} {v['tagline2']}">
  <style>
    .bg {{ fill: #f6f8fc; }} .wave {{ stroke: #2459e0; stroke-opacity: .10; }}
    .word {{ fill: #0f172a; }} .tag {{ fill: #475569; }} .foot {{ fill: #64748b; }}
    .chip {{ fill: #ffffff; stroke: #dbe3f0; }} .chiplink {{ stroke: #2459e0; }} .chiptext {{ fill: #334155; }}
    .card {{ fill: #ffffff; stroke: #dbe3f0; }} .cardname {{ fill: #0f172a; }} .cardcat {{ fill: #64748b; }}
    .net {{ stroke: #0f9f8f; }} .netmesh {{ stroke: #0f9f8f; stroke-opacity: .35; }} .arrow {{ stroke: #94a3b8; }}
    @media (prefers-color-scheme: dark) {{
      .bg {{ fill: #0d1117; }} .wave {{ stroke: #58a6ff; stroke-opacity: .12; }}
      .word {{ fill: #f0f6fc; }} .tag {{ fill: #9da7b3; }} .foot {{ fill: #7d8590; }}
      .chip {{ fill: #161b22; stroke: #30363d; }} .chiplink {{ stroke: #58a6ff; }} .chiptext {{ fill: #c9d1d9; }}
      .card {{ fill: #161b22; stroke: #30363d; }} .cardname {{ fill: #f0f6fc; }} .cardcat {{ fill: #9da7b3; }}
      .net {{ stroke: #2dd4bf; }} .netmesh {{ stroke: #2dd4bf; stroke-opacity: .35; }} .arrow {{ stroke: #484f58; }}
    }}
    text {{ font-family: {v['font']}; }}
    .word {{ font-size: 76px; font-weight: 700; letter-spacing: -2px; }}
    .tag {{ font-size: 25px; }} .foot {{ font-size: 17px; letter-spacing: .5px; }}
    .chiptext {{ font-size: 15px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }}
    .cardname {{ font-size: 18px; font-weight: 650; }} .cardcat {{ font-size: 14px; }}
  </style>
  <defs><clipPath id="bigbowl"><path d="M886 206 H954 C954 231 939 250 920 250 C901 250 886 231 886 206 Z"/></clipPath></defs>
  <rect width="1280" height="420" rx="24" class="bg"/>
  <g fill="none" stroke-width="3" class="wave">
    <path d="M0 330 q40 -26 80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0"/>
    <path d="M-40 368 q40 -26 80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0"/>
  </g>
  <svg x="72" y="84" width="128" height="128" viewBox="0 0 128 128">{logo_inner}</svg>
  <text x="224" y="176" class="word">driftnet</text>
  <text x="76" y="262" class="tag">{v['tagline1']}</text>
  <text x="76" y="298" class="tag">{v['tagline2']}</text>
  <text x="76" y="368" class="foot">{v['foot']}</text>
  {chips}
  <g fill="none" stroke-width="2.5" stroke-linecap="round" class="arrow" stroke-dasharray="2 8">
    <path d="M850 118 C878 132 896 160 906 196"/><path d="M870 206 H876"/><path d="M830 294 C862 288 890 268 904 246"/>
  </g>
  <g clip-path="url(#bigbowl)" stroke-width="2.5" class="netmesh">
    <path d="M866 206 L916 256 M886 206 L936 256 M906 206 L956 256 M926 206 L976 256 M846 206 L896 256"/>
    <path d="M974 206 L924 256 M954 206 L904 256 M934 206 L884 256 M914 206 L864 256 M994 206 L944 256"/>
  </g>
  <path d="M886 206 C886 231 901 250 920 250 C939 250 954 231 954 206" fill="none" stroke-width="5" stroke-linecap="round" class="net"/>
  <path d="M879 206 H961" stroke-width="5" stroke-linecap="round" class="net"/>
  <path d="M968 222 H994" stroke-width="2.5" stroke-linecap="round" class="arrow" stroke-dasharray="2 8"/>
  {cards}
</svg>
'''
    # GitHub picks between files with <picture> by *its* theme; a self-adapting SVG
    # would follow the OS instead. Write one fixed file per theme.
    light = re.sub(r"\n    @media \(prefers-color-scheme: dark\) \{.*?\n    \}", "", svg, flags=re.S)
    dark = re.sub(r"\.bg \{ fill: #f6f8fc; \}.*?@media \(prefers-color-scheme: dark\) \{(.*?)\n    \}", lambda m: m.group(1), svg, flags=re.S)
    assert "prefers-color-scheme" not in light and "prefers-color-scheme" not in dark
    open(f"{out_dir}/banner-{lang}-light.svg", "w").write(light)
    open(f"{out_dir}/banner-{lang}-dark.svg", "w").write(dark)
print("ok")
