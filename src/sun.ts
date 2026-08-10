import * as SunCalc from 'suncalc'

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
    // Polar day/night: there is no rise/set event to offset against.
    if (times.alwaysUp === true) return true
    if (times.alwaysDown === true) return false
    const sunrise = times.sunrise
    const sunset = times.sunset
    if (sunrise === null || sunset === null) return null
    const t = now.getTime()
    return (
      t >= sunrise.getTime() + startOffsetMin * 60_000 &&
      t < sunset.getTime() + endOffsetMin * 60_000
    )
  }
}
