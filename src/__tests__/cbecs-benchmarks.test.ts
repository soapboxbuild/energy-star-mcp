import { describe, it, expect } from 'vitest'
import { euiPercentile, cbecMedian, CBECS_CITATION } from '../cbecs-benchmarks.js'

describe('euiPercentile', () => {
  it('returns 50 for median EUI of each asset class', () => {
    expect(euiPercentile(93, 'Office')).toBe(50)
    expect(euiPercentile(66, 'Retail')).toBe(50)
    expect(euiPercentile(140, 'Hotel')).toBe(50)
  })

  it('returns high percentile (efficient) for EUI well below median', () => {
    // Office p10 = 29 → efficiency = 90
    expect(euiPercentile(29, 'Office')).toBe(90)
    // Below p10 should be > 90
    expect(euiPercentile(10, 'Office')).toBeGreaterThan(90)
  })

  it('returns low percentile (inefficient) for EUI well above median', () => {
    // Office p90 = 259 → efficiency = 10
    expect(euiPercentile(259, 'Office')).toBe(10)
    // Above p90 should be < 10
    expect(euiPercentile(400, 'Office')).toBeLessThan(10)
    expect(euiPercentile(400, 'Office')).toBeGreaterThanOrEqual(0)
  })

  it('interpolates between quartiles', () => {
    // Office p25=54, p50=93: halfway between → ~37th percentile efficiency
    const midEui = (54 + 93) / 2  // 73.5
    const pctile = euiPercentile(midEui, 'Office')
    // Should be between 50 and 75 efficiency (i.e. between p25 and p50 of the distribution)
    expect(pctile).toBeGreaterThan(50)
    expect(pctile).toBeLessThan(75)
  })

  it('is monotonically decreasing — lower EUI → higher percentile', () => {
    const euis = [20, 50, 93, 150, 200, 300]
    const pctiles = euis.map(e => euiPercentile(e, 'Office'))
    for (let i = 1; i < pctiles.length; i++) {
      expect(pctiles[i]).toBeLessThan(pctiles[i - 1])
    }
  })

  it('never returns percentile outside [0, 100]', () => {
    const extremeEuis = [1, 5, 1000, 5000]
    for (const eui of extremeEuis) {
      const p = euiPercentile(eui, 'Office')
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(100)
    }
  })

  it('handles all supported asset classes without throwing', () => {
    const classes = ['Office', 'Retail', 'Multifamily', 'Industrial', 'Hotel', 'K-12 School', 'Medical Office'] as const
    for (const ac of classes) {
      expect(() => euiPercentile(100, ac)).not.toThrow()
    }
  })
})

describe('cbecMedian', () => {
  it('returns the 50th-percentile EUI for Office', () => {
    expect(cbecMedian('Office')).toBe(93)
  })

  it('returns a positive number for all asset classes', () => {
    const classes = ['Office', 'Retail', 'Multifamily', 'Industrial', 'Hotel', 'K-12 School', 'Medical Office'] as const
    for (const ac of classes) {
      expect(cbecMedian(ac)).toBeGreaterThan(0)
    }
  })
})

describe('CBECS_CITATION', () => {
  it('references CBECS 2018', () => {
    expect(CBECS_CITATION).toContain('2018')
  })
})
