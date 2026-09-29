# Contributors

Thank you to everyone who builds, tests, reports problems, and shares real printer evidence. The project is stronger because of your work!

## Release contributions

| Contributor | Contribution |
| --- | --- |
| [Boardy (@boardyai)](https://x.com/boardyai) | Raises the nozzle-verification question that informs the added printer safety checks. |
| Fable red-team review, shared by David Montgomery | Supplies archive-ambiguity reproductions and hardware-safety review findings used for plate binding, upload checks, temperature policy, and human preflight. Network/security suggestions remain outside this hardware-safety release. |
| [Sebastian (sebas1986)](https://github.com/sebas1986) | Isolates the multi-filament CLI crash with real BambuStudio bisection, contributes per-slot colours and multi-nozzle prime-tower placement, and verifies X2D identification, status, and slicing in [#18](https://github.com/DMontgomery40/bambu-printer-mcp/pull/18). Also isolates FTPS session-host identity and supplies physical X2D USB upload/size/deletion evidence in [#24](https://github.com/DMontgomery40/bambu-printer-mcp/pull/24); that test does not establish MQTT print dispatch. |
| [Stenslaen](https://github.com/Stenslaen) | Traces the delayed H2 crash to OTA model detection, documents a multi-day workaround, and reports unexpected state-transition crashes in [#7](https://github.com/DMontgomery40/bambu-printer-mcp/issues/7). |
| [Alejandro Oñate (alexol91)](https://github.com/alexol91) | Reports the missing machine-template G-code and multi-filament override problems in [#12](https://github.com/DMontgomery40/bambu-printer-mcp/issues/12), with measured output and a proposed fix in [#13](https://github.com/DMontgomery40/bambu-printer-mcp/pull/13). |
| [var-poro](https://github.com/var-poro) | Supplies P2S firmware/MQTT evidence and regression tests in [#15](https://github.com/DMontgomery40/bambu-printer-mcp/pull/15), plus profile-template resolution and inheritance tests in [#16](https://github.com/DMontgomery40/bambu-printer-mcp/pull/16). |
| [John Randall (johntrandall)](https://github.com/johntrandall) | Captures A1 job manifests and contributes the SD-root/project-file fix in [#14](https://github.com/DMontgomery40/bambu-printer-mcp/pull/14). |
| [Kyle Taylor (kyletaylored)](https://github.com/kyletaylored) | Contributes Claude Desktop extension packaging, prompted setup, and the writable-temp-directory fix in [#11](https://github.com/DMontgomery40/bambu-printer-mcp/pull/11). |
| [Quinn (quinnpertuit)](https://github.com/quinnpertuit) | Investigates P2S transfer routing and contributes model-capability and serial-prefix analysis in [#9](https://github.com/DMontgomery40/bambu-printer-mcp/pull/9). The release uses the alternative P2S implementation from #15. |
| [Vail (VailElla)](https://github.com/VailElla) | Contributes the native X2D transport, local eMMC investigation, and hardware evidence in [#10](https://github.com/DMontgomery40/bambu-printer-mcp/pull/10). The optional macOS native route is integrated with shared file/state/preflight checks, complete AMS mappings, helper cancellation, and clean-install coverage. In [#26](https://github.com/DMontgomery40/bambu-printer-mcp/pull/26), replaces misleading partial FTPS listings with read-only, failure-reporting queries and verifies a real X2D empty-root listing; nonempty directories and failure paths use mocked coverage. |

## Project contributors

Thank you also to the existing contributors whose work the project builds on:

- [David Montgomery (DMontgomery40)](https://github.com/DMontgomery40) — project maintainer; contributes the printer-profile, temperature, and hardware-safety reports informing the shared slicing and print checks.
- [rowbotik](https://github.com/rowbotik) — printer, AMS, slicing, and operational work across the existing release history.
- [len-foss](https://github.com/len-foss) — project code contribution.
- [thebitrock](https://github.com/thebitrock) — project code contribution.

See the [full contribution history](https://github.com/DMontgomery40/bambu-printer-mcp/graphs/contributors) for commit authorship. Credit here includes bug reports and reviewed proposals as well as merged code.

## Open-source community and interoperability

Special thanks to [FULU Foundation](https://www.fulu.org/), [Louis Rossmann](https://www.youtube.com/watch?v=1jhRqgHxEP8), and the [OrcaSlicer-bambulab contributors](https://github.com/FULU-Foundation/OrcaSlicer-bambulab) for their work supporting user control and interoperable tools. We support open-source software, repair rights, and a local print workflow that does not require Bambu Studio, Bambu Connect, or Bambu Cloud.

This is community recognition, separate from code authorship in this repository. The optional FULU bridge uses Bambu's networking runtime; see the [FULU setup guide](./docs/FULU.md) for the direct LAN alternative and current validation limits.
