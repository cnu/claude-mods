declare module 'claude-code' {
  interface PluginState {
    'effort-optimizer': {
      /** Current mode; mirrors the in-memory mode so the offer redraws when it changes. */
      mode: string
      /** The level currently offered ("Switch to <level>"), or null when nothing is offered. */
      offer: string | null
      /** The level this mod is applying to every request, or null when it leaves the session's own level alone. */
      active: string | null
    }
  }
}
