declare module 'claude-code' {
  interface PluginState {
    handoff: {
      /** Context size in tokens at the last main-thread turn, from `$.session.usage()`. */
      tokens: number
      /** 'idle' | 'offer' | 'running' | 'done' | 'failed': what the band shows. */
      phase: string
      /** Index of the step now running (or the one that failed). */
      step: number
      /** One line the band shows under the steps: where the note went, or why it failed. */
      message: string
      /** Absolute path of the handoff note of the last run; '' before one. */
      notePath: string
      /** True while "Clear and continue with it" waits for its second press (about 10 s). */
      confirming: boolean
    }
  }
}
