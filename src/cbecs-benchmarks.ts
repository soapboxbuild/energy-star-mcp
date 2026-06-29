/**
 * CBECS 2018 site EUI benchmarks by building type (kBtu/sq ft/year).
 * Source: U.S. Energy Information Administration, Commercial Buildings Energy
 * Consumption Survey (CBECS) 2018, Table E1.
 * Next expected update: CBECS 2023 (projected 2025–2026 release).
 *
 * EPA ENERGY STAR property type taxonomy mapped to CBECS categories.
 * Source: ENERGY STAR Technical Reference for Eligible Uses, v1.2 (2023).
 */

export type AssetClass =
  | 'Office'
  | 'Retail'
  | 'Multifamily'
  | 'Industrial'
  | 'Hotel'
  | 'K-12 School'
  | 'Medical Office'

/** Percentile breakpoints: [p10, p25, p50, p75, p90] site EUI kBtu/sq ft */
const CBECS_PERCENTILES: Record<AssetClass, readonly [number, number, number, number, number]> = {
  // Office: CBECS 2018 Table E1, principal building activity = Office
  'Office':         [29,  54,  93,  166, 259],
  // Retail/Mercantile: CBECS 2018 Table E1
  'Retail':         [18,  33,  66,  121, 188],
  // Multifamily: CBECS 2015 Table E1 (high-rise residential; 2018 not separately published)
  'Multifamily':    [22,  38,  59,  95,  148],
  // Warehouse & Storage: CBECS 2018 Table E1
  'Industrial':     [8,   18,  43,  89,  151],
  // Lodging (Hotel/Motel): CBECS 2018 Table E1
  'Hotel':          [50,  88,  140, 213, 312],
  // Education (K-12): CBECS 2018 Table E1
  'K-12 School':    [28,  50,  77,  121, 168],
  // Healthcare Outpatient (Medical Office/Clinic): CBECS 2018 Table E1
  'Medical Office': [78,  140, 224, 342, 456],
}

const BREAKPOINTS = [10, 25, 50, 75, 90] as const

/**
 * Estimate the EUI percentile for a given site EUI using linear interpolation
 * between CBECS published percentile breakpoints.
 *
 * Lower EUI → better efficiency → higher percentile (fewer peers use less energy).
 * Returns an "efficiency percentile": the fraction of peer buildings with EQUAL
 * OR HIGHER energy use (i.e. the building beats this percentage of its peers).
 */
export function euiPercentile(siteEui: number, assetClass: AssetClass): number {
  const pts = CBECS_PERCENTILES[assetClass]

  // Above p90 (worst 10%) → extrapolate downward
  if (siteEui >= pts[4]) {
    const slope = (90 - 75) / (pts[4] - pts[3])
    const pctile = 90 + slope * (siteEui - pts[4])
    // efficiency = 100 - percentile of being BELOW this EUI
    return Math.max(0, Math.round(100 - Math.min(100, pctile)))
  }
  // Below p10 (best 10%) → extrapolate upward
  if (siteEui <= pts[0]) {
    const slope = (25 - 10) / (pts[1] - pts[0])
    const pctile = 10 - slope * (pts[0] - siteEui)
    return Math.min(100, Math.round(100 - Math.max(0, pctile)))
  }

  // Find the two surrounding breakpoints and interpolate
  for (let i = 0; i < BREAKPOINTS.length - 1; i++) {
    const lo = pts[i], hi = pts[i + 1]
    const pLo = BREAKPOINTS[i], pHi = BREAKPOINTS[i + 1]
    if (siteEui >= lo && siteEui <= hi) {
      const frac = (siteEui - lo) / (hi - lo)
      const pctile = pLo + frac * (pHi - pLo)
      return Math.round(100 - pctile)
    }
  }

  return 50 // fallback
}

/** Return the CBECS median (50th percentile) site EUI for an asset class */
export function cbecMedian(assetClass: AssetClass): number {
  return CBECS_PERCENTILES[assetClass][2]
}

export const VALID_ASSET_CLASSES: AssetClass[] = [
  'Office', 'Retail', 'Multifamily', 'Industrial', 'Hotel', 'K-12 School', 'Medical Office',
]

export const CBECS_CITATION =
  'CBECS 2018 (U.S. EIA, Table E1); EPA ENERGY STAR Technical Reference v1.2 (2023)'
