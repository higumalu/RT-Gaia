"""DIMSE 節點登錄：DB（`dicom_node`）與記憶體兩種實作，同一介面。"""

from __future__ import annotations

from typing import Any

from rtgaia_core.dimse import Node
from rtgaia_core.node_store import MemoryNodes  # noqa: F401  舊路徑仍有效


class DbNodes:
    def __init__(self, engine: Any) -> None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def list(self) -> list[Node]:
        from sqlalchemy import select

        from .models import DicomNodeRow

        async with self.sessions() as s:
            rows = (await s.execute(select(DicomNodeRow).order_by(DicomNodeRow.name))).scalars().all()
            return [_node(r) for r in rows]

    async def get(self, node_id: str) -> Node:
        from .models import DicomNodeRow

        async with self.sessions() as s:
            r = await s.get(DicomNodeRow, node_id)
            if r is None:
                raise KeyError(f"沒有節點 {node_id}")
            return _node(r)

    async def put(self, node: Node) -> Node:
        from .models import DicomNodeRow

        async with self.sessions() as s:
            async with s.begin():
                r = await s.get(DicomNodeRow, node.node_id)
                fields = {k: v for k, v in node.__dict__.items()}
                if r is None:
                    s.add(DicomNodeRow(**fields))
                else:
                    for k, v in fields.items():
                        setattr(r, k, v)
        return node

    async def delete(self, node_id: str) -> None:
        from .models import DicomNodeRow

        async with self.sessions() as s:
            async with s.begin():
                r = await s.get(DicomNodeRow, node_id)
                if r is not None:
                    await s.delete(r)


def _node(r: Any) -> Node:
    return Node(
        node_id=r.node_id,
        name=r.name,
        ae_title=r.ae_title,
        host=r.host,
        port=int(r.port),
        our_calling_aet=r.our_calling_aet,
        move_destination_aet=r.move_destination_aet,
        tls=bool(r.tls),
        supports=dict(r.supports or {}),
        created_by=r.created_by,
        created_at=r.created_at,
        last_echo_at=r.last_echo_at,
        last_echo_ok=r.last_echo_ok,
        role_send=bool(getattr(r, "role_send", True)),
        role_receive=bool(getattr(r, "role_receive", True)),
        inbound_ip=getattr(r, "inbound_ip", None),
        description=str(getattr(r, "description", "") or ""),
        max_pdu=int(getattr(r, "max_pdu", 0) or 0),
        transfer_syntaxes=list(getattr(r, "transfer_syntaxes", None) or []),
    )
