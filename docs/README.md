# RT-Gaia documentation

| Document | Audience | Content |
|---|---|---|
| [User guide](user-guide.md) | Clinicians, physicists, dosimetrists, researchers | The library page, the viewer, contouring, dose and DVH, plans, 3D and 4D, measurements, review and export, plugins, phones and tablets, keyboard and mouse reference. |
| [Administration guide](administration.md) | Administrators, hospital IT | Installation from source and with Docker Compose, configuration reference, accounts and roles, audit log, DICOM nodes and the receiver, storage and backups, plugins, security, monitoring, troubleshooting. |
| [DICOM conformance statement](dicom-conformance.md) | PACS and TPS integration | Network services and SOP classes, transfer syntaxes, association policies, objects RT-Gaia creates, character sets, security. |
| [Architecture](architecture.md) | Developers | The shared 3D + time space, package layering, data flow, rendering, multi-user model, jobs, plugin host, testing strategy. |
| [Architecture diagrams](diagrams.md) | Developers | Mermaid class diagrams and flowcharts of the whole repository: packages, deployment, geometry, application state, persistence, viewer core, plugin SDK; request pipeline, import, opening a case, rendering, editing, push, jobs, events, plugin runs, review and export. |
| [Plugin guide](plugins.md) | Plugin developers | Writing a plugin with the Python SDK or in any language, UI bundles, the contract checker, registering a plugin, examples. |
| [Plugin contract](plugin-contract.md) | Plugin developers | The normative contract v1: endpoints, manifest, job lifecycle, ImportBundle, validation rules, error codes, limits. |

In the repository root: [README](../README.md), [CHANGELOG](../CHANGELOG.md),
[CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md) and
[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md). The machine-readable plugin contract (OpenAPI and JSON
Schema) is in [`packages/rtgaia-plugin-api/`](../packages/rtgaia-plugin-api/).
