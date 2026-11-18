# mods

**Goal:** a single place to see and switch the mods installed on this machine.

## Behaviour
1. `/mods` opens a pane listing every installed mod found by reading the
   user's installed-plugins record and each plugin's manifest, showing name,
   version, description, and whether it is currently enabled.
2. Each row has an on/off control that changes whether the mod is on for the
   *current chat only*, if the mod API allows a session-scoped toggle;
   otherwise it edits the user's enabled-plugins setting and tells the person a
   restart is needed. State plainly which of the two is happening.
3. Mods that open their own side pane (e.g. via a slash command) get an "Open"
   button that runs that command.
4. Never modify any setting without the person pressing a control. Read-only
   until then.
5. Before changing the settings file the mod saves a backup copy; if the backup
   cannot be written it refuses and writes nothing, unless the person has
   turned on `allowWithoutBackup`.
6. Effective state includes managed policy settings when the API can read them
   (highest precedence). When it cannot, the pane says "managed policy settings
   are not visible to this mod" and never claims a toggle took effect, only that
   the user setting was changed.

## Options
- `allowWithoutBackup` (boolean, default false): accept a settings change even
  when the backup copy cannot be written.
