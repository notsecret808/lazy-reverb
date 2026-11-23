import { defineContentScript } from "wxt/utils/define-content-script";
import { installEngine } from "../engine";
import { extensionHosts } from "../extension-hosts";

export default defineContentScript({
  matches: extensionHosts,
  registration: "manifest",
  runAt: "document_start",
  world: "MAIN",
  main() {
    installEngine();
  },
});
