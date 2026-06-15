---
name: energy-star
description: >
  Retrieve ENERGY STAR scores, EUI benchmarks, carbon emissions, and utility
  consumption from EPA Portfolio Manager for any property. Triggers on:
  "energy star score", "ESPM", "portfolio manager", "EUI", "energy use
  intensity", "ENERGY STAR certification", "benchmark energy",
  "utility consumption", "carbon emissions portfolio manager".
---

# ENERGY STAR Portfolio Manager

Retrieve benchmarking data for properties in the user's ESPM account.

## Workflow

Always follow this sequence:

1. `get_account` — retrieves the accountId needed for subsequent calls. Call once per session.
2. `list_properties` — returns all properties with propertyId and name. Find the target property by name or address match.
3. `get_metrics(propertyId)` — ENERGY STAR score, site EUI, source EUI, GHG emissions.
4. If consumption detail is needed: `list_meters(propertyId)` → `get_meter_consumption(meterId)`.

## Key Interpretation Rules

**ENERGY STAR Score:**
- Score of 75+ qualifies for ENERGY STAR certification
- Score below 50 is at-risk — bottom quartile of similar buildings
- `scoreEligible: false` means the property type doesn't qualify for a numeric score (only ~30 building types do). Report EUI only for these.
- Always report the score year alongside the score — "ENERGY STAR Score: 82 (2025)"

**Site EUI (Energy Use Intensity):**
- Units: kBtu/sq ft/year. Lower = better.
- National median benchmarks by primary function (approximate):
  - Office: ~90 kBtu/ft²
  - K-12 School: ~65 kBtu/ft²
  - Hotel/Motel: ~120 kBtu/ft²
  - Retail Store: ~75 kBtu/ft²
  - Multifamily Housing: ~65 kBtu/ft²
  - Hospital (General): ~400 kBtu/ft²
  - Warehouse (Unrefrigerated): ~40 kBtu/ft²
- Always compare against the national median for the property's primaryFunction

**GHG Emissions:**
- `totalGHGEmissions` in metric tons CO₂e
- Divide by gross floor area to get emissions intensity (kg CO₂e/ft²)

**Meter Types:**
- Common values: Electricity, Natural Gas, Chilled Water, Steam, Fuel Oil (No. 2), Propane
- Electricity units: kWh. Natural Gas units: therms or CCF.

## Error Handling

- If `get_account` fails with 401: user's ESPM credentials are incorrect — ask them to re-enter
- If `get_metrics` returns `scoreEligible: false`: property type doesn't qualify — report EUI only
- If a property shows no score for the current year: data may not yet be available — try year - 1
