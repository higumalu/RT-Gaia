from __future__ import annotations

import numpy as np
import pytest
from rtgaia_geom import IDENTITY_DIRECTION, Grid

FOR_UID = "1.2.826.0.1.3680043.8.498.TEST.PRIMARY"


def rotation_x(deg: float) -> tuple[float, ...]:
    r = np.deg2rad(deg)
    c, s = np.cos(r), np.sin(r)
    return tuple(np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64).flatten().tolist())


def rotation_xy(deg_x: float, deg_y: float) -> tuple[float, ...]:
    rx, ry = np.deg2rad(deg_x), np.deg2rad(deg_y)
    cx, sx, cy, sy = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float64)
    return tuple((my @ mx).flatten().tolist())


@pytest.fixture
def axial_grid() -> Grid:
    return Grid(
        size=(64, 64, 20),
        spacing=(1.0, 1.0, 3.0),
        origin=(-31.5, -31.5, -28.5),
        direction=IDENTITY_DIRECTION,
        frame_of_reference_uid=FOR_UID,
    )


@pytest.fixture
def tilted_grid() -> Grid:
    """gantry tilt 15°：這是最該優先跑的假體。"""
    return Grid(
        size=(64, 64, 20),
        spacing=(1.0, 1.0, 3.0),
        origin=(-31.5, -31.5, -28.5),
        direction=rotation_x(15.0),  # type: ignore[arg-type]
        frame_of_reference_uid=FOR_UID,
    )


@pytest.fixture
def oblique_grid() -> Grid:
    return Grid(
        size=(48, 48, 24),
        spacing=(0.9, 0.9, 2.5),
        origin=(-20.0, -18.0, -30.0),
        direction=rotation_xy(20.0, 12.0),  # type: ignore[arg-type]
        frame_of_reference_uid=FOR_UID,
    )
