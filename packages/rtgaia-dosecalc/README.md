# rtgaia-dosecalc

Dose calculation for RT-Gaia: the calculation package format, beam geometry (IEC 61217 → patient LPS),
phantoms for testing, and engines that run as separate processes.

- `pipeline-test`: a deterministic attenuation model used only to test the calculation pipeline and the
  beam geometry. It is not a dose calculation and is offered only when `RTGAIA_DOSECALC_TEST_ENGINE=1`.
- `geant4`: Monte Carlo with Geant4 through `geant4-pybind` (install the `geant4` extra).

```
rtgaia-dosecalc run --input DIR --output DIR [--engine geant4]
```
