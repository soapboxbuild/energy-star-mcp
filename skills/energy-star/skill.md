---
name: energy-star
description: >
  Retrieve ENERGY STAR scores, EUI benchmarks, carbon emissions, and monthly
  utility consumption from EPA Portfolio Manager. Also used to calibrate Audette
  energy models with real consumption data. Triggers on:
  "energy star score", "ESPM", "portfolio manager", "EUI", "energy use
  intensity", "ENERGY STAR certification", "benchmark energy",
  "utility consumption", "calibrate Audette", "import energy data",
  "energy bills", "monthly consumption".
---

# ENERGY STAR Portfolio Manager

Retrieve benchmarking and consumption data for properties in the user's ESPM account.

## Property ID

If the asset has a linked ESPM property ID (shown in the system prompt as "ENERGY STAR Property"), use it directly. Do not call `list_properties`.

If no property ID is linked, call `list_properties` to find the property by name or address.

## Audette Calibration Workflow

When asked to calibrate Audette, import energy data, or submit utility bills from ESPM:

1. `get_meter_consumption(espmPropertyId)` — returns monthly data by fuel type with kWh and therms pre-converted
2. Review the data: confirm months of coverage, flag any gaps
3. For each fuel type, submit 12–24 months to Audette using `audette_add_utility_data` (or equivalent Audette tool):
   - **Electricity**: use `usage_kWh` values (1 GJ = 277.778 kWh)
   - **Natural Gas**: use `usage_therms` values (1 GJ = 9.4782 therms)
   - Each month: `startDate`, `endDate`, and usage value
4. Confirm submission and note the date range imported

**Important:** Do not stop to summarise after step 1 — continue directly to submission unless data is missing or ambiguous.

## Benchmarking Workflow

1. `get_metrics(propertyId)` — ENERGY STAR score, site EUI, source EUI, GHG emissions
2. `get_property(propertyId)` — floor area, property type (for EUI comparison)

## Key Interpretation Rules

**ENERGY STAR Score:**
- 75+ qualifies for ENERGY STAR certification
- Below 50 is at-risk — bottom quartile
- `scoreEligible: false` means the property type doesn't qualify — report EUI only
- Always report the score year: "ENERGY STAR Score: 82 (2025)"

**Site EUI (kBtu/sq ft/year — lower is better):**
- Office: ~90 | K-12 School: ~65 | Hotel: ~120 | Retail: ~75
- Multifamily: ~65 | Hospital: ~400 | Warehouse: ~40

**GHG:** `totalGHGEmissions` in metric tons CO₂e. Divide by GFA for intensity.

**Consumption data units:** PM returns GJ. Pre-converted values in the response:
- `usage_kWh` — electricity only (null for gas)
- `usage_therms` — natural gas only (null for electricity)

## Error Handling

- 401 on `get_account`: credentials incorrect — ask user to re-enter in plugin settings
- `scoreEligible: false`: property type ineligible — show EUI only
- No data / `notInitialized: true`: property has no meter data submitted in ESPM
- Gaps in monthly data: flag to user before submitting to Audette
