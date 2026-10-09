"""病例與 session 的登記處（`SessionStore`）—— 從 `state.py` 搬出來。

**單一行程、無資料庫**的記憶體索引：session、病例、依使用者／study／序列／結構找回 session、過期與淘汰。
`state.py` 原樣再匯出（`from .state import SessionStore` 照舊）。
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from rtgaia_geom.hashing import digest

from . import render3d_vtk
from .state import SESSION_IDLE_SECONDS, Case, Session


class AmbiguousLookup(LookupError):
    """同一個 id 落在請求者開著的兩個以上病例（API 回 409 `AMBIGUOUS_SESSION`）：要帶 `X-RTGaia-Session` 指定。"""

    def __init__(self, object_id: str, study_ids: list[str]) -> None:
        super().__init__("這個 id 在你開著的多個病例裡都有；請帶 X-RTGaia-Session 標頭指定 session")
        self.object_id = object_id
        self.study_ids = study_ids


class SessionStore:
    """**單一行程、無資料庫**。最近建立的即為預設 session。"""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._by_user_study: dict[tuple[str, str], str] = {}
        self._cases: dict[str, Case] = {}
        self.current_id: str | None = None
        """最近建立的 session（驗證腳本與舊 client 的「current」）。每個人各有自己的 `current_for(user)`。"""
        self._current_by_user: dict[str, str] = {}

    # ── Case ─────────────────────────────────────────────────────

    def case(self, case_id: str) -> Case:
        if case_id not in self._cases:
            raise KeyError(f"沒有 case {case_id}")
        return self._cases[case_id]

    def cases(self) -> list[Case]:
        return sorted(self._cases.values(), key=lambda c: c.updated_at, reverse=True)

    def case_by_selection(self, selection_hash: str) -> Case | None:
        """`POST /sessions` 的冪等：同一組選取回同一個 Case（編輯、簽核、量測都還在）。"""
        return next((c for c in self._cases.values() if c.selection_hash == selection_hash), None)

    def register_case(self, case: Case) -> Case:
        """把（從 DB 重組的）Case 放進記憶體，還沒有任何 session 指著它。"""
        self._cases[case.case_id] = case
        return case

    def sessions_of(self, case_id: str) -> list[Session]:
        return [s for s in self._sessions.values() if s.case.case_id == case_id]

    def put(self, session: Session) -> Session:
        """登錄一個 session，並**汰除同一個 study 的舊 session**。

        🔴 不汰除的話，`by_structure()` / `by_series()` 的掃描式查找會撞到舊的
        那一個——症狀是「重新載入同一個病例後，編輯打到過期的 session，
        `client_seq` 與 `content_hash` 都是上一輪的」。這個缺陷在行程內測試看
        不到（每個測試各有一個 app），只有真 socket 的 e2e 會踩到。
        """
        # 只汰除**同一個人**在同一個 study 的舊 session；別人的留著（4–8 人同時開同一病例）
        key = (session.user, session.dataset.study_id)
        previous = self._by_user_study.get(key)
        if previous is not None and previous != session.session_id:
            self._drop_session(previous, keep_case=session.case)
        self._sessions[session.session_id] = session
        self._cases[session.case.case_id] = session.case
        self._by_user_study[key] = session.session_id
        self.current_id = session.session_id
        self._current_by_user[session.user] = session.session_id
        self.expire_idle()
        return session

    def _drop_session(self, session_id: str, *, keep_case: Case | None = None) -> None:
        old = self._sessions.pop(session_id, None)
        if old is None:
            return
        # session 的 3D 離屏視窗跟著走（沒畫過 3D 的話是 no-op）
        render3d_vtk.drop_scene(session_id)
        for k, v in list(self._by_user_study.items()):
            if v == session_id:
                del self._by_user_study[k]
        for u, v in list(self._current_by_user.items()):
            if v == session_id:
                del self._current_by_user[u]
        if self.current_id == session_id:
            self.current_id = next(reversed(self._sessions), None) if self._sessions else None
        # 這個人對這個病例的最後一條 session 走了 → 暫存結果銷毀（grace ＝ SESSION_IDLE_SECONDS，30 min）
        if not any(s.case is old.case and s.user == old.user for s in self._sessions.values()):
            old.case.drop_transient(old.user)
            old.case.drop_derived_doses(old.user)  # 劑量運算的暫存結果同一個生命週期
        # 舊 session 的 Case 若沒有任何 session 指著、也不是可重用的（有 selection_hash）就一起清
        if old.case is not keep_case:
            still_used = any(s.case is old.case for s in self._sessions.values())
            if not still_used and old.case.selection_hash is None:
                self._cases.pop(old.case.case_id, None)

    def adopt_work_sets_in_memory(self, case: Case) -> list[dict[str, Any]]:
        """2026-09-18：記憶體裡別的病例（同 FoR、不同選取）的工作集搬進這個病例（沒有 DB 時的版本；有 DB 時只負責
        把舊病例記憶體裡的那份拿掉，DB 那邊由 `CaseStore.adopt_work_sets` 搬）。"""
        fors = {fg.frame_of_reference_uid for fg in case.frame_groups}
        moved: list[dict[str, Any]] = []
        for other in list(self._cases.values()):
            if other is case:
                continue
            for ws in [
                w for w in other.structure_sets if w.get("kind") == "work" and w.get("frame_of_reference_uid") in fors
            ]:
                keys = [k for k, st in other.structures.items() if st.structure_set_id == ws["structure_set_id"]]
                if any(k in case.structures for k in keys):
                    moved.append(
                        {
                            "structure_set_id": ws["structure_set_id"],
                            "from_case_id": other.case_id,
                            "skipped": [k[0] for k in keys if k in case.structures],
                        }
                    )
                    continue
                for k in keys:
                    case.structures[k] = other.structures.pop(k)
                other.structure_sets[:] = [
                    w for w in other.structure_sets if w["structure_set_id"] != ws["structure_set_id"]
                ]
                case.structure_sets[:] = [
                    w for w in case.structure_sets if w["structure_set_id"] != ws["structure_set_id"]
                ]
                case.structure_sets.append(ws)
                other.touch()
                case.touch()
                moved.append(
                    {
                        "structure_set_id": ws["structure_set_id"],
                        "from_case_id": other.case_id,
                        "structure_ids": [k[0] for k in keys],
                        "owner": ws.get("owner"),
                    }
                )
        return moved

    def expire_idle(self, *, max_idle_seconds: float = SESSION_IDLE_SECONDS, now: datetime | None = None) -> list[str]:
        """沒有 WS 連線且斷線超過 `max_idle_seconds` 的 session 清掉（過期制）。回傳清掉的 id。
        session 都走了的 library 病例（體素在記憶體裡）也一起淘汰 —— 只在 `evict_library_cases`
        （有 DB，能從 DB／檔案重建）時；沒有 DB 的病例淘汰了就沒了，所以留著。"""
        now = now or datetime.now(UTC)
        gone: list[str] = []
        for s in list(self._sessions.values()):
            if s.connections > 0 or s.disconnected_at is None:
                continue
            if (now - datetime.fromisoformat(s.disconnected_at)).total_seconds() > max_idle_seconds:
                gone.append(s.session_id)
        for sid in gone:
            self._drop_session(sid)
        if gone and self.evict_library_cases:
            self.evict_orphan_cases()
        return gone

    evict_library_cases: bool = False
    """有 DB 時由 AppState 設 True：沒有 session 指著的 library 病例可以從記憶體丟掉、之後由 `case_async` 重建。"""

    def evict_orphan_cases(self) -> list[str]:
        """把沒有任何 session 指著、且能重建（有 selection_hash ＝ library 病例，DB 有它）的病例從記憶體拿掉。
        回傳丟掉的 case_id。體素、暫存集索引、3D 場景都跟著 Case 物件走。"""
        used = {s.case.case_id for s in self._sessions.values()}
        gone = [cid for cid, c in self._cases.items() if cid not in used and c.selection_hash is not None]
        for cid in gone:
            self._cases.pop(cid, None)
        return gone

    def release_session(self, session_id: str, *, allow_evict: bool) -> dict[str, Any]:
        """使用者明確「關閉病例」—— 丟 session（WS、3D 場景、暫存集 grace 照 `_drop_session`），
        病例沒別人在看就連體素一起丟（`allow_evict`＝有 DB 才敢）。回傳前端重載要用的 selection。"""
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(session_id)
        case = session.case
        selection = getattr(case, "selection", None)
        self._drop_session(session_id)
        evicted = False
        if allow_evict and case.selection_hash is not None and not any(s.case is case for s in self._sessions.values()):
            self._cases.pop(case.case_id, None)
            evicted = True
        return {
            "released": session_id,
            "case_id": case.case_id,
            "selection": dict(selection) if isinstance(selection, dict) else None,
            "case_evicted": evicted,
        }

    def current_for(self, user: str | None) -> Session:
        """某個人最近的 session；沒有就退回全域 current（驗證腳本、匿名）。"""
        if user and user in self._current_by_user and self._current_by_user[user] in self._sessions:
            return self._sessions[self._current_by_user[user]]
        return self.current()

    def by_display_grid(self, display_grid_id: str) -> Session | None:
        return next((s for s in self._sessions.values() if s.display_grid.display_grid_id == display_grid_id), None)

    def get(self, session_id: str) -> Session:
        if session_id not in self._sessions:
            raise KeyError(f"沒有 session {session_id}")
        return self._sessions[session_id]

    def by_study(self, study_id: str, *, user: str | None = None, strict: bool = False) -> Session:
        """該 study 的 session：先找這個人的，再找最近的任何一個（Case 級的操作用哪個 session 都一樣）。

        `strict=True`：只回這個人自己的 session，沒有就 KeyError —— 網格重新協商、
        高品質重切這類**個人顯示狀態**（Tier、DisplayGrid）不能退回別人的 session，否則 A 的請求會改到 B 的畫面。
        """
        if user is not None:
            sid = self._by_user_study.get((user, study_id))
            if sid in self._sessions:
                return self._sessions[sid]
            if strict:
                raise KeyError(f"{user} 沒有 study {study_id} 的 session")
        for s in self._preferred_order():
            if s.dataset.study_id == study_id:
                return s
        # 方便驅動腳本：study_id 給 "current" 就取當前 session
        if study_id in ("current", "_") and self.current_id:
            return self._sessions[self.current_id]
        raise KeyError(f"沒有 study {study_id}")

    def by_series(self, series_id: str) -> Session:
        """以 series 找 session。**先看當前 session**，再掃描。

        掃描式查找在多 session 時本質上是有歧義的；優先看 current 讓「剛載入的
        那個病例」永遠勝出，這與使用者的心智模型一致。
        """
        for s in self._preferred_order():
            if any(x.series_id == series_id for x in s.dataset.series):
                return s
        raise KeyError(f"沒有序列 {series_id}")

    def own_current(self, user: str) -> Session:
        """這個人最近的 session；沒有就 KeyError —— 不退回別人的（`current_for` 會退回全域 current）。"""
        sid = self._current_by_user.get(user)
        if sid is not None and sid in self._sessions:
            return self._sessions[sid]
        raise KeyError("這個人沒有開著的 session；請到資料頁選病例")

    def find_own(
        self,
        user: str,
        match: Callable[[Session], bool],
        *,
        object_id: str,
        missing: str,
        session_id: str | None = None,
    ) -> Session:
        """用物件 id（結構、量測）定位 session —— **只在這個人自己的 session 裡找**。

        結構 id 不是全域唯一（來自 ROI 名稱；新建的每個病例都從 `user_001` 編起）。以前掃所有 session、
        最近開的優先：別人或自己另一個分頁剛開的病例有同名結構，改名、刪除、編輯就打到另一位病人。

        * `session_id`（檢視器每個請求都帶 `X-RTGaia-Session`）：只看那一個，而且必須是這個人的。
        * 沒帶：在這個人的 session 裡找；落在兩個以上病例 → `AmbiguousLookup`（409），不猜。
        找不到、或 session 是別人的，都是 KeyError(`missing`)（404，不透露 id 在別人那裡存在）。
        """
        if session_id:
            s = self._sessions.get(session_id)
            if s is None or s.user != user or not match(s):
                raise KeyError(missing)
            return s
        mine = [s for s in self._sessions.values() if s.user == user and match(s)]
        if len({s.case.case_id for s in mine}) > 1:
            raise AmbiguousLookup(object_id, sorted({s.dataset.study_id for s in mine}))
        if not mine:
            raise KeyError(missing)
        return mine[0]

    def by_temporal_group(self, temporal_group_id: str) -> Session:
        for s in self._preferred_order():
            if any(g.temporal_group_id == temporal_group_id for g in s.temporal_groups):
                return s
        raise KeyError(f"沒有時間群組 {temporal_group_id}")

    def by_study_or_current(self, study_id: str | None, *, user: str | None = None) -> Session:
        """端點改以 `study_id` 定位；沒給（舊 client）才退回 current。
        有 `user` 時只退回**他自己的** current，沒有就 KeyError
        （2026-10-09：以前退回全域 current，量測會建到別人的病例）。"""
        if study_id:
            return self.by_study(study_id, user=user)
        if user is not None:
            return self.own_current(user)
        return self.current()

    def _preferred_order(self) -> list[Session]:
        current = self._sessions.get(self.current_id) if self.current_id else None
        others = [s for s in self._sessions.values() if s is not current]
        return ([current] if current else []) + others

    def current(self) -> Session:
        if not self.current_id:
            raise KeyError("尚未載入任何 session（先 POST /_test/load）")
        return self._sessions[self.current_id]

    def all(self) -> list[Session]:
        return list(self._sessions.values())

    def register_transform(self, session: Session, spec: dict[str, Any]) -> str:
        transform_id = digest(spec, prefix="tf_", length=16)
        session.transforms[transform_id] = spec
        session.case.touch()
        return transform_id
