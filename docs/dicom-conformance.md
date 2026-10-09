# RT-Gaia DICOM conformance statement

| Item | Value |
|---|---|
| Product | RT-Gaia |
| Product version | 0.1.0 (pre-release) |
| Document status | Draft |
| Document date | 2026-10-09 |

> **Regulatory status.** RT-Gaia is research software. It is not a medical device, has not been
> cleared or approved by any regulatory authority, and must not be used for clinical decision
> making. Use only de-identified data for testing and demonstrations.

## 1 Conformance statement overview

RT-Gaia is web-based software for viewing, contouring and reviewing radiotherapy images. It
imports CT, MR and PET images, RT Structure Sets, RT Doses, RT Plans and Spatial Registrations;
lets users edit and approve structures; and creates RT Structure Set and RT Dose objects.

On the network, RT-Gaia verifies, queries and retrieves from remote systems (Verification and
Study Root Query/Retrieve as SCU), sends instances (Storage SCU), and receives instances (Storage
SCP and Verification SCP). It does not provide Query/Retrieve services to other systems.

**Table 1-1. Network services**

| SOP class | User of service (SCU) | Provider of service (SCP) |
|---|---|---|
| **Transfer** | | |
| CT Image Storage | Yes | Yes |
| Enhanced CT Image Storage | Yes | Yes |
| MR Image Storage | Yes | Yes |
| Enhanced MR Image Storage | Yes | Yes |
| Positron Emission Tomography Image Storage | Yes | Yes |
| Secondary Capture Image Storage | Yes (note 1) | Yes (note 2) |
| RT Structure Set Storage | Yes | Yes |
| RT Dose Storage | Yes | Yes |
| RT Plan Storage | Yes | Yes |
| Spatial Registration Storage | Yes | Yes |
| Deformable Spatial Registration Storage | Yes | Yes (note 3) |
| Other storage SOP classes | See section 4.2.1.3.5 | See section 4.2.2.4.1 |
| **Query/Retrieve** | | |
| Study Root Query/Retrieve Information Model – FIND | Yes | No |
| Study Root Query/Retrieve Information Model – MOVE | Yes | No |
| Study Root Query/Retrieve Information Model – GET | Yes | No |
| **Connectivity** | | |
| Verification | Yes | Yes |

Notes:

1. As a Storage SCU, RT-Gaia sends instances stored in its library, unchanged, and the RT
   Structure Set and RT Dose instances it creates. An instance can be sent only if it is in the
   library (see note 2).
2. The receiver accepts these SOP classes. Received instances enter the library only if their
   Modality (0008,0060) is one of CT, MR, PT, NM, US, CBCT, RTSTRUCT, RTDOSE, RTPLAN or REG; for
   example, a Secondary Capture image with Modality OT is accepted on the network but not added to
   the library.
3. Deformable Spatial Registration instances are stored but not applied.

**Table 1-2. Media services**

| Media storage application profile | Write files (FSC or FSU) | Read files (FSR) |
|---|---|---|
| None | No | No |

RT-Gaia does not read or write DICOM media or DICOMDIR files. It imports and exports DICOM Part 10
files through its web interface (see section 5).

## 2 Table of contents

1. [Conformance statement overview](#1-conformance-statement-overview)
2. [Table of contents](#2-table-of-contents)
3. [Introduction](#3-introduction)
4. [Networking](#4-networking)
5. [Media interchange](#5-media-interchange)
6. [Support of character sets](#6-support-of-character-sets)
7. [Security](#7-security)
8. [Annexes](#8-annexes)

## 3 Introduction

### 3.1 Revision history

| Document version | Date | Product version | Description |
|---|---|---|---|
| Draft | 2026-10-09 | 0.1.0 (pre-release) | First version |

### 3.2 Audience

This document is for hospital IT staff, PACS and treatment planning system administrators,
integrators and developers who connect RT-Gaia to other DICOM systems. Readers should be familiar
with the DICOM standard and its terminology.

### 3.3 Remarks

- RT-Gaia is research software (see the regulatory notice above).
- A conformance statement alone does not guarantee interoperability. Test the connection to each
  system before relying on it. The export profiles in section 8.1.1 follow known import
  constraints of the target systems but have not been validated with a treatment planning system
  by the RT-Gaia project; validate exported objects with your own systems.
- RT-Gaia uses the open-source libraries pynetdicom for DICOM networking and pydicom for encoding
  and decoding. Some parameters in this document are defaults of these libraries. Values stated for
  a specific library version refer to pynetdicom 3.0.4 and pydicom 3.0.2, the versions locked for
  this release.
- Administration of the settings mentioned here is described in the
  [Administration guide](administration.md).

### 3.4 Terms and definitions

| Term | Definition |
|---|---|
| Abstract syntax | The information agreed to be exchanged between applications; equivalent to a SOP class. |
| Application Entity (AE) | An end point of a DICOM information exchange. |
| AE title | The externally known name of an Application Entity. |
| Association | A network communication channel set up between Application Entities. |
| Library | RT-Gaia's catalog of stored DICOM instances. |
| Node | A remote DICOM system registered in RT-Gaia (AE title, address, roles). |
| Presentation context | The set of DICOM network services used over an association, negotiated between AEs; includes the abstract syntax and transfer syntaxes. |
| SOP class | Service-Object Pair class: a DICOM service applied to an information object. |
| Transfer syntax | The encoding used for exchange of DICOM information objects and messages. |

### 3.5 Abbreviations

| Abbreviation | Meaning |
|---|---|
| ACSE | Association Control Service Element |
| AE | Application Entity |
| DIMSE | DICOM Message Service Element |
| FoR | Frame of Reference |
| IOD | Information Object Definition |
| PACS | Picture Archiving and Communication System |
| PDU | Protocol Data Unit |
| Q/R | Query/Retrieve |
| REG | Spatial Registration |
| SCP | Service Class Provider |
| SCU | Service Class User |
| SOP | Service-Object Pair |
| TPS | Treatment Planning System |
| UID | Unique Identifier |

### 3.6 References

- NEMA PS3, Digital Imaging and Communications in Medicine (DICOM) Standard, available at
  <https://www.dicomstandard.org/current>.

## 4 Networking

### 4.1 Implementation model

#### 4.1.1 Application data flow

```text
                              ┌───────────── RT-Gaia ─────────────┐
Administrator: verify node ──▶│                                   │── C-ECHO ──────────────▶ Remote AE
User: query node ────────────▶│                                   │── C-FIND ──────────────▶ Remote Q/R SCP
User: retrieve ──────────────▶│  RT-Gaia SCU AE                   │── C-MOVE / C-GET ──────▶ Remote Q/R SCP
User: send ──────────────────▶│                                   │── C-STORE ─────────────▶ Remote Storage SCP
                              │                                   │
Library ◀── import ───────────│  RT-Gaia Receiver AE              │◀── C-STORE, C-ECHO ──── Remote Storage SCU
                              └───────────────────────────────────┘
```

#### 4.1.2 Functional definition of AEs

**RT-Gaia SCU AE.** Initiates all associations that RT-Gaia opens: Verification, Study Root
C-FIND, C-MOVE and C-GET, and C-STORE. Users start these activities in the web interface; send and
retrieve operations run as background jobs. During C-GET, the SCU AE also receives the C-STORE
sub-operations on the association it opened.

**RT-Gaia Receiver AE.** A Storage SCP and Verification SCP that waits for associations on a
configurable TCP port. It runs inside the RT-Gaia API process or as a separate process. Each
association is treated as one batch: received instances are written to a staging area and
imported into the library when the association ends. The receiver is off by default.

Both AEs use the same AE title by default (**Our AE title**, default `RTGAIA`). The calling AE title
and the C-MOVE destination AE title can be overridden per remote node.

#### 4.1.3 Sequencing of real-world activities

Retrieval with C-MOVE involves both AEs:

```text
RT-Gaia SCU AE                   Remote Q/R SCP                      RT-Gaia Receiver AE
      │── A-ASSOCIATE-RQ ──────────────▶│                                     │
      │── C-MOVE-RQ (study or series) ─▶│                                     │
      │                                 │── A-ASSOCIATE-RQ ──────────────────▶│  calling AE title checked
      │                                 │── C-STORE-RQ (one per instance) ───▶│  instance staged
      │◀─ C-MOVE-RSP (pending) ─────────│                                     │
      │                                 │── A-RELEASE-RQ ────────────────────▶│  batch imported
      │◀─ C-MOVE-RSP (final) ───────────│                                     │
      │── A-RELEASE-RQ ────────────────▶│                                     │
```

With C-GET, the instances arrive as C-STORE sub-operations on the SCU AE's own association and are
imported after the association ends.

### 4.2 AE specifications

#### 4.2.1 RT-Gaia SCU AE

##### 4.2.1.1 SOP classes

**Table 4.2-1. SOP classes of the RT-Gaia SCU AE**

| SOP class | SOP class UID | SCU | SCP |
|---|---|---|---|
| Verification | 1.2.840.10008.1.1 | Yes | No |
| Study Root Query/Retrieve Information Model – FIND | 1.2.840.10008.5.1.4.1.2.2.1 | Yes | No |
| Study Root Query/Retrieve Information Model – MOVE | 1.2.840.10008.5.1.4.1.2.2.2 | Yes | No |
| Study Root Query/Retrieve Information Model – GET | 1.2.840.10008.5.1.4.1.2.2.3 | Yes | No |
| Storage SOP classes in section 8.8 (column "C-STORE SCU") | see section 8.8 | Yes | No |
| Storage SOP classes in section 8.8 (column "C-GET SCP role") | see section 8.8 | No | Yes, within C-GET only |

##### 4.2.1.2 Association policies

###### General

The DICOM Application Context Name is 1.2.840.10008.3.1.1.1.

**Table 4.2-2. Maximum PDU size received**

| Parameter | Value |
|---|---|
| Maximum PDU size received | 16382 bytes by default; configurable per node from 4096 to 4194304 bytes |

###### Number of associations

Each activity opens its own association, performs its operations one after another and releases
the association. Send and retrieve activities run as background jobs; each job worker process runs
one job at a time, and several worker processes may run in parallel. Verify, detect and query
activities run when users request them and may run in parallel with each other and with jobs.

###### Asynchronous nature

RT-Gaia does not use asynchronous operations. It waits for the response to each request before
sending the next request on the same association. It does not negotiate an Asynchronous Operations
Window.

###### Implementation identifying information

**Table 4.2-3. Implementation identifying information (network)**

| Parameter | Value |
|---|---|
| Implementation Class UID | 1.2.826.0.1.3680043.9.3811.3.0.4 |
| Implementation Version Name | PYNETDICOM_304 |

These values are those of the pynetdicom library version in use (3.0.4) and change with it. They
are not configurable. The Implementation Class UID written into files that RT-Gaia creates is
configured separately (section 8.1.1).

##### 4.2.1.3 Association initiation policy

All associations use the parameters of the remote node: its AE title (Called AE Title), host and
port, the calling AE title (the node's **Our calling AE title**, or **Our AE title**), the
maximum PDU size and the transfer syntaxes.

**Table 4.2-4. Transfer syntaxes proposed in every presentation context**

| Transfer syntax | UID |
|---|---|
| Implicit VR Little Endian | 1.2.840.10008.1.2 |
| Explicit VR Little Endian | 1.2.840.10008.1.2.1 |
| Deflated Explicit VR Little Endian | 1.2.840.10008.1.2.1.99 |
| Explicit VR Big Endian (retired) | 1.2.840.10008.1.2.2 |

This is the default list, in this order. An administrator can configure a node to propose a
different ordered subset of these four transfer syntaxes, for example Implicit VR Little Endian
only. RT-Gaia never proposes a compressed transfer syntax.

Requests use priority LOW (0002H), the library default.

The time limits for these associations are configurable (section 4.4.2): TCP connection 5 s, ACSE
15 s, DIMSE 60 s and network 60 s by default.

###### 4.2.1.3.1 Activity: verify a node

An administrator selects **ECHO** for a node on the **DICOM nodes** page. RT-Gaia opens an
association, sends one C-ECHO request and releases the association. The result and the time of the
attempt are stored with the node.

| Presentation context | Abstract syntax | Transfer syntaxes | Role | Extended negotiation |
|---|---|---|---|---|
| 1 | Verification | Table 4.2-4 | SCU | None |

Status 0000H (Success) marks the node as reachable. Any other status, a rejected association, a
connection failure or a time-out marks it as failed; the user sees the reason.

###### 4.2.1.3.2 Activity: detect supported services

An administrator selects **Detect with C-ECHO** while editing a node. RT-Gaia opens one association
that proposes the presentation contexts below, records which ones the remote system accepts, and
suggests the node's supported services from them (ECHO, FIND, MOVE, GET, STORE). If the FIND
context is accepted, RT-Gaia sends one C-FIND request at STUDY level for a Study Instance UID that
does not exist and expects status 0000H with no matches; the outcome is shown to the
administrator. No C-ECHO request is sent in this activity.

| Abstract syntax | Transfer syntaxes | Role |
|---|---|---|
| Verification | Table 4.2-4 | SCU |
| Study Root Q/R Information Model – FIND | Table 4.2-4 | SCU |
| Study Root Q/R Information Model – MOVE | Table 4.2-4 | SCU |
| Study Root Q/R Information Model – GET | Table 4.2-4 | SCU |
| CT Image Storage | Table 4.2-4 | SCU |
| RT Structure Set Storage | Table 4.2-4 | SCU |
| RT Dose Storage | Table 4.2-4 | SCU |
| RT Plan Storage | Table 4.2-4 | SCU |
| Spatial Registration Storage | Table 4.2-4 | SCU |

###### 4.2.1.3.3 Activity: query a node

A user opens **Import…** › **Pull from a node (C-FIND → C-MOVE / C-GET)** on the library page,
selects a node and enters search criteria. RT-Gaia sends one C-FIND request at STUDY level. When
the user expands a study, RT-Gaia sends a C-FIND request at SERIES level for that study. Each query
uses its own association.

| Presentation context | Abstract syntax | Transfer syntaxes | Role | Extended negotiation |
|---|---|---|---|---|
| 1 | Study Root Q/R Information Model – FIND | Table 4.2-4 | SCU | None |

**Table 4.2-5. Study level keys**

| Attribute | Tag | Use |
|---|---|---|
| Query/Retrieve Level | (0008,0052) | `STUDY` |
| Patient ID | (0010,0020) | Matching key if entered; RT-Gaia appends `*` (prefix match) unless the value already contains `*`. Otherwise returned. |
| Patient's Name | (0010,0010) | Matching key if entered; RT-Gaia searches for `*value*` unless the value already contains `*`. Otherwise returned. |
| Study Instance UID | (0020,000D) | Returned |
| Study Date | (0008,0020) | Matching key if a date range is entered (`from-to`, `from-` or `-to`). Otherwise returned. |
| Study Description | (0008,1030) | Returned |
| Accession Number | (0008,0050) | Returned |
| Modalities in Study | (0008,0061) | Matching key if a modality is entered (upper case). Otherwise returned. |
| Number of Study Related Series | (0020,1206) | Returned |
| Number of Study Related Instances | (0020,1208) | Returned |

**Table 4.2-6. Series level keys**

| Attribute | Tag | Use |
|---|---|---|
| Query/Retrieve Level | (0008,0052) | `SERIES` |
| Study Instance UID | (0020,000D) | Unique key of the selected study |
| Series Instance UID | (0020,000E) | Returned |
| Modality | (0008,0060) | Returned |
| Series Description | (0008,103E) | Returned |
| Series Number | (0020,0011) | Returned |
| Series Date | (0008,0021) | Returned |
| Number of Series Related Instances | (0020,1209) | Returned |

Behavior:

- Return keys are sent with zero length. Identifiers do not contain Specific Character Set
  (0008,0005); use ASCII search values.
- No extended negotiation is used: no relational queries, no fuzzy semantic matching, no
  case-insensitive matching options.
- RT-Gaia accepts at most 500 matches per query. When a further match arrives, it sends C-CANCEL,
  discards the remaining matches and tells the user that the result was truncated.

**Table 4.2-7. C-FIND response status handling**

| Status | Meaning | Behavior |
|---|---|---|
| FF00H, FF01H | Pending | The identifier is added to the results. |
| 0000H | Success | The query ends; the results are displayed. |
| FE00H | Canceled | Expected after RT-Gaia's own C-CANCEL; the results received so far are displayed. |
| Any other status | Failure | The query ends; the results received so far (possibly none) are displayed. The status is not shown to the user. |

If the association cannot be established, the user sees an error.

###### 4.2.1.3.4 Activity: retrieve

The user selects studies or series from the query results and starts the retrieval. RT-Gaia uses
C-GET if the node is marked as supporting GET, and C-MOVE otherwise. The retrieval runs as a
background job with one association. RT-Gaia sends one request per selected study and one per
selected series, one after another:

- STUDY level: Query/Retrieve Level `STUDY` and Study Instance UID.
- SERIES level: Query/Retrieve Level `SERIES` and Series Instance UID. The identifier does not
  include the Study Instance UID, so remote systems that require the higher-level unique key for
  series-level retrieval may refuse these requests.

**C-MOVE**

| Presentation context | Abstract syntax | Transfer syntaxes | Role | Extended negotiation |
|---|---|---|---|---|
| 1 | Study Root Q/R Information Model – MOVE | Table 4.2-4 | SCU | None |

The Move Destination is the node's **C-MOVE destination AE title**, or **Our AE title**. The remote
system must know that AE title with the address and port of RT-Gaia's receiver; the instances
arrive on a separate association to the RT-Gaia Receiver AE, which applies its acceptance policy
(section 4.2.2.4).

**C-GET**

| Presentation context | Abstract syntax | Transfer syntaxes | Role | Extended negotiation |
|---|---|---|---|---|
| 1 | Study Root Q/R Information Model – GET | Table 4.2-4 | SCU | None |
| 2–111 | Storage SOP classes in section 8.8 (column "C-GET SCP role") | Table 4.2-4 | SCP | SCP/SCU role selection, SCP role proposed |

RT-Gaia answers every C-STORE sub-operation with status 0000H and writes the instance to a staging
area. When the association ends, the instances go through the import pipeline (section 4.2.2.4.1).

**Table 4.2-8. C-MOVE and C-GET response status handling**

| Status | Behavior |
|---|---|
| Pending (FF00H) and final responses | RT-Gaia records the Number of Completed and Failed Sub-operations (for C-MOVE also Warning Sub-operations) reported in the responses and shows them in the job result. For C-GET, the job result also shows the number of instances received. |
| Any final status | The status code itself is not evaluated. A refused or failed request ends the job normally with zero completed sub-operations. |

If the association cannot be established, the job fails with an error.

###### 4.2.1.3.5 Activity: send

Users send data in these ways:

- a patient, study or series from the library page (all instances of the selected series; for a
  study or patient, all series in the library that belong to it);
- an RT Structure Set or RT Dose created by RT-Gaia, after export or again from the **Export log**;
- a DICOM service in the viewer's **Plugins** menu, which sends the image series of the current
  case to the node and then waits up to 30 minutes for RTSTRUCT, RTDOSE or REG instances of the
  same study to arrive at the RT-Gaia Receiver AE.

Each send is a background job with one association. RT-Gaia sends one C-STORE request per instance,
one after another. Instances are sent as stored; RT-Gaia does not decompress, compress or otherwise
modify them.

| Presentation context | Abstract syntax | Transfer syntaxes | Role | Extended negotiation |
|---|---|---|---|---|
| 1–120 | Storage SOP classes in section 8.8 (column "C-STORE SCU") | Table 4.2-4 | SCU | None |

Notes:

- An instance stored with an uncompressed transfer syntax is sent on an accepted presentation
  context for its SOP class whose transfer syntax has the same byte order; explicit and implicit
  VR are converted as needed.
- An instance stored with a compressed transfer syntax, or whose SOP class is not in the proposed
  list, cannot be sent; it is counted as failed.
- Sending an RT Dose that RT-Gaia created with its dose operations requires an extra confirmation
  by the user, which is recorded in the audit log.

**Table 4.2-9. C-STORE response status handling**

| Status | Behavior |
|---|---|
| 0000H (Success) | The instance is counted as sent. |
| Any other status, including Warning (B000H, B006H, B007H) | The instance is counted as failed with its status; sending continues with the next instance. |

The job fails if no instance was sent. The job result and the **Export log** show the numbers of
sent and failed instances.

##### 4.2.1.4 Association acceptance policy

The RT-Gaia SCU AE does not accept associations. During C-GET it accepts C-STORE sub-operations
on the association that it opened.

#### 4.2.2 RT-Gaia Receiver AE

##### 4.2.2.1 SOP classes

**Table 4.2-10. SOP classes of the RT-Gaia Receiver AE**

| SOP class | SOP class UID | SCU | SCP |
|---|---|---|---|
| Verification | 1.2.840.10008.1.1 | No | Yes |
| Storage SOP classes in section 8.8 (column "Receiver") | see section 8.8 | No | Yes |

RT-Gaia treats the following storage SOP classes as supported. The others are handled according to
the **Unsupported SOP class** setting (section 4.2.2.4.1).

**Table 4.2-11. Supported storage SOP classes**

| SOP class | SOP class UID |
|---|---|
| CT Image Storage | 1.2.840.10008.5.1.4.1.1.2 |
| Enhanced CT Image Storage | 1.2.840.10008.5.1.4.1.1.2.1 |
| MR Image Storage | 1.2.840.10008.5.1.4.1.1.4 |
| Enhanced MR Image Storage | 1.2.840.10008.5.1.4.1.1.4.1 |
| Positron Emission Tomography Image Storage | 1.2.840.10008.5.1.4.1.1.128 |
| Secondary Capture Image Storage | 1.2.840.10008.5.1.4.1.1.7 |
| RT Structure Set Storage | 1.2.840.10008.5.1.4.1.1.481.3 |
| RT Dose Storage | 1.2.840.10008.5.1.4.1.1.481.2 |
| RT Plan Storage | 1.2.840.10008.5.1.4.1.1.481.5 |
| Spatial Registration Storage | 1.2.840.10008.5.1.4.1.1.66.1 |
| Deformable Spatial Registration Storage | 1.2.840.10008.5.1.4.1.1.66.3 |

##### 4.2.2.2 Association policies

###### General

The DICOM Application Context Name is 1.2.840.10008.3.1.1.1. The receiver does not limit the size
of the PDUs it receives (maximum PDU size received: 0, unlimited).

###### Number of associations

The receiver accepts up to 10 simultaneous associations (the library default). Further requests
are rejected with result 2 (rejected-transient), source 3 (DICOM UL service-provider, presentation
related function) and reason 2 (local-limit-exceeded).

###### Asynchronous nature

Asynchronous operations are not supported.

###### Implementation identifying information

As in Table 4.2-3.

##### 4.2.2.3 Association initiation policy

The RT-Gaia Receiver AE does not initiate associations.

##### 4.2.2.4 Association acceptance policy

The receiver listens on the configured bind address and port (default `0.0.0.0`, port 11112) when
an administrator has turned it on.

**Calling AE title check.** With **Accept unregistered sources** off (the default when RT-Gaia
runs with a database), the receiver accepts an association only if the Calling AE Title matches a
node registered with the receive role (**Can receive (it → us: allowed to C-STORE into our SCP)**)
and, if that node has **Only accept from this IP** set, the association comes from that address.
Otherwise it rejects the association with result 1 (rejected-permanent), source 1 (DICOM UL
service-user) and reason 3 (calling-AE-title-not-recognized). If the node list cannot be read, the
association is rejected. Rejections are counted in **Receiver status**.

The Called AE Title is not checked. User identity negotiation items are ignored.

###### 4.2.2.4.1 Activity: receive instances

A remote system sends instances, either on its own initiative or as C-MOVE sub-operations. Each
association forms one batch. The batch ends when the association is released or aborted, or when
no instance has arrived for the **Batch idle timeout (s)** (default 5 seconds, configurable from 3 to
60). When a batch ends, RT-Gaia queues an import job that:

1. reads each staged file and rejects files without a SOP Instance UID or Series Instance UID, or
   with a Modality that is not CT, MR, PT, NM, US, CBCT, RTSTRUCT, RTDOSE, RTPLAN or REG;
2. compares each instance with the library by SOP Instance UID and SHA-256 digest: an identical
   instance is skipped, and an instance with an existing SOP Instance UID but different content is
   rejected and never overwrites the stored instance;
3. stores accepted instances in the library and updates the catalog.

Instances that the import job does not accept stay in the staging area and do not appear in the
library. The import job result lists them.

**Table 4.2-12. Accepted presentation contexts**

| Abstract syntax | Transfer syntaxes, in order of preference | Role | Extended negotiation |
|---|---|---|---|
| Verification | Implicit VR Little Endian, Explicit VR Little Endian, Deflated Explicit VR Little Endian, Explicit VR Big Endian | SCP | None |
| Storage SOP classes in section 8.8 (column "Receiver") | Implicit VR Little Endian, Explicit VR Little Endian, Deflated Explicit VR Little Endian, Explicit VR Big Endian | SCP | None |

Compressed transfer syntaxes are not accepted. A presentation context that proposes only
compressed transfer syntaxes is rejected (transfer syntaxes not supported); the sending system must
send such instances uncompressed. The receiver selects the first transfer syntax in the order above
that the requester proposed.

**Storage SCP conformance**

- Level of support: the complete data set of each instance, including private attributes, is
  stored as received in a DICOM Part 10 file. RT-Gaia does not coerce or correct attribute values
  of received instances.
- Digital signatures are not verified.
- Duration of storage: until an administrator removes the data from the library; removed data is
  kept in a trash area for a configurable period (14 days by default) and then deleted.
- Access: stored instances are available to RT-Gaia users according to their roles.
- Storage Commitment is not supported.

**Unsupported SOP class setting**

| Setting | Behavior for an instance whose SOP class is not in Table 4.2-11 |
|---|---|
| **Accept and flag (the sender's transfer does not fail)** (default) | The instance is stored in the staging area, counted as unsupported, and answered with 0000H. The import job then applies the rules above. |
| **Reject the instance (reply SOP Class not supported)** | The instance is answered with 0122H and not stored. The association continues. |

**Table 4.2-13. C-STORE response status codes**

| Status | Meaning | Returned when |
|---|---|---|
| 0000H | Success | The instance was written to the staging area. This includes instances that the import job later rejects or skips. |
| 0122H | Refused: SOP class not supported | The SOP class is not supported and the setting is **Reject the instance (reply SOP Class not supported)**. |
| C211H | Error: cannot understand | The instance could not be processed, for example because it could not be written to disk. |

**Verification SCP conformance**

The receiver answers C-ECHO requests with 0000H (Success) on accepted associations.

### 4.3 Network interfaces

#### 4.3.1 Physical network interface

RT-Gaia supports the network interfaces of the host operating system.

#### 4.3.2 Additional protocols

RT-Gaia uses TCP/IP. Host names of remote nodes are resolved by the operating system. RT-Gaia does
not support DHCP, DNS service discovery or time synchronization protocols itself.

#### 4.3.3 IPv4 and IPv6 support

The receiver listens on IPv4 by default (bind address `0.0.0.0`).

### 4.4 Configuration

Administrators configure DICOM networking on the **Service settings** and **DICOM nodes** pages.
Values saved on these pages are stored in the database. Environment variables provide the defaults
(see the [Administration guide](administration.md)).

#### 4.4.1 AE title and presentation address mapping

**Table 4.4-1. Local AE titles**

| Application Entity | Default AE title | Default TCP port | Setting |
|---|---|---|---|
| RT-Gaia SCU AE | `RTGAIA` | Not applicable | **Our AE title**; per node **Our calling AE title** |
| RT-Gaia Receiver AE | `RTGAIA` | 11112 | **Our AE title**, **Receiver port**, **Bind address** |

**Our AE title** is 1 to 16 ASCII characters without spaces; node AE titles are 1 to 16 ASCII
characters.

Remote Application Entities are registered as nodes with these attributes:

| Attribute | Description |
|---|---|
| **Name** | Display name |
| **AE Title** | Called AE Title for associations that RT-Gaia initiates, and Calling AE Title expected from the node |
| **Host / IP** and **Port** | Address of the node; required for the send role |
| **Can send (us → it: ECHO / query / pull / C-STORE)** | The send role: RT-Gaia may initiate associations to the node |
| **Can receive (it → us: allowed to C-STORE into our SCP)** | The receive role: the node may send to the RT-Gaia Receiver AE |
| **Only accept from this IP** | Optional source address check for incoming associations |
| **Supported services** | ECHO, FIND, MOVE, GET, STORE; determines how RT-Gaia retrieves from the node |
| **C-MOVE destination AE title** | Move Destination sent in C-MOVE requests (default: **Our AE title**) |
| **Our calling AE title** | Calling AE Title used towards this node (default: **Our AE title**) |
| **Maximum PDU (bytes)** | Maximum PDU size RT-Gaia announces to this node |
| **Transfer Syntax** | Transfer syntaxes proposed to this node (Table 4.2-4 or a subset) |

#### 4.4.2 Parameters

**Table 4.4-2. Configuration parameters**

| Parameter | Default | Configurable |
|---|---|---|
| TCP connection time-out (SCU) | 5 s | Yes, 1–60 s |
| ACSE time-out (SCU) | 15 s | Yes, 1–3600 s |
| DIMSE time-out (SCU) | 60 s | Yes, 1–3600 s |
| Network time-out (SCU and receiver) | 60 s | Yes, 1–3600 s |
| ACSE and DIMSE time-outs (receiver) | 30 s | No (library defaults) |
| Batch idle time-out (receiver) | 5 s | Yes, 3–60 s |
| Maximum PDU size received (SCU) | 16382 bytes | Yes, per node, 4096–4194304 bytes |
| Maximum PDU size received (receiver) | Unlimited | No |
| Maximum simultaneous associations (receiver) | 10 | No |
| Maximum C-FIND matches per query | 500 | No |
| Wait for returned objects (DICOM service in the **Plugins** menu) | 30 minutes | No |
| Receiver on | Off | Yes |
| Accept unregistered sources | Off with a database, on without | Yes |
| Unsupported SOP class | Accept and flag | Yes |
| UID root for created objects | `1.2.826.0.1.3680043.8.498.` | Yes, `RTGAIA_UID_ROOT` |
| Implementation Class UID of created files | `1.2.826.0.1.3680043.8.498.1` | Yes, `RTGAIA_IMPLEMENTATION_CLASS_UID` |
| Default RT Structure Set export profile | Varian Eclipse (`varian`) | Yes, `RTGAIA_EXPORT_PROFILE`, and per export |

Changing **Our AE title**, **Receiver (SCP) on**, **Receiver port**, **Bind address** or the network
time-out restarts the receiver.

## 5 Media interchange

RT-Gaia does not support DICOM media storage application profiles and does not read or write
DICOMDIR files. It exchanges DICOM Part 10 files through its web interface:

- **Import.** Users upload files, folders or zip archives, or import a directory on the server.
  Only files with the 128-byte preamble followed by `DICM` are accepted. All imported files go
  through the import pipeline described in section 4.2.2.4.1; files are stored as received,
  including compressed pixel data (see section 8.7 for decoding).
- **Export.** RT Structure Set and RT Dose instances created by RT-Gaia are downloaded as Part 10
  files in Explicit VR Little Endian (section 8.1.1). Patients, studies and series in the library
  are downloaded as zip archives of the original files, without modification. Archive members are
  named `<Series Instance UID>/<SOP Instance UID>.dcm` for a series and
  `<Study Instance UID>/<Series Instance UID>/<SOP Instance UID>.dcm` for a study or patient; the
  archive itself is named after the Patient ID or UID that was selected.

## 6 Support of character sets

**Received and imported instances** are stored unchanged. RT-Gaia decodes text with pydicom
according to Specific Character Set (0008,0005), including the single-byte character sets, ISO
2022 code extensions and UTF-8 (ISO_IR 192) that pydicom supports. The user interface displays
Unicode text.

**C-FIND identifiers** sent by RT-Gaia do not contain Specific Character Set; search values should
be ASCII.

**Created instances**:

| Object | Specific Character Set (0008,0005) |
|---|---|
| RT Structure Set, generic profile | `ISO_IR 192` |
| RT Structure Set, Varian Eclipse profile | Not written if all text is ASCII (the profile converts structure set and ROI text to ASCII); `ISO_IR 192` if text outside ASCII remains, for example a patient name when de-identification is off |
| RT Dose | Not written if all text is ASCII; otherwise `ISO_IR 192` |

## 7 Security

### 7.1 Security profiles

RT-Gaia does not support any DICOM security profile. In particular, it does not support the Basic
TLS Secure Transport Connection Profile, digital signatures or the Audit Trail Message Format
Profile.

### 7.2 Association level security

- The receiver accepts associations only from registered calling AE titles, optionally bound to
  a source IP address (section 4.2.2.4), unless an administrator allows unregistered sources.
- RT-Gaia initiates associations only to nodes that an administrator has registered with the
  send role.
- AE titles and IP addresses are not strong authentication, and DICOM traffic is not encrypted.
  Operate RT-Gaia's DICOM services only on a trusted network and restrict the receiver port with a
  firewall.

### 7.3 Application level security

- Access to RT-Gaia's web interface requires an account when RT-Gaia runs with a database.
  Querying, retrieving and sending require the `contourer` role or higher; registering nodes and
  changing DICOM settings require the `admin` role.
- RT-Gaia's audit log records DICOM operations that users start (verify, detect, query, retrieve,
  send) with the user, time and node. Associations received by the receiver are recorded as import
  jobs, not in the audit log.
- Created objects are de-identified by default (section 8.1.1).

## 8 Annexes

### 8.1 IOD contents

#### 8.1.1 Created SOP instances

RT-Gaia creates RT Structure Set instances (export of structures) and RT Dose instances (results of
dose operations). It does not create images. Both are written as Part 10 files with this file meta
information:

| Attribute | Tag | Value |
|---|---|---|
| Media Storage SOP Class UID | (0002,0002) | SOP class of the instance |
| Media Storage SOP Instance UID | (0002,0003) | SOP Instance UID of the instance |
| Transfer Syntax UID | (0002,0010) | 1.2.840.10008.1.2.1 (Explicit VR Little Endian) |
| Implementation Class UID | (0002,0012) | `RTGAIA_IMPLEMENTATION_CLASS_UID`, default 1.2.826.0.1.3680043.8.498.1 |
| Implementation Version Name | (0002,0013) | `RTGAIA_0_1` |

**UIDs.** New SOP Instance UIDs and Series Instance UIDs start with the root configured in
`RTGAIA_UID_ROOT` (default 1.2.826.0.1.3680043.8.498., the pydicom root) followed by a random
suffix; with the root `2.25`, RT-Gaia generates UUID-derived UIDs. RT-Gaia refuses to start with an
invalid root. The Study Instance UID and Frame of Reference UID are those of the referenced images.

**De-identification.** By default, created objects contain placeholder patient identification:

| Attribute | Tag | De-identified value |
|---|---|---|
| Patient's Name | (0010,0010) | `PHANTOM^RTGAIA` |
| Patient ID | (0010,0020) | `RTGAIA-TESTBE` |
| Patient's Birth Date | (0010,0030) | Empty |
| Patient's Sex | (0010,0040) | Empty |

All de-identified objects share these values unless the user enters other values (see editable
attributes below). De-identification affects only these patient attributes: UIDs that link the
object to the original study and images, the exporting user's name (Operators' Name and the
generated descriptions) and structure names remain. It is not a de-identification profile as
defined in PS3.15. When the user turns de-identification off, and always when an object is saved to
RT-Gaia's own library, RT-Gaia copies these attributes from the first image of the referenced
series: Patient's Name, Patient ID, Patient's Birth Date, Patient's Sex, Study ID, Study Date, Study
Time, Study Description, Accession Number and Referring Physician's Name.

**Editable attributes.** Before export, users may set these attributes; values are checked for VR
and length:

| Attribute | Tag | RT Structure Set | RT Dose |
|---|---|---|---|
| Structure Set Label | (3006,0002) | Yes | No |
| Structure Set Name | (3006,0004) | Yes | No |
| Structure Set Description | (3006,0006) | Yes | No |
| Series Description | (0008,103E) | Yes | Yes |
| Series Number | (0020,0011) | Yes | Yes |
| Operators' Name | (0008,1070) | Yes | Yes |
| Referring Physician's Name | (0008,0090) | Yes | Yes |
| Institution Name | (0008,0080) | Yes | Yes |
| Station Name | (0008,1010) | Yes | Yes |
| Study Description | (0008,1030) | Yes | Yes |
| Accession Number | (0008,0050) | Yes | Yes |
| Patient's Name | (0010,0010) | Yes | Yes |
| Patient ID | (0010,0020) | Yes | Yes |
| Patient's Birth Date | (0010,0030) | Yes | Yes |
| Patient's Sex | (0010,0040) | Yes | Yes |

##### 8.1.1.1 RT Structure Set

RT-Gaia exports the structures selected by the user for one target image series (one frame of
reference; for 4D series, one phase). Selected structures in another frame of reference or another
phase are skipped and listed in the export result. Contours are extracted from the structure masks
on the image planes of that series with a marching-squares algorithm at the boundary of the mask.
Each contour is written as CLOSED_PLANAR; inner boundaries (holes) are written as separate closed
contours on the same plane; contours with fewer than three points are omitted. A structure without
voxels is written with an empty Contour Sequence.

**Export profiles**

| Profile | Rules |
|---|---|
| Varian Eclipse (`varian`, default) | ROI names are reduced to printable ASCII, at most 16 characters and unique without regard to case (a suffix `_2`, `_3`, … is added); the original name is kept in ROI Description. Structure Set Label (16), Series Description (64) and Structure Set Description (1024) are converted to ASCII. |
| Generic (`generic`) | Names and texts are written unchanged in UTF-8. |
| Both | RT ROI Interpreted Type comes from the source structure set if it is a defined term; otherwise it is derived from the name (BODY, EXTERNAL, SKIN and similar → EXTERNAL; names starting with PTV, CTV or GTV → that type; COUCH or TABLE → SUPPORT; BOLUS → BOLUS; others → ORGAN). If more than one ROI is EXTERNAL, one keeps that type and the others become ORGAN. Every change is listed in the export result. |

**Table 8.1-1. RT Structure Set attributes written**

| Module | Attribute | Tag | Value |
|---|---|---|---|
| Patient | Patient's Name, Patient ID, Patient's Birth Date, Patient's Sex | (0010,0010), (0010,0020), (0010,0030), (0010,0040) | De-identified or copied from the image (see above) |
| General Study | Study Instance UID | (0020,000D) | Of the referenced images |
| General Study | Study Date | (0008,0020) | From the image when de-identification is off; otherwise the export date |
| General Study | Study Time, Study ID, Study Description, Accession Number, Referring Physician's Name | (0008,0030), (0020,0010), (0008,1030), (0008,0050), (0008,0090) | Copied from the image when de-identification is off and the image has a value; otherwise not written |
| RT Series | Modality | (0008,0060) | `RTSTRUCT` |
| RT Series | Series Instance UID | (0020,000E) | New UID |
| RT Series | Series Number | (0020,0011) | `1` |
| RT Series | Series Description | (0008,103E) | Generated description (see Structure Set Description), at most 64 characters |
| RT Series | Operators' Name | (0008,1070) | User name of the exporting user |
| General Equipment | Manufacturer, Manufacturer's Model Name | (0008,0070), (0008,1090) | `RT-Gaia` |
| General Equipment | Software Versions | (0018,1020) | `0.1.0` |
| Structure Set | Structure Set Label | (3006,0002) | If all structures come from one plugin: the first six characters of the plugin ID and the date; otherwise, if they come from one working set: its label; otherwise `RTGAIA` and the date. ` DRAFT` is appended if a structure is not approved and the label fits in 16 characters. |
| Structure Set | Structure Set Description | (3006,0006) | Export date, source (plugin or manual), exporting user, number of ROIs and approval state. English ASCII text with the Varian Eclipse profile; Traditional Chinese text with the generic profile. |
| Structure Set | Structure Set Date, Structure Set Time | (3006,0008), (3006,0009) | Time of export (server local time) |
| Structure Set | Referenced Frame of Reference Sequence | (3006,0010) | One item |
| | > Frame of Reference UID | (0020,0052) | Of the target image series |
| | > RT Referenced Study Sequence | (3006,0012) | One item: Referenced SOP Class UID 1.2.840.10008.3.1.2.3.1, Referenced SOP Instance UID = Study Instance UID |
| | >> RT Referenced Series Sequence | (3006,0014) | One item: Series Instance UID of the target series |
| | >>> Contour Image Sequence | (3006,0016) | Every image of the series: Referenced SOP Class UID, Referenced SOP Instance UID, and Referenced Frame Number for enhanced multi-frame images |
| Structure Set | Structure Set ROI Sequence | (3006,0020) | One item per structure: ROI Number (1, 2, …), Referenced Frame of Reference UID, ROI Name, ROI Description (only if the profile changed the name), ROI Generation Algorithm (`AUTOMATIC` for structures produced by a model, `SEMIAUTOMATIC` otherwise) |
| ROI Contour | ROI Contour Sequence | (3006,0039) | One item per structure: Referenced ROI Number, ROI Display Color, Contour Sequence |
| | > Contour Sequence | (3006,0040) | Contour Geometric Type `CLOSED_PLANAR`, Number of Contour Points, Contour Data (patient coordinates in mm), Contour Image Sequence (the image on whose plane the contour lies) |
| RT ROI Observations | RT ROI Observations Sequence | (3006,0080) | One item per structure: Observation Number, Referenced ROI Number, RT ROI Interpreted Type, ROI Interpreter (empty) |
| SOP Common | SOP Class UID | (0008,0016) | 1.2.840.10008.5.1.4.1.1.481.3 |
| SOP Common | SOP Instance UID | (0008,0018) | New UID |
| SOP Common | Specific Character Set | (0008,0005) | See section 6 |

Editable attributes (section 8.1.1) are applied last and override the values above.

##### 8.1.1.2 RT Dose

Users save the result of a dose operation as RT Dose. Dose operations add or subtract two doses
(the second dose is resampled onto the grid of the first, through a rigid registration if they
are in different frames of reference), multiply or divide a dose by a positive constant, sum the
beam doses of a plan into a plan dose, or move a dose into another frame of reference through a
registration. The result is on a regular grid in Gy.

**Table 8.1-2. RT Dose attributes written**

| Module | Attribute | Tag | Value |
|---|---|---|---|
| Patient | Patient's Name, Patient ID, Patient's Birth Date, Patient's Sex | (0010,0010), (0010,0020), (0010,0030), (0010,0040) | De-identified or copied from the image (see section 8.1.1) |
| General Study | Study Instance UID | (0020,000D) | Of the images in the dose's frame of reference |
| General Study | Study ID, Accession Number, Referring Physician's Name | (0020,0010), (0008,0050), (0008,0090) | Copied from the image when de-identification is off; otherwise empty |
| General Study | Study Date, Study Time | (0008,0020), (0008,0030) | Copied from the image when de-identification is off; otherwise the time of saving |
| RT Series | Modality | (0008,0060) | `RTDOSE` |
| RT Series | Series Instance UID | (0020,000E) | New UID |
| RT Series | Series Number | (0020,0011) | `1` |
| RT Series | Series Date, Series Time | (0008,0021), (0008,0031) | Time of saving |
| RT Series | Series Description | (0008,103E) | `RT-Gaia dose operation <date>` in the language of the user interface |
| RT Series | Operators' Name | (0008,1070) | User name of the saving user |
| Frame of Reference | Frame of Reference UID | (0020,0052) | Of the result grid |
| Frame of Reference | Position Reference Indicator | (0020,1040) | Empty |
| General Equipment | Manufacturer, Manufacturer's Model Name | (0008,0070), (0008,1090) | `RT-Gaia` |
| General Equipment | Software Versions | (0018,1020) | `0.1.0` |
| General Image | Instance Number | (0020,0013) | `1` |
| General Image | Content Date, Content Time | (0008,0023), (0008,0033) | Time of saving |
| Image Plane | Image Position (Patient), Image Orientation (Patient) | (0020,0032), (0020,0037) | Of the result grid |
| Image Plane | Pixel Spacing, Slice Thickness | (0028,0030), (0018,0050) | Of the result grid |
| Multi-frame | Number of Frames | (0028,0008) | Number of slices |
| Multi-frame | Frame Increment Pointer | (0028,0009) | (3004,000C) |
| Image Pixel | Samples per Pixel, Photometric Interpretation | (0028,0002), (0028,0004) | `1`, `MONOCHROME2` |
| Image Pixel | Rows, Columns | (0028,0010), (0028,0011) | Of the result grid |
| Image Pixel | Bits Allocated, Bits Stored, High Bit | (0028,0100), (0028,0101), (0028,0102) | `32`, `32`, `31` |
| Image Pixel | Pixel Representation | (0028,0103) | `0` (unsigned); `1` (signed) for Dose Type `ERROR` |
| Image Pixel | Pixel Data | (7FE0,0010) | Dose divided by Dose Grid Scaling. Voxels without data (outside the second dose's grid) are written as 0. |
| RT Dose | Dose Units | (3004,0002) | `GY` |
| RT Dose | Dose Type | (3004,0004) | See Table 8.1-3 |
| RT Dose | Dose Summation Type | (3004,000A) | See Table 8.1-3 |
| RT Dose | Grid Frame Offset Vector | (3004,000C) | Relative offsets starting at 0; negative steps when the slice direction is opposite to the row × column normal |
| RT Dose | Dose Grid Scaling | (3004,000E) | Chosen so that the maximum absolute dose fits the 32-bit range |
| RT Dose | Dose Comment | (3004,0006) | `RT-Gaia: <operation expression>`, at most 64 characters |
| RT Dose | Referenced RT Plan Sequence | (300C,0002) | The plans referenced by the source doses (Referenced SOP Class UID 1.2.840.10008.5.1.4.1.1.481.5) |
| RT Dose | Spatial Transform of Dose | (3004,0005) | `RIGID` when a dose was resampled through a Spatial Registration object; otherwise `NONE` |
| RT Dose | Referenced Spatial Registration Sequence | (0070,0404) | The Spatial Registration objects used, if any |
| General Image | Derivation Code Sequence | (0008,9215) | (121370, DCM, "Composed from prior doses") for addition, subtraction and beam summation; (121378, DCM, "Composed with weighting for fractions delivered") for multiplication and division; not written for a dose that was only moved to another frame of reference |
| General Image | Derivation Description | (0008,2111) | The operation, the source doses with their SOP Instance UIDs, the grid used, whether a registration was used, the note that voxels without data are 0, the user and the time; at most 1024 characters |
| General Image | Referenced Instance Sequence | (0008,114A) | One item per source dose: Referenced SOP Class UID (RT Dose Storage), Referenced SOP Instance UID, Purpose of Reference Code Sequence (121372, DCM, "Source dose for composing current dose") |
| SOP Common | SOP Class UID | (0008,0016) | 1.2.840.10008.5.1.4.1.1.481.2 |
| SOP Common | SOP Instance UID | (0008,0018) | New UID |
| SOP Common | Instance Creation Date, Instance Creation Time | (0008,0012), (0008,0013) | Time of saving |
| SOP Common | Specific Character Set | (0008,0005) | See section 6 |

**Table 8.1-3. Dose Type and Dose Summation Type of created RT Dose**

| Attribute | Rule |
|---|---|
| Dose Type | `PHYSICAL` and `EFFECTIVE` doses cannot be combined. If any source has Dose Type `ERROR`, the result is `ERROR`. A subtraction result is `ERROR` (signed pixel data); if all its values are 0 or greater, the user may save it as `PHYSICAL` after a second confirmation. Otherwise the result has the Dose Type of its sources. |
| Dose Summation Type | `MULTI_PLAN` if the source doses reference two or more different plans; the Dose Summation Type of the first source if they reference one plan (`PLAN` for a beam summation, or if the first source is `MULTI_PLAN`); a result whose sources reference no plan cannot be saved. |

Dose Type, Dose Summation Type and Dose Units cannot be edited.

#### 8.1.2 Usage of attributes from received IODs

RT-Gaia reads the following attributes. Other attributes are stored but not used.

| Object | Attributes used |
|---|---|
| All | SOP Class UID, SOP Instance UID, Modality, Patient ID, Patient's Name (stored only as a keyed hash; displayed only if an administrator enables it), Study and Series Instance UID, Study Date, Study Description, Series Date, Series Time, Series Description, Series Number, Instance Number, Frame of Reference UID, Manufacturer, Manufacturer's Model Name, Transfer Syntax UID |
| CT, MR and PET images | Rows, Columns, Pixel Spacing, Image Orientation (Patient), Image Position (Patient), Slice Thickness, Rescale Slope, Rescale Intercept, Window Center, Window Width, Number of Frames and the functional groups of enhanced multi-frame images; for time series: Temporal Position Identifier, Acquisition Number, Trigger Time, Acquisition Time and Content Time; for PET, the attributes needed to compute SUV |
| RT Structure Set | Structure Set Label, Structure Set Date, Structure Set ROI Sequence, ROI Contour Sequence (Contour Geometric Type, Contour Data), RT ROI Observations Sequence (RT ROI Interpreted Type), Referenced Frame of Reference Sequence |
| RT Dose | Dose Units, Dose Type, Dose Summation Type, Dose Grid Scaling, Grid Frame Offset Vector, Referenced RT Plan Sequence, Derivation Code Sequence, Derivation Description, Dose Comment |
| RT Plan | RT Plan Label, RT Plan Date, Referenced Structure Set Sequence, Dose Reference Sequence, Fraction Group Sequence, Beam Sequence with its control points and beam limiting devices (for display only) |
| Spatial Registration | Registration Sequence, Matrix Registration Sequence, Frame of Reference Transformation Matrix and its type, Referenced Series Sequence, Studies Containing Other Referenced Instances Sequence |

Processing rules:

- **Images.** Slices must form a consistent geometry; series that do not are reported as errors
  when a case is opened.
- **RT Structure Set.** Contours are rasterized onto the grid of the referenced images. Contours
  of type POINT are not rasterized. Nested contours on the same plane are combined so that inner
  contours become holes. A contour farther than half a slice from the nearest image plane is
  rejected rather than moved.
- **RT Dose.** Grid Frame Offset Vector is accepted in relative form (first value 0) and, for axial
  grids, in absolute form; its steps must be uniform. Pixel values are multiplied by Dose Grid
  Scaling. RT-Gaia does not compute dose-volume histograms for doses whose Dose Units is not `GY`.
- **Spatial Registration.** Rigid matrices place series in a common space. Deformable Spatial
  Registration objects are stored but not applied.
- **RT Plan.** Plans are displayed only; RT-Gaia does not calculate dose from plans.

#### 8.1.3 Attribute mapping

RT-Gaia does not use Modality Worklist or Modality Performed Procedure Step. There is no attribute
mapping between them.

#### 8.1.4 Coerced or modified fields

RT-Gaia does not coerce or modify attributes of received instances. Changes that an export profile
makes to created RT Structure Set instances are listed in the export result.

### 8.2 Data dictionary of private attributes

RT-Gaia does not create private attributes. Private attributes of received instances are stored
unchanged and not used.

### 8.3 Coded terminology and templates

RT-Gaia uses these codes from the DICOM Controlled Terminology (coding scheme designator `DCM`) in
created RT Dose instances:

| Code value | Code meaning | Used in |
|---|---|---|
| 121370 | Composed from prior doses | Derivation Code Sequence |
| 121378 | Composed with weighting for fractions delivered | Derivation Code Sequence |
| 121372 | Source dose for composing current dose | Purpose of Reference Code Sequence |

### 8.4 Grayscale image consistency

RT-Gaia does not support the Grayscale Standard Display Function and does not claim grayscale image
consistency.

### 8.5 Standard extended, specialized and private SOP classes

None.

### 8.6 Private transfer syntaxes

None.

### 8.7 Decoding of compressed pixel data

All imported files are stored with their original transfer syntax; RT-Gaia does not transcode
them. Because RT-Gaia negotiates only uncompressed transfer syntaxes on the network (sections
4.2.1.3 and 4.2.2.4.1), compressed files reach the library only by upload or from a server
directory. RT-Gaia decodes compressed pixel data with pydicom and its decoder plug-ins (Pillow,
pylibjpeg-openjpeg and pylibjpeg-rle) when a case is opened.

**Table 8.7-1. Compressed transfer syntaxes**

| Transfer syntax | UID | Decoded |
|---|---|---|
| JPEG Baseline (Process 1) | 1.2.840.10008.1.2.4.50 | Yes |
| JPEG Extended (Process 2 and 4) | 1.2.840.10008.1.2.4.51 | Yes |
| JPEG Lossless, Non-Hierarchical (Process 14) | 1.2.840.10008.1.2.4.57 | No |
| JPEG Lossless, Non-Hierarchical, First-Order Prediction (Process 14, Selection Value 1) | 1.2.840.10008.1.2.4.70 | No |
| JPEG-LS Lossless Image Compression | 1.2.840.10008.1.2.4.80 | No |
| JPEG-LS Lossy (Near-Lossless) Image Compression | 1.2.840.10008.1.2.4.81 | No |
| JPEG 2000 Image Compression (Lossless Only) | 1.2.840.10008.1.2.4.90 | Yes |
| JPEG 2000 Image Compression | 1.2.840.10008.1.2.4.91 | Yes |
| JPEG 2000 Part 2 Multi-component Image Compression (Lossless Only) | 1.2.840.10008.1.2.4.92 | No |
| JPEG 2000 Part 2 Multi-component Image Compression | 1.2.840.10008.1.2.4.93 | No |
| High-Throughput JPEG 2000 Image Compression (Lossless Only) | 1.2.840.10008.1.2.4.201 | Yes |
| High-Throughput JPEG 2000 with RPCL Options Image Compression (Lossless Only) | 1.2.840.10008.1.2.4.202 | Yes |
| High-Throughput JPEG 2000 Image Compression | 1.2.840.10008.1.2.4.203 | Yes |
| RLE Lossless | 1.2.840.10008.1.2.5 | Yes |
| MPEG-2, MPEG-4 AVC/H.264 and HEVC/H.265 video transfer syntaxes, including fragmentable variants | 1.2.840.10008.1.2.4.100 to 1.2.840.10008.1.2.4.108 | No |

Series in a transfer syntax that cannot be decoded are stored and can be downloaded, but cannot be
opened in the viewer; the library and the import result show the reason. Like all compressed
instances, they cannot be sent over the network (section 4.2.1.3.5).

### 8.8 Storage SOP classes

The table lists the storage SOP classes that RT-Gaia proposes or accepts, as defined by
pynetdicom 3.0.4:

- **C-STORE SCU**: proposed when RT-Gaia sends instances (section 4.2.1.3.5).
- **C-GET SCP role**: proposed, with the SCP role, when RT-Gaia retrieves with C-GET (section
  4.2.1.3.4).
- **Receiver**: accepted by the RT-Gaia Receiver AE (section 4.2.2). Only the SOP classes in Table
  4.2-11 are treated as supported.

<details>
<summary>Storage SOP classes (184 entries)</summary>

| SOP class | SOP class UID | C-STORE SCU | C-GET SCP role | Receiver |
|---|---|---|---|---|
| Stored Print Storage SOP Class | 1.2.840.10008.5.1.1.27 | Yes | Yes | No |
| Hardcopy Grayscale Image Storage SOP Class | 1.2.840.10008.5.1.1.29 | Yes | Yes | No |
| Hardcopy Color Image Storage SOP Class | 1.2.840.10008.5.1.1.30 | Yes | Yes | No |
| Computed Radiography Image Storage | 1.2.840.10008.5.1.4.1.1.1 | Yes | Yes | Yes |
| Digital X-Ray Image Storage - For Presentation | 1.2.840.10008.5.1.4.1.1.1.1 | Yes | Yes | Yes |
| Digital X-Ray Image Storage - For Processing | 1.2.840.10008.5.1.4.1.1.1.1.1 | Yes | Yes | Yes |
| Digital Mammography X-Ray Image Storage - For Presentation | 1.2.840.10008.5.1.4.1.1.1.2 | Yes | Yes | Yes |
| Digital Mammography X-Ray Image Storage - For Processing | 1.2.840.10008.5.1.4.1.1.1.2.1 | Yes | Yes | Yes |
| Digital Intra-Oral X-Ray Image Storage - For Presentation | 1.2.840.10008.5.1.4.1.1.1.3 | Yes | Yes | Yes |
| Digital Intra-Oral X-Ray Image Storage - For Processing | 1.2.840.10008.5.1.4.1.1.1.3.1 | Yes | Yes | Yes |
| CT Image Storage | 1.2.840.10008.5.1.4.1.1.2 | Yes | Yes | Yes |
| Enhanced CT Image Storage | 1.2.840.10008.5.1.4.1.1.2.1 | Yes | Yes | Yes |
| Legacy Converted Enhanced CT Image Storage | 1.2.840.10008.5.1.4.1.1.2.2 | Yes | Yes | Yes |
| Ultrasound Multi-frame Image Storage | 1.2.840.10008.5.1.4.1.1.3 | Yes | Yes | No |
| Ultrasound Multi-frame Image Storage | 1.2.840.10008.5.1.4.1.1.3.1 | Yes | Yes | Yes |
| MR Image Storage | 1.2.840.10008.5.1.4.1.1.4 | Yes | Yes | Yes |
| Enhanced MR Image Storage | 1.2.840.10008.5.1.4.1.1.4.1 | Yes | Yes | Yes |
| MR Spectroscopy Storage | 1.2.840.10008.5.1.4.1.1.4.2 | Yes | Yes | Yes |
| Enhanced MR Color Image Storage | 1.2.840.10008.5.1.4.1.1.4.3 | Yes | Yes | Yes |
| Legacy Converted Enhanced MR Image Storage | 1.2.840.10008.5.1.4.1.1.4.4 | Yes | Yes | Yes |
| Nuclear Medicine Image Storage | 1.2.840.10008.5.1.4.1.1.5 | Yes | Yes | No |
| Ultrasound Image Storage | 1.2.840.10008.5.1.4.1.1.6 | Yes | Yes | No |
| Ultrasound Image Storage | 1.2.840.10008.5.1.4.1.1.6.1 | Yes | Yes | Yes |
| Enhanced US Volume Storage | 1.2.840.10008.5.1.4.1.1.6.2 | Yes | Yes | Yes |
| Photoacoustic Image Storage | 1.2.840.10008.5.1.4.1.1.6.3 | No | No | Yes |
| Secondary Capture Image Storage | 1.2.840.10008.5.1.4.1.1.7 | Yes | Yes | Yes |
| Multi-frame Single Bit Secondary Capture Image Storage | 1.2.840.10008.5.1.4.1.1.7.1 | Yes | Yes | Yes |
| Multi-frame Grayscale Byte Secondary Capture Image Storage | 1.2.840.10008.5.1.4.1.1.7.2 | Yes | Yes | Yes |
| Multi-frame Grayscale Word Secondary Capture Image Storage | 1.2.840.10008.5.1.4.1.1.7.3 | Yes | Yes | Yes |
| Multi-frame True Color Secondary Capture Image Storage | 1.2.840.10008.5.1.4.1.1.7.4 | Yes | Yes | Yes |
| Standalone Overlay Storage | 1.2.840.10008.5.1.4.1.1.8 | Yes | Yes | No |
| Standalone Curve Storage | 1.2.840.10008.5.1.4.1.1.9 | Yes | Yes | No |
| 12-lead ECG Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.1.1 | Yes | No | Yes |
| General ECG Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.1.2 | Yes | No | Yes |
| Ambulatory ECG Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.1.3 | Yes | No | Yes |
| General 32-bit ECG Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.1.4 | No | No | Yes |
| Hemodynamic Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.2.1 | Yes | No | Yes |
| Cardiac Electrophysiology Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.3.1 | Yes | No | Yes |
| Basic Voice Audio Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.4.1 | Yes | No | Yes |
| General Audio Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.4.2 | Yes | No | Yes |
| Arterial Pulse Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.5.1 | Yes | No | Yes |
| Respiratory Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.6.1 | Yes | No | Yes |
| Multi-channel Respiratory Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.6.2 | No | No | Yes |
| Routine Scalp Electroencephalogram Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.7.1 | No | No | Yes |
| Electromyogram Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.7.2 | No | No | Yes |
| Electrooculogram Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.7.3 | No | No | Yes |
| Sleep Electroencephalogram Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.7.4 | No | No | Yes |
| Body Position Waveform Storage | 1.2.840.10008.5.1.4.1.1.9.8.1 | No | No | Yes |
| 1.2.840.10008.5.1.4.1.1.9.100.1 | 1.2.840.10008.5.1.4.1.1.9.100.1 | No | No | Yes |
| 1.2.840.10008.5.1.4.1.1.9.100.2 | 1.2.840.10008.5.1.4.1.1.9.100.2 | No | No | Yes |
| Standalone Modality LUT Storage | 1.2.840.10008.5.1.4.1.1.10 | Yes | Yes | No |
| Standalone VOI LUT Storage | 1.2.840.10008.5.1.4.1.1.11 | Yes | Yes | No |
| Grayscale Softcopy Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.1 | Yes | Yes | Yes |
| Color Softcopy Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.2 | Yes | Yes | Yes |
| Pseudo-Color Softcopy Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.3 | Yes | Yes | Yes |
| Blending Softcopy Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.4 | Yes | Yes | Yes |
| XA/XRF Grayscale Softcopy Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.5 | Yes | Yes | Yes |
| Grayscale Planar MPR Volumetric Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.6 | No | No | Yes |
| Compositing Planar MPR Volumetric Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.7 | No | No | Yes |
| Advanced Blending Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.8 | No | No | Yes |
| Volume Rendering Volumetric Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.9 | No | No | Yes |
| Segmented Volume Rendering Volumetric Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.10 | No | No | Yes |
| Multiple Volume Rendering Volumetric Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.11 | No | No | Yes |
| Variable Modality LUT Softcopy Presentation State Storage | 1.2.840.10008.5.1.4.1.1.11.12 | No | No | Yes |
| X-Ray Angiographic Image Storage | 1.2.840.10008.5.1.4.1.1.12.1 | Yes | Yes | Yes |
| Enhanced XA Image Storage | 1.2.840.10008.5.1.4.1.1.12.1.1 | Yes | Yes | Yes |
| X-Ray Radiofluoroscopic Image Storage | 1.2.840.10008.5.1.4.1.1.12.2 | Yes | Yes | Yes |
| Enhanced XRF Image Storage | 1.2.840.10008.5.1.4.1.1.12.2.1 | Yes | Yes | Yes |
| X-Ray Angiographic Bi-Plane Image Storage | 1.2.840.10008.5.1.4.1.1.12.3 | Yes | Yes | No |
| X-Ray 3D Angiographic Image Storage | 1.2.840.10008.5.1.4.1.1.13.1.1 | Yes | Yes | Yes |
| X-Ray 3D Craniofacial Image Storage | 1.2.840.10008.5.1.4.1.1.13.1.2 | Yes | Yes | Yes |
| Breast Tomosynthesis Image Storage | 1.2.840.10008.5.1.4.1.1.13.1.3 | Yes | Yes | Yes |
| Breast Projection X-Ray Image Storage - For Presentation | 1.2.840.10008.5.1.4.1.1.13.1.4 | No | No | Yes |
| Breast Projection X-Ray Image Storage - For Processing | 1.2.840.10008.5.1.4.1.1.13.1.5 | No | No | Yes |
| Intravascular Optical Coherence Tomography Image Storage - For Presentation | 1.2.840.10008.5.1.4.1.1.14.1 | Yes | Yes | Yes |
| Intravascular Optical Coherence Tomography Image Storage - For Processing | 1.2.840.10008.5.1.4.1.1.14.2 | Yes | Yes | Yes |
| Nuclear Medicine Image Storage | 1.2.840.10008.5.1.4.1.1.20 | Yes | Yes | Yes |
| Parametric Map Storage | 1.2.840.10008.5.1.4.1.1.30 | No | No | Yes |
| Raw Data Storage | 1.2.840.10008.5.1.4.1.1.66 | Yes | Yes | Yes |
| Spatial Registration Storage | 1.2.840.10008.5.1.4.1.1.66.1 | Yes | Yes | Yes |
| Spatial Fiducials Storage | 1.2.840.10008.5.1.4.1.1.66.2 | Yes | Yes | Yes |
| Deformable Spatial Registration Storage | 1.2.840.10008.5.1.4.1.1.66.3 | Yes | Yes | Yes |
| Segmentation Storage | 1.2.840.10008.5.1.4.1.1.66.4 | Yes | Yes | Yes |
| Surface Segmentation Storage | 1.2.840.10008.5.1.4.1.1.66.5 | Yes | Yes | Yes |
| Tractography Results Storage | 1.2.840.10008.5.1.4.1.1.66.6 | No | No | Yes |
| 1.2.840.10008.5.1.4.1.1.66.7 | 1.2.840.10008.5.1.4.1.1.66.7 | No | No | Yes |
| 1.2.840.10008.5.1.4.1.1.66.8 | 1.2.840.10008.5.1.4.1.1.66.8 | No | No | Yes |
| Real World Value Mapping Storage | 1.2.840.10008.5.1.4.1.1.67 | Yes | Yes | Yes |
| Surface Scan Mesh Storage | 1.2.840.10008.5.1.4.1.1.68.1 | Yes | Yes | Yes |
| Surface Scan Point Cloud Storage | 1.2.840.10008.5.1.4.1.1.68.2 | Yes | Yes | Yes |
| VL Image Storage - Trial | 1.2.840.10008.5.1.4.1.1.77.1 | Yes | Yes | No |
| VL Endoscopic Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.1 | Yes | Yes | Yes |
| Video Endoscopic Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.1.1 | Yes | Yes | Yes |
| VL Microscopic Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.2 | Yes | Yes | Yes |
| Video Microscopic Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.2.1 | Yes | Yes | Yes |
| VL Slide-Coordinates Microscopic Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.3 | Yes | Yes | Yes |
| VL Photographic Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.4 | Yes | Yes | Yes |
| Video Photographic Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.4.1 | Yes | Yes | Yes |
| Ophthalmic Photography 8 Bit Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.1 | Yes | Yes | Yes |
| Ophthalmic Photography 16 Bit Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.2 | Yes | Yes | Yes |
| Stereometric Relationship Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.3 | Yes | Yes | Yes |
| Ophthalmic Tomography Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.4 | Yes | Yes | Yes |
| Wide Field Ophthalmic Photography Stereographic Projection Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.5 | No | No | Yes |
| Wide Field Ophthalmic Photography 3D Coordinates Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.6 | No | No | Yes |
| Ophthalmic Optical Coherence Tomography En Face Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.7 | No | No | Yes |
| Ophthalmic Optical Coherence Tomography B-scan Volume Analysis Storage | 1.2.840.10008.5.1.4.1.1.77.1.5.8 | No | No | Yes |
| VL Whole Slide Microscopy Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.6 | Yes | Yes | Yes |
| Dermoscopic Photography Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.7 | No | No | Yes |
| Confocal Microscopy Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.8 | No | No | Yes |
| Confocal Microscopy Tiled Pyramidal Image Storage | 1.2.840.10008.5.1.4.1.1.77.1.9 | No | No | Yes |
| VL Multi-frame Image Storage - Trial | 1.2.840.10008.5.1.4.1.1.77.2 | Yes | Yes | No |
| Lensometry Measurements Storage | 1.2.840.10008.5.1.4.1.1.78.1 | Yes | Yes | Yes |
| Autorefraction Measurements Storage | 1.2.840.10008.5.1.4.1.1.78.2 | Yes | Yes | Yes |
| Keratometry Measurements Storage | 1.2.840.10008.5.1.4.1.1.78.3 | Yes | Yes | Yes |
| Subjective Refraction Measurements Storage | 1.2.840.10008.5.1.4.1.1.78.4 | Yes | Yes | Yes |
| Visual Acuity Measurements Storage | 1.2.840.10008.5.1.4.1.1.78.5 | Yes | Yes | Yes |
| Spectacle Prescription Report Storage | 1.2.840.10008.5.1.4.1.1.78.6 | Yes | Yes | Yes |
| Ophthalmic Axial Measurements Storage | 1.2.840.10008.5.1.4.1.1.78.7 | Yes | Yes | Yes |
| Intraocular Lens Calculations Storage | 1.2.840.10008.5.1.4.1.1.78.8 | Yes | Yes | Yes |
| Macular Grid Thickness and Volume Report Storage | 1.2.840.10008.5.1.4.1.1.79.1 | Yes | Yes | Yes |
| Ophthalmic Visual Field Static Perimetry Measurements Storage | 1.2.840.10008.5.1.4.1.1.80.1 | Yes | Yes | Yes |
| Ophthalmic Thickness Map Storage | 1.2.840.10008.5.1.4.1.1.81.1 | Yes | Yes | Yes |
| Corneal Topography Map Storage | 1.2.840.10008.5.1.4.1.1.82.1 | No | No | Yes |
| Basic Text SR Storage | 1.2.840.10008.5.1.4.1.1.88.11 | Yes | Yes | Yes |
| Enhanced SR Storage | 1.2.840.10008.5.1.4.1.1.88.22 | Yes | Yes | Yes |
| Comprehensive SR Storage | 1.2.840.10008.5.1.4.1.1.88.33 | Yes | Yes | Yes |
| Comprehensive 3D SR Storage | 1.2.840.10008.5.1.4.1.1.88.34 | Yes | Yes | Yes |
| Extensible SR Storage | 1.2.840.10008.5.1.4.1.1.88.35 | No | No | Yes |
| Procedure Log Storage | 1.2.840.10008.5.1.4.1.1.88.40 | Yes | Yes | Yes |
| Mammography CAD SR Storage | 1.2.840.10008.5.1.4.1.1.88.50 | Yes | Yes | Yes |
| Key Object Selection Document Storage | 1.2.840.10008.5.1.4.1.1.88.59 | Yes | Yes | Yes |
| Chest CAD SR Storage | 1.2.840.10008.5.1.4.1.1.88.65 | Yes | Yes | Yes |
| X-Ray Radiation Dose SR Storage | 1.2.840.10008.5.1.4.1.1.88.67 | Yes | Yes | Yes |
| Radiopharmaceutical Radiation Dose SR Storage | 1.2.840.10008.5.1.4.1.1.88.68 | No | No | Yes |
| Colon CAD SR Storage | 1.2.840.10008.5.1.4.1.1.88.69 | Yes | Yes | Yes |
| Implantation Plan SR Storage | 1.2.840.10008.5.1.4.1.1.88.70 | Yes | Yes | Yes |
| Acquisition Context SR Storage | 1.2.840.10008.5.1.4.1.1.88.71 | No | No | Yes |
| Simplified Adult Echo SR Storage | 1.2.840.10008.5.1.4.1.1.88.72 | No | No | Yes |
| Patient Radiation Dose SR Storage | 1.2.840.10008.5.1.4.1.1.88.73 | No | No | Yes |
| Planned Imaging Agent Administration SR Storage | 1.2.840.10008.5.1.4.1.1.88.74 | No | No | Yes |
| Performed Imaging Agent Administration SR Storage | 1.2.840.10008.5.1.4.1.1.88.75 | No | No | Yes |
| Enhanced X-Ray Radiation Dose SR Storage | 1.2.840.10008.5.1.4.1.1.88.76 | No | No | Yes |
| Waveform Annotation SR Storage | 1.2.840.10008.5.1.4.1.1.88.77 | No | No | Yes |
| Content Assessment Results Storage | 1.2.840.10008.5.1.4.1.1.90.1 | No | No | Yes |
| Microscopy Bulk Simple Annotations Storage | 1.2.840.10008.5.1.4.1.1.91.1 | No | No | Yes |
| Encapsulated PDF Storage | 1.2.840.10008.5.1.4.1.1.104.1 | Yes | Yes | Yes |
| Encapsulated CDA Storage | 1.2.840.10008.5.1.4.1.1.104.2 | Yes | Yes | Yes |
| Encapsulated STL Storage | 1.2.840.10008.5.1.4.1.1.104.3 | No | No | Yes |
| Encapsulated OBJ Storage | 1.2.840.10008.5.1.4.1.1.104.4 | No | No | Yes |
| Encapsulated MTL Storage | 1.2.840.10008.5.1.4.1.1.104.5 | No | No | Yes |
| Positron Emission Tomography Image Storage | 1.2.840.10008.5.1.4.1.1.128 | Yes | Yes | Yes |
| Legacy Converted Enhanced PET Image Storage | 1.2.840.10008.5.1.4.1.1.128.1 | Yes | Yes | Yes |
| Standalone PET Curve Storage | 1.2.840.10008.5.1.4.1.1.129 | Yes | Yes | No |
| Enhanced PET Image Storage | 1.2.840.10008.5.1.4.1.1.130 | Yes | Yes | Yes |
| Basic Structured Display Storage | 1.2.840.10008.5.1.4.1.1.131 | Yes | Yes | Yes |
| CT Performed Procedure Protocol Storage | 1.2.840.10008.5.1.4.1.1.200.2 | No | No | Yes |
| XA Performed Procedure Protocol Storage | 1.2.840.10008.5.1.4.1.1.200.8 | No | No | Yes |
| RT Image Storage | 1.2.840.10008.5.1.4.1.1.481.1 | Yes | Yes | Yes |
| RT Dose Storage | 1.2.840.10008.5.1.4.1.1.481.2 | Yes | Yes | Yes |
| RT Structure Set Storage | 1.2.840.10008.5.1.4.1.1.481.3 | Yes | Yes | Yes |
| RT Beams Treatment Record Storage | 1.2.840.10008.5.1.4.1.1.481.4 | Yes | Yes | Yes |
| RT Plan Storage | 1.2.840.10008.5.1.4.1.1.481.5 | Yes | Yes | Yes |
| RT Brachy Treatment Record Storage | 1.2.840.10008.5.1.4.1.1.481.6 | Yes | Yes | Yes |
| RT Treatment Summary Record Storage | 1.2.840.10008.5.1.4.1.1.481.7 | Yes | Yes | Yes |
| RT Ion Plan Storage | 1.2.840.10008.5.1.4.1.1.481.8 | Yes | Yes | Yes |
| RT Ion Beams Treatment Record Storage | 1.2.840.10008.5.1.4.1.1.481.9 | Yes | Yes | Yes |
| RT Physician Intent Storage | 1.2.840.10008.5.1.4.1.1.481.10 | No | No | Yes |
| RT Segment Annotation Storage | 1.2.840.10008.5.1.4.1.1.481.11 | No | No | Yes |
| RT Radiation Set Storage | 1.2.840.10008.5.1.4.1.1.481.12 | No | No | Yes |
| C-Arm Photon-Electron Radiation Storage | 1.2.840.10008.5.1.4.1.1.481.13 | No | No | Yes |
| Tomotherapeutic Radiation Storage | 1.2.840.10008.5.1.4.1.1.481.14 | No | No | Yes |
| Robotic-Arm Radiation Storage | 1.2.840.10008.5.1.4.1.1.481.15 | No | No | Yes |
| RT Radiation Record Set Storage | 1.2.840.10008.5.1.4.1.1.481.16 | No | No | Yes |
| RT Radiation Salvage Record Storage | 1.2.840.10008.5.1.4.1.1.481.17 | No | No | Yes |
| Tomotherapeutic Radiation Record Storage | 1.2.840.10008.5.1.4.1.1.481.18 | No | No | Yes |
| C-Arm Photon-Electron Radiation Record Storage | 1.2.840.10008.5.1.4.1.1.481.19 | No | No | Yes |
| Robotic Radiation Record Storage | 1.2.840.10008.5.1.4.1.1.481.20 | No | No | Yes |
| RT Radiation Set Delivery Instruction Storage | 1.2.840.10008.5.1.4.1.1.481.21 | No | No | Yes |
| RT Treatment Preparation Storage | 1.2.840.10008.5.1.4.1.1.481.22 | No | No | Yes |
| Enhanced RT Image Storage | 1.2.840.10008.5.1.4.1.1.481.23 | No | No | Yes |
| Enhanced Continuous RT Image Storage | 1.2.840.10008.5.1.4.1.1.481.24 | No | No | Yes |
| RT Patient Position Acquisition Instruction Storage | 1.2.840.10008.5.1.4.1.1.481.25 | No | No | Yes |
| RT Beams Delivery Instruction Storage | 1.2.840.10008.5.1.4.34.7 | Yes | No | Yes |
| RT Brachy Application Setup Delivery Instruction Storage | 1.2.840.10008.5.1.4.34.10 | No | No | Yes |

</details>
