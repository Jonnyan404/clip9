#!/usr/bin/env python3
"""Structural + example checker for `clip9.openapi.yaml`.

Two jobs, both of which have bitten this project's style of documentation before:

1. the document is a **valid OpenAPI 3.1 document** (structure, refs, path params...);
2. every named `examples:` entry actually **conforms to the schema it is attached to**.

Job 2 is the point. A spec whose examples disagree with its schemas is worse than no
examples: a client generator or a careful reader trusts them. `openapi-spec-validator`
only does job 1, so it is complemented here with `jsonschema`.

Run:
    python3 check-openapi.py [path/to/clip9.openapi.yaml]
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate as validate_openapi


def deref(node, root, seen=()):
    """Resolve a `$ref` chain. Returns the node unchanged when it is not a ref."""
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        if ref in seen:
            raise ValueError(f"circular $ref: {ref}")
        if not ref.startswith("#/"):
            raise ValueError(f"only local refs are supported, got {ref!r}")
        target = root
        for part in ref[2:].split("/"):
            target = target[part]
        node = target
        seen = seen + (ref,)
    return node


def expand(node, root, seen=()):
    """Recursively inline every `$ref`.

    `jsonschema` resolves refs against a base URI, and these are bare
    `#/components/...` pointers, so the cheapest correct thing is to inline them.
    A true cycle is reported rather than silently left unresolved.
    """
    if isinstance(node, list):
        return [expand(item, root, seen) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        ref = node["$ref"]
        if ref in seen:
            raise ValueError(f"circular $ref: {ref}")
        return expand(deref(node, root), root, seen + (ref,))
    return {key: expand(value, root, seen) for key, value in node.items()}


def iter_examples(node, root, where=""):
    """Yield (where, schema, example_value) for every named response example."""
    node = deref(node, root)
    if not isinstance(node, dict):
        return
    schema = node.get("schema")
    if schema is not None:
        for name, ex in (node.get("examples") or {}).items():
            value = ex.get("value") if isinstance(ex, dict) else ex
            yield f"{where}::{name}", schema, value
    for media, sub in (node.get("content") or {}).items():
        yield from iter_examples(sub, root, f"{where} [{media}]")


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "clip9.openapi.yaml")
    spec = yaml.safe_load(path.read_text(encoding="utf-8"))

    validate_openapi(spec)
    print(f"OK  structure: {path.name} is a valid OpenAPI {spec['openapi']} document "
          f"({len(spec['paths'])} paths, {len(spec['components']['schemas'])} schemas)")

    checked = failed = 0
    for api_path, item in spec["paths"].items():
        for method, op in item.items():
            if not isinstance(op, dict):
                continue
            for status, resp in (op.get("responses") or {}).items():
                if "$ref" in resp:
                    resp = deref(resp, spec)
                for where, schema, value in iter_examples(
                    resp, spec, f"{method.upper()} {api_path} -> {status}"
                ):
                    checked += 1
                    resolved = expand(schema, spec)
                    errors = sorted(
                        Draft202012Validator(resolved).iter_errors(value),
                        key=lambda e: list(e.absolute_path),
                    )
                    if errors:
                        failed += 1
                        print(f"FAIL example {where}")
                        for err in errors[:4]:
                            loc = "/".join(str(p) for p in err.absolute_path) or "<root>"
                            print(f"       at {loc}: {err.message[:160]}")

    if failed:
        print(f"\nFAILED: {failed}/{checked} examples do not match their schema")
        return 1
    print(f"OK  examples: all {checked} named examples conform to their schemas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
