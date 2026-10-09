"""DIMSE 節點登錄的記憶體實作（從 `db/nodes.py` 抽出；Postgres 實作在 `rtgaia_server.db.nodes.DbNodes`）。"""

from __future__ import annotations

from .dimse import Node


class MemoryNodes:
    def __init__(self) -> None:
        self.nodes: dict[str, Node] = {}

    async def list(self) -> list[Node]:
        return sorted(self.nodes.values(), key=lambda n: n.name)

    async def get(self, node_id: str) -> Node:
        try:
            return self.nodes[node_id]
        except KeyError as exc:
            raise KeyError(f"沒有節點 {node_id}") from exc

    async def put(self, node: Node) -> Node:
        self.nodes[node.node_id] = node
        return node

    async def delete(self, node_id: str) -> None:
        self.nodes.pop(node_id, None)
