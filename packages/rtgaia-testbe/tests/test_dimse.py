"""DIMSE：節點登錄、C-ECHO、C-FIND、C-STORE（我方 SCU → 對方 SCP）、對方 C-STORE → 我方 SCP → import job →
目錄有新病人、C-GET 就地匯入、C-MOVE 觸發對方送到我方 SCP。對方以 pynetdicom 在測試行程裡假扮（`FakeNode`）。
沒有 DB（記憶體佇列、API 內建 worker、in-process SCP）。
"""

from __future__ import annotations

import socket
import time
from pathlib import Path

import pydicom
import pytest
from pydicom.dataset import Dataset
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class FakeNode:
    """對方的 PACS／TPS：Verification、Storage SCP、Study Root C-FIND／C-GET／C-MOVE（答庫裡的檔）。"""

    def __init__(self, files: list[Path], out_dir: Path) -> None:
        from pynetdicom import AE, AllStoragePresentationContexts, evt
        from pynetdicom.sop_class import (
            StudyRootQueryRetrieveInformationModelFind,
            StudyRootQueryRetrieveInformationModelGet,
            StudyRootQueryRetrieveInformationModelMove,
            Verification,
        )

        self.files = files
        self.datasets = [pydicom.dcmread(str(p)) for p in files]
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.port = _free_port()
        self.ae_title = "FAKEPACS"
        self.received: list[str] = []
        self.move_targets: list[str] = []
        ae = AE(ae_title=self.ae_title)
        # C-GET 的提供者要接受 storage context 的 SCP／SCU 角色協商，才會把 C-STORE 反送回請求端
        for cx in AllStoragePresentationContexts:
            ae.add_supported_context(cx.abstract_syntax, scu_role=True, scp_role=True)
        ae.add_supported_context(Verification)
        ae.add_supported_context(StudyRootQueryRetrieveInformationModelFind)
        ae.add_supported_context(StudyRootQueryRetrieveInformationModelGet)
        ae.add_supported_context(StudyRootQueryRetrieveInformationModelMove)
        # C-MOVE 時對方（這裡）要主動連我方 SCP 送 C-STORE：requested contexts 上限 128，用 curated 的那份
        from pynetdicom import StoragePresentationContexts

        ae.requested_contexts = StoragePresentationContexts
        self.ae = ae
        self.server = ae.start_server(
            ("127.0.0.1", self.port),
            block=False,
            evt_handlers=[
                (evt.EVT_C_STORE, self._store),
                (evt.EVT_C_FIND, self._find),
                (evt.EVT_C_GET, self._get),
                (evt.EVT_C_MOVE, self._move),
            ],
        )

    def stop(self) -> None:
        self.server.shutdown()

    def _matches(self, identifier: Dataset) -> list[Dataset]:
        level = str(identifier.QueryRetrieveLevel)
        out = []
        for ds in self.datasets:
            if (
                level == "STUDY"
                and identifier.get("StudyInstanceUID")
                and ds.StudyInstanceUID != identifier.StudyInstanceUID
            ):
                continue
            if (
                level == "SERIES"
                and identifier.get("SeriesInstanceUID")
                and ds.SeriesInstanceUID != identifier.SeriesInstanceUID
            ):
                continue
            out.append(ds)
        return out

    def _store(self, event):  # type: ignore[no-untyped-def]
        ds = event.dataset
        ds.file_meta = event.file_meta
        p = self.out_dir / f"{ds.SOPInstanceUID}.dcm"
        ds.save_as(str(p), enforce_file_format=True)
        self.received.append(str(p))
        return 0x0000

    def _find(self, event):  # type: ignore[no-untyped-def]
        identifier = event.identifier
        level = str(identifier.QueryRetrieveLevel)
        seen: set[str] = set()
        for ds in self.datasets:
            # 真的 PACS 會停在 C-CANCEL；探測的 StudyInstanceUID 不會命中
            if event.is_cancelled:
                yield 0xFE00, None
                return
            key = (
                ds.StudyInstanceUID if level == "STUDY" else ds.SeriesInstanceUID if level == "SERIES" else ds.PatientID
            )
            if key in seen:
                continue
            if (
                level == "STUDY"
                and identifier.get("StudyInstanceUID")
                and ds.StudyInstanceUID != identifier.StudyInstanceUID
            ):
                continue
            if identifier.get("PatientID") and str(identifier.PatientID).rstrip("*") not in ds.PatientID:
                continue
            if (
                level == "SERIES"
                and identifier.get("StudyInstanceUID")
                and ds.StudyInstanceUID != identifier.StudyInstanceUID
            ):
                continue
            seen.add(key)
            rsp = Dataset()
            rsp.QueryRetrieveLevel = level
            for k in identifier.keys():
                kw = pydicom.datadict.keyword_for_tag(k)
                if kw and kw != "QueryRetrieveLevel" and kw in ds:
                    setattr(rsp, kw, ds.get(kw))
            if level == "STUDY":
                rsp.NumberOfStudyRelatedInstances = sum(
                    1 for d in self.datasets if d.StudyInstanceUID == ds.StudyInstanceUID
                )
            yield 0xFF00, rsp
        yield 0x0000, None

    def _get(self, event):  # type: ignore[no-untyped-def]
        matches = self._matches(event.identifier)
        yield len(matches)
        for ds in matches:
            yield 0xFF00, ds

    def _move(self, event):  # type: ignore[no-untyped-def]
        # 對方要把資料送到 move destination：我們知道我方 SCP 在哪（測試裡由 route_move 設定）
        dest = event.move_destination
        self.move_targets.append(str(dest).strip())
        addr, port = self.destinations[str(dest).strip()]
        matches = self._matches(event.identifier)
        yield addr, port
        yield len(matches)
        for ds in matches:
            yield 0xFF00, ds

    destinations: dict[str, tuple[str, int]] = {}


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def fake(synth: SynthCase, tmp_path: Path) -> FakeNode:
    files = sorted(p for p in synth.root.rglob("*.dcm"))
    node = FakeNode(files, tmp_path / "fake_received")
    yield node  # type: ignore[misc]
    node.stop()


def _wait_job(s: Session, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while True:
        j = s._get(f"/api/v1/jobs/{job_id}")
        if j["status"] in ("done", "failed"):
            return j
        if time.time() > deadline:
            raise TimeoutError(j)
        time.sleep(0.1)


def test_nodes_echo_find_and_send(fake: FakeNode, synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="admin") as s:
        # 節點：壞的拒絕、好的建立、清單
        with pytest.raises(RuntimeError, match="422"):
            s._post("/api/v1/dimse/nodes", {"ae_title": "", "host": "x", "port": 1})
        node = s._post(
            "/api/v1/dimse/nodes",
            {"name": "假 PACS", "ae_title": fake.ae_title, "host": "127.0.0.1", "port": fake.port},
        )
        assert node["our_calling_aet"] == "RTGAIA" and node["move_destination_aet"] == "RTGAIA"
        assert [n["node_id"] for n in s._get("/api/v1/dimse/nodes")] == [node["node_id"]]
        nid = node["node_id"]
        # C-ECHO
        echo = s._post(f"/api/v1/dimse/nodes/{nid}/echo")
        assert echo["ok"] is True and echo["latency_ms"] is not None and echo["node"]["last_echo_ok"] is True
        # 打不到的節點：ok False（不是 500）
        dead = s._post("/api/v1/dimse/nodes", {"ae_title": "NOBODY", "host": "127.0.0.1", "port": _free_port()})
        assert s._post(f"/api/v1/dimse/nodes/{dead['node_id']}/echo")["ok"] is False
        # C-FIND：study 層、series 層
        studies = s._post(f"/api/v1/dimse/nodes/{nid}/find", {"level": "study", "query": {"PatientID": "SYNTH*"}})
        assert studies["total"] == 1 and studies["rows"][0]["StudyInstanceUID"] == synth.plan_ct.study_uid
        series = s._post(
            f"/api/v1/dimse/nodes/{nid}/find",
            {"level": "series", "query": {"StudyInstanceUID": synth.plan_ct.study_uid}},
        )
        assert {r["Modality"] for r in series["rows"]} == {"CT", "RTSTRUCT", "RTDOSE", "RTPLAN", "REG"}
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dimse/nodes/{nid}/find", {"level": "instance", "query": {}})
        # C-STORE 送一個序列到對方
        job = s._post(f"/api/v1/dimse/nodes/{nid}/send", {"series_uids": [synth.plan_ct.series_uid]})
        done = _wait_job(s, job["job_id"])
        assert done["status"] == "done" and done["sent"] == synth.plan_ct.size[2] and done["failed"] == []
        assert len(fake.received) == synth.plan_ct.size[2]
        # 資料頁整個 study／病人送出 → 目錄裡該範圍的全部檔
        all_files = len(fake.files)
        job = s._post(f"/api/v1/dimse/nodes/{nid}/send", {"study_uids": [synth.plan_ct.study_uid]})
        done = _wait_job(s, job["job_id"])
        study_files = sum(1 for d in fake.datasets if d.StudyInstanceUID == synth.plan_ct.study_uid)
        assert done["status"] == "done" and done["sent"] == study_files and done["series_count"] >= 5
        job = s._post(f"/api/v1/dimse/nodes/{nid}/send", {"patient_ids": [fake.datasets[0].PatientID]})
        done = _wait_job(s, job["job_id"])
        assert done["status"] == "done" and done["sent"] == all_files
        assert (
            _wait_job(s, s._post(f"/api/v1/dimse/nodes/{nid}/send", {"study_uids": ["9.9.9"]})["job_id"])["status"]
            == "failed"
        )
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dimse/nodes/{nid}/send", {})
        # 送匯出結果
        s.load_case(
            {
                "primary_series_uid": synth.plan_ct.series_uid,
                "image_series_uids": [synth.plan_ct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [],
                "registration_uids": [],
                "plan_uids": [],
            }
        )
        export = _wait_job(s, s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct"})["job_id"])
        send2 = _wait_job(s, s._post(f"/api/v1/dimse/nodes/{nid}/send", {"export_job_id": export["job_id"]})["job_id"])
        assert send2["status"] == "done" and send2["sent"] == 1
        assert [j["kind"] for j in s._get("/api/v1/jobs", kind="send")] == ["send"] * 5
        # 刪節點
        s._client.delete(f"/api/v1/dimse/nodes/{dead['node_id']}", headers=s._headers)
        assert len(s._get("/api/v1/dimse/nodes")) == 1


def test_receive_via_scp_imports_and_retrieve_get_and_move(
    fake: FakeNode, synth: SynthCase, tmp_path: Path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    scp_port = _free_port()
    monkeypatch.setenv("RTGAIA_SCP_PORT", str(scp_port))
    empty_root = tmp_path / "lib"
    empty_root.mkdir()
    with Session(library_root=str(empty_root), user="admin") as s:
        status = s._get("/api/v1/dimse/status")
        assert (
            status["scp"]["running"] is True
            and status["scp"]["port"] == scp_port
            and status["our_ae_title"] == "RTGAIA"
        )
        assert s.catalog_patients()["total"] == 0
        # 1) 對方主動 C-STORE 一個 CT 序列給我方 SCP → import job → 目錄有病人
        from rtgaia_core import dimse

        us = dimse.Node(
            node_id="us", name="us", ae_title="RTGAIA", host="127.0.0.1", port=scp_port, our_calling_aet=fake.ae_title
        )
        ct_files = sorted(p for p in synth.plan_ct.directory.iterdir() if p.is_file())
        result = dimse.store(us, ct_files)
        assert result["sent"] == len(ct_files)
        deadline = time.time() + 60
        while time.time() < deadline:
            imports = s._get("/api/v1/jobs", kind="import")
            if imports and imports[0]["status"] in ("done", "failed"):
                break
            time.sleep(0.1)
        assert imports and imports[0]["status"] == "done", imports
        assert imports[0]["counts"]["accepted"] == len(ct_files) and imports[0]["requested_by"] == "dimse"
        assert s.catalog_patients()["total"] == 1
        assert imports[0]["detail"]["calling_aet"] == fake.ae_title if "detail" in imports[0] else True
        # 2) C-GET：向對方拉 RTSTRUCT 序列 → 就地匯入
        node = s._post("/api/v1/dimse/nodes", {"ae_title": fake.ae_title, "host": "127.0.0.1", "port": fake.port})
        job = s._post(
            f"/api/v1/dimse/nodes/{node['node_id']}/retrieve", {"series_uids": [synth.plan_rs_uid], "method": "get"}
        )
        done = _wait_job(s, job["job_id"])
        assert done["status"] == "done" and done["method"] == "get" and done["received"] == 1
        assert done["import"]["counts"]["accepted"] == 1
        rt = s.catalog_rt(synth.plan_ct.series_uid)
        assert [r["kind"] for r in rt] == ["rtstruct"]
        # 3) C-MOVE：對方把整個 study 送到我方 SCP（對方要知道 RTGAIA 在哪）
        FakeNode.destinations["RTGAIA"] = ("127.0.0.1", scp_port)
        job = s._post(
            f"/api/v1/dimse/nodes/{node['node_id']}/retrieve",
            {"study_uids": [synth.plan_ct.study_uid], "method": "move"},
        )
        done = _wait_job(s, job["job_id"])
        assert done["status"] == "done" and done["method"] == "move" and done["completed"] == len(fake.files)
        assert fake.move_targets == ["RTGAIA"]
        # C-GET 的匯入在 retrieve job 裡；import job 只有「對方 C-STORE」與「C-MOVE 送來」兩批
        deadline = time.time() + 60
        while time.time() < deadline:
            imports = [j for j in s._get("/api/v1/jobs", kind="import") if j["status"] in ("done", "failed")]
            if len(imports) >= 2:
                break
            time.sleep(0.1)
        assert len(imports) == 2, imports
        latest = imports[0]
        assert latest["status"] == "done"
        # 之前已匯入的是 duplicate_same，其餘 accepted；總數等於全部檔案
        c = latest["counts"]
        assert c["accepted"] + c["duplicate_same"] == len(fake.files) and c["rejected"] == 0
        assert s.catalog_patients()["items"][0]["series_count"] == 8
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dimse/nodes/{node['node_id']}/retrieve", {"method": "move"})
