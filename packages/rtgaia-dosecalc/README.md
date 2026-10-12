# rtgaia-dosecalc

Dose calculation for RT-Gaia: the calculation package format, beam geometry (IEC 61217 → patient LPS),
phantoms for testing, and engines that run as separate processes.

- `pipeline-test`: a deterministic attenuation model used only to test the calculation pipeline and the
  beam geometry. It is not a dose calculation and is offered only when `RTGAIA_DOSECALC_TEST_ENGINE=1`.
- `topas`: Monte Carlo with OpenTOPAS (Geant4) run in the official container image
  (`opentopas/opentopas:v4.3.0-geant4-11.4.2`); needs docker and the Geant4 11.4 datasets (`RTGAIA_G4DATA`).

```
rtgaia-dosecalc run --input DIR --output DIR [--engine topas]
```
