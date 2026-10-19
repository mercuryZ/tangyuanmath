# -*- coding: utf-8 -*-
"""一次性脚本：生成提交进仓库的中文子集字体 server/fonts/NotoSansSC-Subset.ttf。

来源（SIL OFL，允许嵌入与再分发，LICENSE 随字体一起提交）：
  https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf
  https://github.com/google/fonts/raw/main/ofl/notosanssc/OFL.txt

用法（在 server/ 目录）：
  curl -L -o fonts/NotoSansSC-VF.ttf "<上面的字体链接>"
  python scripts/subset_font.py            # 读 fonts/NotoSansSC-VF.ttf，写 fonts/NotoSansSC-Subset.ttf

字形集合 = 可打印 ASCII + server/src/pdf.js 源码中出现的全部
Latin-1 补充/标点/全角/CJK 字符（扫描源码而非手抄清单，避免文案改动后漏字形）；
tests/pdf.test.js 会用 fontkit 复核渲染文案的每个字符都有字形。
"""
import pathlib
import re
import sys

from fontTools import ttLib
from fontTools.subset import Subsetter, Options
from fontTools.varLib.instancer import instantiateVariableFont

root = pathlib.Path(__file__).resolve().parent.parent  # server/
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "fonts" / "NotoSansSC-VF.ttf"
out = root / "fonts" / "NotoSansSC-Subset.ttf"

pdf_src = (root / "src" / "pdf.js").read_text(encoding="utf-8")
chars = {chr(c) for c in range(0x20, 0x7F)}                      # 可打印 ASCII（数字、=、_ 等）
chars |= set(re.findall(r"[\u00A0-\uFFEF]", pdf_src))            # ×·–—（）与全部中文字符

font = ttLib.TTFont(str(src))
instantiateVariableFont(font, {"wght": 400}, inplace=True)       # 可变字体 → 常规字重实例

opts = Options()
opts.notdef_outline = True
opts.glyph_names = False
opts.hinting = True
ss = Subsetter(options=opts)
ss.populate(unicodes=sorted(ord(c) for c in chars))
ss.subset(font)
font.save(str(out))
print(f"{len(chars)} chars -> {out.name} {out.stat().st_size} bytes")
