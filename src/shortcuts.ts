import { browser } from "wxt/browser";

const actionCommand = "_execute_action";
const firefoxShortcut = "Ctrl+Shift+F8";

interface ShortcutControls {
  read(): Promise<string | undefined>;
  label: string;
  change(): Promise<void>;
}

export function shortcutControls(): ShortcutControls {
  const commands = browser.commands;
  async function read() {
    return (await commands.getAll()).find(command => command.name === actionCommand)?.shortcut;
  }
  if (hasCommandUpdate(commands)) {
    return {
      read,
      label: `Assign ${firefoxShortcut}`,
      async change() { await commands.update({ name: actionCommand, shortcut: firefoxShortcut }); },
    };
  }
  return {
    read,
    label: "Open shortcut settings",
    async change() { await browser.tabs.create({ url: "chrome://extensions/shortcuts" }); },
  };
}

function hasCommandUpdate(commands: typeof browser.commands): commands is typeof browser.commands & Pick<typeof globalThis.browser.commands, "update"> {
  return "update" in commands && typeof commands.update === "function";
}
