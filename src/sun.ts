import SunCalc from 'suncalc'

export interface Position {
  latitude: number
  longitude: number
}

/**
 * Day/night oracle for `sun` conditions. Remembers the last known
 * vessel position for the plugin's lifetime (and across restarts via
 * runtime-state.json) so a GPS dropout doesn't blind sun rules.
 */
export class SunTracker {
  private last: Position | null = null

  setPosition(value: unknown): void {
    if (
      value !== null &&
      typeof value === 'object' &&
      'latitude' in value &&
      'longitude' in value
    ) {
      const lat = (value as { latitude: unknown }).latitude
      const lon = (value as { longitude: unknown }).longitude
      if (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon)
      ) {
        this.last = { latitude: lat, longitude: lon }
      }
    }
  }

  get position(): Position | null {
    return this.last
  }

  /**
   * true = day, false = night, null = unknown (no position ever seen).
   * Offsets shift the day window's edges in minutes: startOffset -30
   * means the "day" starts half an hour before sunrise.
   */
  isDay(now: Date, startOffsetMin = 0, endOffsetMin = 0): boolean | null {
    if (!this.last) return null
    const { latitude, longitude } = this.last
    const times = SunCalc.getTimes(now, latitude, longitude)
    const sunrise = times.sunrise?.getTime()
    const sunset = times.sunset?.getTime()
    if (
      sunrise === undefined ||
      sunset === undefined ||
      Number.isNaN(sunrise) ||
      Number.isNaN(sunset)
    ) {
      // Polar day/night: no sunrise/sunset today. Fall back to solar
      // altitude (offsets are meaningless without an event to offset).
      return SunCalc.getPosition(now, latitude, longitude).altitude > 0
    }
    const t = now.getTime()
    return (
      t >= sunrise + startOffsetMin * 60_000 &&
      t < sunset + endOffsetMin * 60_000
    )
  }
}
