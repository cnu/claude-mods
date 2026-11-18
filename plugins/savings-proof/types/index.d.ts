declare module 'claude-code' {
  interface PluginState {
    'savings-proof': {
      /** JSON text of the last Summary built from the ledger files ('' before the first read). */
      snapshot: Shaped<string>
      /** ms epoch of the last refresh that changed the snapshot; makes an open pane redraw. */
      refreshedAt: number
    }
  }
}
