---
name: energy-star
description: Retrieve ENERGY STAR scores, energy use intensity (EUI), and carbon emissions for buildings via EPA Portfolio Manager. Connect properties by sharing them with api@soapbox.build in Portfolio Manager. Use when asked about ENERGY STAR score, EUI benchmarks, benchmarking compliance, carbon emissions per square foot, or Portfolio Manager.
---

# ENERGY STAR Portfolio Manager

## Connection Setup (one-time per property)
1. Log into portfoliomanager.energystar.gov
2. Open your property → Share → Search "api@soapbox.build" → Share as Read Only
3. Call `list_shared_properties` to confirm it appears

## Available Tools
- `list_shared_properties` — Show all properties shared with the Soapbox central account
- `connect_property` — One-time setup: authenticate with user credentials, find properties, share with Soapbox account
- `get_property` — Property details and current ENERGY STAR score
- `get_metrics` — Score (1-100), site EUI (kBtu/ft²), source EUI, total GHG emissions (tCO2e)
- `get_meters` — List utility meters (electricity, gas, water, waste)
- `submit_meter_data` — Submit consumption data to update benchmarking
- `get_energy_star_score` — Current ENERGY STAR score and national percentile

## ENERGY STAR Score Interpretation
- 75+ = eligible for ENERGY STAR certification
- 50 = national median
- <25 = significant improvement opportunity
- Score compares to similar buildings nationally (same type, climate, size)
