# vpr — todo

## DONE — `vpr plan pull <parent-wi-id>` (minimal)

Fetches a parent WI from Azure and creates one `meta.json` item per child Task. Idempotent — Tasks already attached to a WI in meta are skipped. On slug collision, the WI id is appended to disambiguate.

Files:
- `src/providers/azure-devops.mjs` — added `getChildren(id)` + `type` field on `getWorkItem`.
- `src/commands/plan-pull.mjs` — new command.
- `bin/vpr.mjs` — `case 'plan'` dispatch + help line.

Used to pull SAF MVP 2 (PBI 17148) → 16 child items into transit-platform `.vpr/meta.json`.

## TODO — `azure.json` mirror

Defer descriptions, state, and PBI metadata to a sibling `.vpr/azure.json` so `meta.json` stays purely authored state. Sketch:

```json
{
  "pulledAt": "2026-04-27T...",
  "pbis":  { "17148": { "type": "...", "title": "...", "description": "...", "state": "...", "children": [17132, ...] } },
  "tasks": { "17132": { "title": "...", "description": "...", "state": "...", "parent": 17148 } }
}
```

Add `src/core/azure.mjs` mirroring `meta.mjs` (`loadAzure`/`saveAzure`/`azurePath`), and have `planPull` write to it on every pull.

## TODO — `vpr sync`

Bidirectional description sync with Azure — push Story/Description edits up, pull remote changes down. Lives only on the abandoned `tui-v0.2` branch. Revisit once the workflow demands it.

## Out of scope (intentionally not building)

- PBI-as-item — work happens at Task level.
- Three-level Epic/Task/PR hierarchy — v2 is item/VPR; PBI is metadata only.
- `vpr gen` at epic/task levels — same reason.
