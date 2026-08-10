import type { RuleT } from '../../src/shared/schemas'

export interface RuleTemplate {
  title: string
  blurb: string
  rules: Array<Omit<RuleT, 'id'>>
}

/**
 * One-click starter rules matching the classic use cases. Paths are
 * sensible placeholders — the "never seen on this boat" warning walks
 * the user through the path picker, which doubles as the tutorial.
 */
export const TEMPLATES: RuleTemplate[] = [
  {
    title: 'Solar water heater',
    blurb: 'Heater only burns power while the solar charger delivers it',
    rules: [
      {
        name: 'Water heater on solar',
        enabled: false,
        dryRun: true,
        combinator: 'all',
        conditions: [
          {
            type: 'numeric',
            path: 'electrical.solar.0.current',
            operator: 'gt',
            threshold: 4,
            clearThreshold: 1
          }
        ],
        actions: [
          { type: 'setSwitch', path: 'electrical.switches.bank.0.1.state' }
        ],
        options: { holdTrueSeconds: 60, holdFalseSeconds: 120 }
      }
    ]
  },
  {
    title: 'Anchor light',
    blurb: 'On only at night, at rest, with no charge source',
    rules: [
      {
        name: 'Anchor light',
        enabled: false,
        dryRun: true,
        combinator: 'all',
        conditions: [
          {
            type: 'numeric',
            path: 'electrical.solar.0.current',
            operator: 'gt',
            threshold: 0.5,
            negate: true
          },
          {
            type: 'numeric',
            path: 'electrical.ac.130.average.lineNeutralVoltage',
            operator: 'lt',
            threshold: 100
          },
          {
            type: 'numeric',
            path: 'navigation.speedOverGround',
            operator: 'lt',
            threshold: 0.514,
            clearThreshold: 0.772
          },
          { type: 'sun', during: 'night' }
        ],
        actions: [
          { type: 'setSwitch', path: 'electrical.switches.bank.0.2.state' }
        ],
        options: { holdTrueSeconds: 30, holdFalseSeconds: 30 }
      }
    ]
  },
  {
    title: 'Generator autostart',
    blurb: 'Start pulse below 25% battery, stop pulse at 84%',
    rules: [
      {
        name: 'Generator start at 25%',
        enabled: false,
        dryRun: true,
        combinator: 'all',
        conditions: [
          {
            type: 'numeric',
            path: 'electrical.batteries.0.capacity.stateOfCharge',
            operator: 'lt',
            threshold: 0.25,
            clearThreshold: 0.3
          }
        ],
        actions: [
          {
            type: 'pulse',
            path: 'electrical.switches.bank.0.3.state',
            seconds: 30
          },
          {
            type: 'notification',
            pathSuffix: 'generator.autostart',
            state: 'alert',
            method: ['visual'],
            message: 'Generator autostart triggered'
          }
        ],
        options: { holdTrueSeconds: 120, cooldownSeconds: 1800 }
      },
      {
        name: 'Generator stop at 84%',
        enabled: false,
        dryRun: true,
        combinator: 'all',
        conditions: [
          {
            type: 'numeric',
            path: 'electrical.batteries.0.capacity.stateOfCharge',
            operator: 'gte',
            threshold: 0.84,
            clearThreshold: 0.8
          }
        ],
        actions: [
          {
            type: 'pulse',
            path: 'electrical.switches.bank.0.4.state',
            seconds: 5
          }
        ],
        options: { holdTrueSeconds: 60, cooldownSeconds: 1800 }
      }
    ]
  }
]

export const BLANK_RULE: Omit<RuleT, 'id'> = {
  name: 'New rule',
  enabled: false,
  dryRun: true,
  combinator: 'all',
  conditions: [
    {
      type: 'numeric',
      path: 'navigation.speedOverGround',
      operator: 'lt',
      threshold: 0.514
    }
  ],
  actions: [{ type: 'setSwitch', path: 'electrical.switches.bank.0.1.state' }],
  options: {}
}
