import numpy as np
from rtgaia_geom import Grid
from rtgaia_plugin_sdk.geometry import grid_from_json, grid_to_json, grids_equal, nifti_bytes, nifti_from_bytes

GRID = Grid(
    size=(6, 5, 4),
    spacing=(0.8, 1.2, 3.0),
    origin=(-10.0, 20.5, 3.25),
    direction=(0, 1, 0, -1, 0, 0, 0, 0, 1),
    frame_of_reference_uid="1.2.3",
)


def test_nifti_round_trip_preserves_grid_and_order() -> None:
    vol = np.arange(4 * 5 * 6, dtype=np.int16).reshape(4, 5, 6)
    arr, grid = nifti_from_bytes(nifti_bytes(vol, GRID), frame_of_reference_uid="1.2.3")
    assert grids_equal(grid, GRID) is None
    assert arr.shape == vol.shape and np.array_equal(arr, vol)


def test_grid_json_round_trip() -> None:
    assert grid_from_json(grid_to_json(GRID)) == GRID
    assert grid_from_json(grid_to_json(GRID, with_for=False), frame_of_reference_uid="1.2.3") == GRID
