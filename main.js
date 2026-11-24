// @ts-check
// Git Workbench mod entry. One mod, many copies: the docked Source Control panel
// and every Diff view tab are copies of this view, told apart by props().view.
//
// Module scope is shared by every copy, so they all share one Workbench. Creating
// it makes no host calls; the panel's first `follow` does.

import { View } from "gpui-kit";
import { props } from "herdr";
import { createWorkbench } from "./src/core/workbench.js";
import { herdrPlatform, startHost } from "./src/ui/herdr-platform.js";
import { SourceControlPanel } from "./src/ui/source-control-panel.js";
import { DiffView } from "./src/ui/diff-view.js";

const workbench = createWorkbench(herdrPlatform);

/** @type {Record<string, new (workbench: any, cx: any) => { render(cx: any): any, close?(cx: any): any }>} */
const KINDS = { panel: SourceControlPanel, diff: DiffView };

export default class GitWorkbench extends View {
  /** @param {unknown} _props @param {import("gpui-kit").Context} cx */
  init(_props, cx) {
    startHost(cx);
    const view = /** @type {any} */ (props())?.view ?? "panel";
    this.impl = new (KINDS[view] ?? SourceControlPanel)(workbench, cx);
  }

  /** @param {import("gpui-kit").Context} cx */
  render(cx) {
    return this.impl.render(cx);
  }

  /** @param {import("gpui-kit").Context} cx */
  async close(cx) {
    await this.impl.close?.(cx);
  }
}
