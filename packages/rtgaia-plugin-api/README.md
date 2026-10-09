# rtgaia-plugin-api

The machine-readable part of the RT-Gaia plugin contract v1, the interface between RT-Gaia (the host) and out-of-process plugin services. This directory contains no runtime code. The normative text is [`docs/plugin-contract.md`](../../docs/plugin-contract.md); the developer guide is [`docs/plugins.md`](../../docs/plugins.md).

| File | Content |
|---|---|
| `openapi.yaml` | OpenAPI 3.1 description of both sides: `x-side: plugin` (endpoints a plugin implements), `x-side: host` (callbacks the host implements), and `x-side: host-ui` (host endpoints that UI bundles call as the signed-in user) |
| `schemas/manifest.schema.json` | JSON Schema (draft 2020-12) of the manifest returned by `GET /manifest` |
| `schemas/import-bundle.schema.json` | JSON Schema of the ImportBundle a plugin returns. It covers structure only; the semantic rules B1–B8 are applied by the host's validator. |
| `check_contract.py` | Self-check of the files above |

The Python SDK in [`packages/rtgaia-plugin-sdk`](../rtgaia-plugin-sdk/) packages these files into its wheel and validates manifests and bundles against them, so plugin developers can check their documents offline.

## Checking the contract files

`check_contract.py` verifies that both schemas are valid JSON Schema draft 2020-12 documents, that an example manifest and an example bundle pass them, and that `openapi.yaml` is a valid OpenAPI document. From the repository root, after `uv sync`:

```sh
uv run python packages/rtgaia-plugin-api/check_contract.py
```

Without the workspace environment, let uv provide the dependencies:

```sh
uv run --no-project --with jsonschema --with pyyaml --with openapi-spec-validator \
    python packages/rtgaia-plugin-api/check_contract.py
```

The script exits with status 0 when every check passes. If `openapi-spec-validator` is not installed, it only parses `openapi.yaml` and says so.
