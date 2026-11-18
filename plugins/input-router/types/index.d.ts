declare module 'claude-code' {
  interface PluginState {
    'input-router': {
      /**
       * Hand-offs made in this session, newest last (capped). Only the tool, the target (file
       * path or MCP tool name) and sizes: characters in, characters of the note out, and the
       * gross tokens avoided, ceil((inChars - outChars) / 4), the helper's tokens, and the estimated
       * dollars (null when a model price is unknown). Never content. A `wasted` row is a helper call
       * whose digest was not used (the reason is its text; tokensAvoided is 0).
       */
      handoffs: Shaped<{ at: number; tool: string; target: string; inChars: number; outChars: number; tokensAvoided: number; helperTokens: number; costUsd: number | null; mainModel: string; helperModel: string; wasted?: string; isSubagent?: boolean }[]>
      /** True while `/input-router full` is armed for the next result that would be routed. */
      isFullArmed: boolean
    }
  }
}
