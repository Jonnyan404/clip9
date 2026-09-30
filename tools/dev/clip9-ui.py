#!/usr/bin/env python3
"""clip9 真机操作小工具：dump 一次 UI，按 resource-id 后缀 / text 找节点，打印中心坐标。

用法（都会先 dump 一次当前界面）：
    clip9-ui.py find <id后缀>          # 打印匹配节点的中心与 bounds
    clip9-ui.py find-text <文本>       # 按 text 找
    clip9-ui.py tap <id后缀>           # 点它
    clip9-ui.py texts                  # 列出当前屏所有文本
    clip9-ui.py bounds                 # 列出关键节点 bounds

⚠️ 为什么要有它：`uiautomator dump` 的 XML 一行里属性很多，用 grep+sed 抠数字
会抠到别的属性上（2026-09-30 就因为抠出 (161,215) 这种坐标而白点了好几次）。
xml.etree 解析是准的。
"""
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

def find_adb() -> str:
    """找 adb：`ADB` 环境变量 → PATH → 常见的 SDK 位置。"""
    if os.environ.get("ADB"):
        return os.environ["ADB"]
    if shutil.which("adb"):
        return shutil.which("adb")
    for home in (os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
                 os.path.expanduser("~/Library/Android/sdk")):
        if home and os.path.exists(os.path.join(home, "platform-tools", "adb")):
            return os.path.join(home, "platform-tools", "adb")
    sys.exit("找不到 adb —— 设 ADB 环境变量，或把它加进 PATH")

ADB = find_adb()
BOUNDS = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")


def dump() -> ET.Element:
    subprocess.run([ADB, "shell", "uiautomator", "dump", "/sdcard/ui.xml"],
                   capture_output=True)
    raw = subprocess.run([ADB, "shell", "cat", "/sdcard/ui.xml"],
                         capture_output=True, text=True).stdout
    return ET.fromstring(raw)


def center(node):
    m = BOUNDS.match(node.get("bounds") or "")
    if not m:
        return None
    x1, y1, x2, y2 = (int(v) for v in m.groups())
    return ((x1 + x2) // 2, (y1 + y2) // 2, (x1, y1, x2, y2))


def main():
    cmd = sys.argv[1]
    root = dump()
    nodes = list(root.iter())
    if cmd == "texts":
        for n in nodes:
            t = n.get("text")
            if t:
                print(t)
        return
    if cmd == "bounds":
        for n in nodes:
            rid = (n.get("resource-id") or "").split("/")[-1]
            if rid and n.get("bounds"):
                print(f"{rid:28} {n.get('bounds')}")
        return
    key = sys.argv[2]
    if cmd in ("find", "tap"):
        hits = [n for n in nodes if (n.get("resource-id") or "").split("/")[-1] == key]
    else:
        hits = [n for n in nodes if (n.get("text") or "") == key]
    if not hits:
        print(f"找不到: {cmd} {key}")
        sys.exit(1)
    for n in hits:
        c = center(n)
        print(f"{key}: bounds={n.get('bounds')} 中心=({c[0]},{c[1]})"
              f" text={n.get('text')!r}")
    if cmd == "tap":
        x, y, _ = center(hits[0])
        print(f"tap ({x},{y})")
        subprocess.run([ADB, "shell", "input", "tap", str(x), str(y)])


main()
