from __future__ import annotations

import warnings

import pytest
from rtgaia_core import i18n
from rtgaia_testbe import Session

warnings.filterwarnings("ignore", message=".*httpx.*")


SHIPPED_DEFAULT_LANG = i18n.DEFAULT_LANG


@pytest.fixture(autouse=True)
def _messages_in_source_language(monkeypatch):
    """後端預設英文；測試對原文（繁中）斷言，所以請求沒說語言時回繁中（同前端 `tests/setup.ts`）。"""
    monkeypatch.setattr(i18n, "DEFAULT_LANG", "zh-TW")


@pytest.fixture
def shipped_default_lang(monkeypatch) -> str:
    """要測真正出貨的預設語言時用（把上面的繁中設回來）。"""
    monkeypatch.setattr(i18n, "DEFAULT_LANG", SHIPPED_DEFAULT_LANG)
    return SHIPPED_DEFAULT_LANG


@pytest.fixture
def driver():
    """行程內 driver —— **與前端 e2e 用的是同一份**。"""
    with Session() as s:
        yield s


@pytest.fixture
def client(driver):
    """🔴 與 `driver` **共用同一個 app 實例**。

    兩者若各建一個 app，session 狀態就不共享，而症狀是一整批「404 找不到
    session」——看起來像路由寫錯，其實是測試夾具的問題。
    """
    return driver._client


@pytest.fixture
def app(driver):
    return driver._app


@pytest.fixture
def landmark(driver) -> Session:
    """最常用的假體：小網格、有已知的座標鏈答案。"""
    driver.load("phantom:landmark")
    return driver


@pytest.fixture
def tilt(driver) -> Session:
    driver.load("phantom:gantry_tilt")
    return driver
