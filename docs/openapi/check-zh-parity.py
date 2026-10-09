#!/usr/bin/env python3
"""检查中文规格与英文规格的**结构**是否一致。

    python3 docs/openapi/check-zh-parity.py

# ⚠️★ 中文那份是 `build-zh.py` 生成的，结构**本来**只可能来自英文那份。
# 那为什么还要查一遍：因为生成物是**入库**的，而入库的东西一定会有人手改
# （改起来比跑脚本快）。手改过的生成物不会再报错 —— 它只是悄悄和英文那份分了叉。
# 这条断言把「有人手改了」变成一个**会红的信号**。
#
# ⚠️ 只比结构，不比文字：散文本来就该不一样，比了反而会把正确的译文判成错。
"""
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
TRANSLATABLE = ('summary', 'description')


def shape(node):
    """把一棵 YAML 树压成「只有键和值类型」的形状，丢掉所有可翻译的文字。"""
    if isinstance(node, dict):
        return {k: shape(v) for k, v in node.items() if k not in TRANSLATABLE}
    if isinstance(node, list):
        return [shape(x) for x in node]
    return type(node).__name__


def main() -> int:
    en = shape(yaml.safe_load((HERE / 'clip9.openapi.yaml').read_text()))
    zh_path = HERE / 'clip9.openapi.zh.yaml'
    if not zh_path.exists():
        print('✗ clip9.openapi.zh.yaml 不存在 —— 跑一下 build-zh.py')
        return 1
    zh = shape(yaml.safe_load(zh_path.read_text()))

    if en == zh:
        print('OK  parity: 中文规格与英文规格结构一致（只有 summary/description 的文字不同）')
        return 0

    print('✗ 中文规格的结构和英文那份不一样了 —— 多半是有人手改了生成物。')
    print('  正确做法：改 zh.yaml 或 clip9.openapi.yaml，再跑 build-zh.py。')
    # 指出第一处不同，省得对着两份 5000 行的文件找
    def first_diff(a, b, path=''):
        if type(a) is not type(b):
            return f'{path or "<root>"}：类型不同（{type(a).__name__} vs {type(b).__name__}）'
        if isinstance(a, dict):
            for k in sorted(set(a) | set(b)):
                if k not in a:
                    return f'{path}.{k}：中文那份多了这个键'
                if k not in b:
                    return f'{path}.{k}：中文那份少了这个键'
                d = first_diff(a[k], b[k], f'{path}.{k}')
                if d:
                    return d
        elif isinstance(a, list):
            if len(a) != len(b):
                return f'{path}：长度不同（{len(a)} vs {len(b)}）'
            for i, (x, y) in enumerate(zip(a, b)):
                d = first_diff(x, y, f'{path}[{i}]')
                if d:
                    return d
        elif a != b:
            return f'{path}：值不同（{a!r} vs {b!r}）'
        return None
    print('  第一处：', first_diff(en, zh))
    return 1


if __name__ == '__main__':
    sys.exit(main())
