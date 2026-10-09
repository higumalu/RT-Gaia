"""契約檔自檢：schema 是合法的 draft 2020-12、範例通過、OpenAPI 可解析。

重跑：uv run --with jsonschema --with pyyaml --with openapi-spec-validator \
    python packages/rtgaia-plugin-api/check_contract.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

HERE = Path(__file__).parent

MANIFEST_EXAMPLE = {
    "id": "acme-nnunet",
    "version": "1.2.0",
    "api_version": "1",
    "label": "nnU-Net OAR",
    "icon": "🧠",
    "licenses": ["Apache-2.0"],
    "soup": [
        {"name": "nnunetv2", "version": "2.8.1", "license": "Apache-2.0", "kind": "library"},
        {"name": "hn-oar-weights", "version": "2026.06", "license": "CC-BY-NC-4.0", "kind": "model-weights"},
    ],
    "required_role": "contourer",
    "capabilities": ["read-image", "write-transient", "audit"],
    "inputs": {
        "image": {"required": True, "format": "nifti", "modalities": ["CT"]},
        "params_schema": {"type": "object", "properties": {"model": {"type": "string", "enum": ["hn", "thorax"]}}},
    },
    "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
    "execution": {"timeout_s": 1800, "progress": "callback", "concurrency": 1},
}

BUNDLE_EXAMPLE = {
    "bundle_version": "1",
    "provenance": {"module_version": "acme-nnunet@1.2.0", "source": "model", "parent_hash": "sha256:" + "0" * 64},
    "structures": [
        {
            "name": "Parotid_L",
            "color_rgb": [255, 200, 0],
            "tg263_code": "Parotid_L",
            "frame_of_reference_uid": "1.2.826.0.1.3680043.8.498.1",
            "mask": {"encoding": "labelmap", "url": "https://plugin.example/jobs/1/seg.nii.gz", "value": 3},
        }
    ],
}


def _hoist_file_refs(spec: dict) -> dict:
    """把 `$ref: schemas/x.schema.json` 掛進 `components/schemas`，其 `$defs` 也一併搬入並改寫參照。

    驗證器解不開相對檔案的 `$ref`；直接內嵌又會讓 schema 內部的 `#/$defs/...` 指到 OpenAPI 根。
    """
    comps = spec.setdefault("components", {}).setdefault("schemas", {})
    hoisted: dict[str, str] = {}

    def rewrite(node: object, prefix: str) -> object:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                return {"$ref": f"#/components/schemas/{prefix}__{ref.removeprefix('#/$defs/')}"}
            if isinstance(ref, str) and ref.startswith("schemas/"):
                return {"$ref": f"#/components/schemas/{hoist(ref)}"}
            return {k: rewrite(v, prefix) for k, v in node.items()}
        if isinstance(node, list):
            return [rewrite(v, prefix) for v in node]
        return node

    def hoist(path: str) -> str:
        if path in hoisted:
            return hoisted[path]
        name = Path(path).name.split(".")[0].replace("-", "_")
        hoisted[path] = name
        schema = json.loads((HERE / path).read_text(encoding="utf-8"))
        schema.pop("$schema", None)
        schema.pop("$id", None)
        for def_name, def_schema in schema.pop("$defs", {}).items():
            comps[f"{name}__{def_name}"] = rewrite(def_schema, name)
        comps[name] = rewrite(schema, name)
        return name

    spec["paths"] = rewrite(spec["paths"], "")
    return spec


def main() -> int:
    ok = True
    for name, example in (("manifest", MANIFEST_EXAMPLE), ("import-bundle", BUNDLE_EXAMPLE)):
        schema = json.loads((HERE / "schemas" / f"{name}.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        errors = sorted(Draft202012Validator(schema).iter_errors(example), key=lambda e: list(e.path))
        for e in errors:
            ok = False
            print(f"{name}: {list(e.path)}: {e.message}")
        print(f"{name}.schema.json: schema valid, example {'OK' if not errors else 'FAILED'}")
    spec = _hoist_file_refs(yaml.safe_load((HERE / "openapi.yaml").read_text(encoding="utf-8")))
    try:
        from openapi_spec_validator import validate  # type: ignore

        validate(spec)
        print("openapi.yaml: valid")
    except ImportError:
        print("openapi.yaml: parsed (openapi-spec-validator not installed, structural check skipped)")
    except Exception as exc:  # noqa: BLE001
        ok = False
        print(f"openapi.yaml: INVALID: {str(exc)[:300]}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
