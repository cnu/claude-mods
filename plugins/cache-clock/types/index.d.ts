declare module 'claude-code' {
  interface PluginState {
    'cache-clock': {
      /** ms epoch of the last main-thread model response (or successful ping); null before the first turn. */
      lastTurnAt: number | null
      /** Context size in tokens at the last turn, from `$.session.usage()`. */
      tokens: number
      /** Whether background keep-warm pings are on. */
      keepWarm: boolean
      /** Pings sent in the current idle stretch (reset on each turn). */
      pings: number
      /** Last tick time, ms epoch. Written once a second while the band shows; makes the band redraw. */
      tickAt: number
      /** Cache lifetime read from the API (ms and where it came from), or null when nothing was detected. */
      detectedTtl: { ms: number; source: 'model-switch' | 'resume' } | null
      /** Name of the handoff slash command when one is installed, else null. */
      handoffCommand: string | null
    }
  }
}
