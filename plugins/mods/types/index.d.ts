declare module 'claude-code' {
  interface PluginState {
    mods: {
      /** One row per installed mod, from the installed-plugins record. */
      rows: Shaped<
        {
          id: string
          name: string
          marketplace: string
          version: string
          description: string
          scope: string
          installPath: string
          /** The effective state: managed policy, then --settings flag, local, project, then user settings decide (policy only when readable). */
          isEnabled: boolean
          /** Where an override comes from, e.g. "off in project settings"; empty when user settings decide. */
          scopeNote: string
          /** A project or local entry exists that the user-settings toggle cannot beat. */
          isOverridden: boolean
          /** Set once the person pressed the toggle: the enabled value the settings file now holds, which loads on the next start. */
          pending: boolean | null
          /** Slash commands of this mod that look like they open a pane. */
          openCommands: string[]
          isSelf: boolean
        }[]
      >
      /** One line under the list: what was read, saved or refused. */
      notice: string
      /** Path of the backup copy of the user settings file written this session; empty until one is. */
      backedUp: string
      /** True when the last load could read managed policy settings through the settings API. */
      managedReadable: boolean
    }
  }
}
