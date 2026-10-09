#!/usr/bin/env python3
"""从英文规格 + 中文译文表生成中文规格。

    python3 docs/openapi/build-zh.py

# ⚠️★ 为什么是「生成」而不是「手写第二份」

手写一份中文规格，就是**两份规格**：路径、字段名、必填、示例全都要人工保持同步，
而**漂了不会报错** —— 只是有人照着错的文档写客户端。这个项目已经为这件事付过代价
（`/stats/daily` 在 Rust 与 Worker 各一份，注释里专门写了「改一边要改另一边」）。

生成的话，**结构只可能来自英文那份**：这里只替换 `summary` / `description` 的**文字**，
其余（路径、schema、示例、`required`）原样搬过去。于是「两份结构漂了」这件事
**在物理上不可能发生**，不需要再写一条检查去发现它。

⚠️ 代价说清楚：生成出来那份**没有注释、顺序按 YAML 的键**。所以
`clip9.openapi.zh.yaml` 是**产物**，不要手改 —— 改译文表或改英文那份，再跑一次这个脚本。

译文表 `zh.yaml` 的键是**点分路径**（如 `paths./content.get.description`），
值是中文正文。⚠️ 表里**没有**的键会**保留英文原文**，而不是留空 ——
漏译一条的表现是「那一句还是英文」，而不是「那一节没了」。
"""
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
EN = HERE / 'clip9.openapi.yaml'
ZH_TABLE = HERE / 'zh.yaml'
ZH_OUT = HERE / 'clip9.openapi.zh.yaml'

# 只翻这两类字段。⚠️ **不翻** `title` / `example` / 枚举值 / 字段名 ——
# 那些是**标识符或数据**，翻了会让客户端对不上。
TRANSLATABLE = ('summary', 'description')


def walk(node, path, table, stats):
    """就地替换 node 里可翻译字段的值；path 是点分路径。"""
    if isinstance(node, dict):
        for key, value in node.items():
            here = f'{path}.{key}' if path else str(key)
            if key in TRANSLATABLE and isinstance(value, str):
                if here in table:
                    node[key] = table[here]
                    stats['translated'] += 1
                else:
                    stats['kept'].append(here)
            else:
                walk(value, here, table, stats)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            walk(item, f'{path}.{i}', table, stats)


def main() -> int:
    spec = yaml.safe_load(EN.read_text())
    table = yaml.safe_load(ZH_TABLE.read_text()) if ZH_TABLE.exists() else {}
    if not isinstance(table, dict):
        print(f'✗ {ZH_TABLE.name} 不是一张「路径 → 译文」的表')
        return 1

    stats = {'translated': 0, 'kept': []}
    walk(spec, '', table, stats)

    # ⚠️ 表里写了、但规格里没有的键 —— 通常是**改了字段名忘了改表**，
    # 而它不会自己报错（那一条译文只是永远用不上）。
    used = set()
    def collect(node, path):
        if isinstance(node, dict):
            for key, value in node.items():
                here = f'{path}.{key}' if path else str(key)
                if key in TRANSLATABLE and isinstance(value, str):
                    used.add(here)
                else:
                    collect(value, here)
        elif isinstance(node, list):
            for i, item in enumerate(node):
                collect(item, f'{path}.{i}')
    collect(yaml.safe_load(EN.read_text()), '')
    orphans = sorted(set(table) - used)

    header = (
        '# ⚠️★ 这是**生成物**，不要手改。\n'
        '#\n'
        '#   改法：改 `zh.yaml`（译文表）或 `clip9.openapi.yaml`（英文原文），\n'
        '#   然后跑 `python3 docs/openapi/build-zh.py`。\n'
        '#\n'
        '# 结构（路径 / 字段 / 必填 / 示例）**全部来自英文那份**，所以两份不会漂。\n'
        f'# 已译 {stats["translated"]} 条，未译（保留英文）{len(stats["kept"])} 条。\n'
    )
    ZH_OUT.write_text(header + yaml.safe_dump(spec, allow_unicode=True, sort_keys=False, width=100))

    print(f'✓ 生成 {ZH_OUT.name}：已译 {stats["translated"]} 条，保留英文 {len(stats["kept"])} 条')
    if orphans:
        print(f'⚠️  译文表里有 {len(orphans)} 条用不上（字段名改过？）：')
        for key in orphans[:10]:
            print(f'     {key}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
