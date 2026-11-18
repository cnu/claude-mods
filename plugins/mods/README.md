# mods

One place to see and switch the mods installed on this machine. Run `/mods` to open a pane.

For each installed mod the pane shows the name, version, description and whether it is enabled, plus a **Turn on / Turn off** button. Mods that register a slash command that looks like it opens its own pane (and whose description does not mention arguments) get an **Open /command (runs it with no arguments)** button; it runs that command with empty arguments and says so. A **Refresh** button re-reads everything.

## Where the data comes from

- The installed-plugins record, `~/.claude/plugins/installed_plugins.json` (or under `CLAUDE_CONFIG_DIR` when that is set). A mod installed in several scopes is listed once, user scope first.
- Each mod's own `.claude-plugin/plugin.json` for its version and description. The record's version is used if the manifest has none; an unreadable manifest is shown as "(manifest not readable)".
- The `enabledPlugins` map in the user settings file, `~/.claude/settings.json`, plus, read-only, `<project root>/.claude/settings.json` and `settings.local.json` (project root from the session root API). Also read-only: the `--settings` flag source and the managed policy source, through `$.settings.read({ source })`. Precedence, highest first: managed policy, flag, local, project, user. When an override decides, the row shows it, e.g. `enabled (on in project settings)` or `disabled (off in managed policy settings)`. If the managed policy source cannot be read, the pane shows a standing line, "managed policy settings are not visible to this mod", and the notice after a press repeats it.

Nothing is written until you press a Turn on / Turn off button. Opening the pane, refreshing and listing are read-only.

## What the on/off control really does

The mod API offers no way to switch another plugin on or off for the current chat only (`$.plugin` exposes only this plugin's own name and folder, and `$.settings` is read-only). So the spec's second path is used:

- Pressing the button rewrites `enabledPlugins["<name>@<marketplace>"]` in your user settings file (`~/.claude/settings.json`), through the plugin file API, keeping every other key.
- This is a saved setting for **every** chat, not this chat only, and it takes effect after you **restart Claude Code**. The pane says so after each press and shows "enabled/disabled after restart" on the row.
- The button only ever edits **user** settings, and the notice says only that the user setting was changed, never that the mod is now on or off. If a managed policy, flag, project or local entry for that mod exists it wins; the row and the notice say so (e.g. "off in project settings ... will not show until that entry is removed").
- Safety: the file is written only if it was read and parsed as a JSON object, or is confirmed missing (`$.fs.exists` is false; then a new file is created). A read that fails for any other reason (permissions, I/O), an empty file, invalid JSON, or an `enabledPlugins` that is not an object makes the button refuse, write nothing and tell you why.
- Before the first change in a session the old text is copied to `settings.json.mods-backup-<timestamp>` next to it. If that copy cannot be written, the mod refuses: nothing is written to your settings and the notice says why. Set the option `allowWithoutBackup` to `true` to accept changes without a backup (the notice then says none exists). A missing file has nothing to back up, so it is still created.
- The mods mod has no button for itself.

## Limitations

- Offline-checked only. It has not been loaded into a live Claude Code: real pane drawing, real file paths and real `$.command.list` output are unverified.
- The enabled state comes from user, project, local, flag and managed policy settings. The settings API answers `{}` for a source with no settings and also leaves out a source the engine bars from the read, so an empty managed result cannot be told from "no policy"; the pane cannot prove no policy applies. The button cannot beat a project, local, flag or managed override. A project/local file that cannot be read is skipped with a warning in the notice.
- "Open" is a heuristic; the command list carries no argument metadata, so a command whose description mentions arguments (`<x>`, `[x]`, "args", "argument") is left out and the rest are run with empty arguments. The command list says which plugin owns a command, not whether it draws a pane. A button appears for an enabled mod's command that is named like the mod, or whose description mentions a pane, panel, window, dashboard and so on. A mod whose pane command is described differently gets no button; use its slash command by hand.
- Only enabled mods get an Open button, and `$.command.list` may omit the owning plugin for some commands.
- Rewriting the settings file reformats it to 2-space JSON; comments are not valid JSON in settings files, so none are lost, but unusual spacing is.
- One option: `allowWithoutBackup` (boolean, default `false`), described above.

## Developing

Pure logic (the installed-plugins parser, settings edit, open-command heuristic) is in `hooks/logic.ts`; the command and pane are in `hooks/register.tsx`; tests are `hooks/register.test.tsx`. Tests use mocked files and a mocked settings API and never touch real settings. See `docs/toolchain.md` in the repo for validate, type-check and test commands.
