// @ts-check
// The Diff view: one Herdr tab per Diff target (props().diff). Placeholder until #27.

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, theme } from "herdr";

export class DiffView {
  /** @param {ReturnType<import("../core/workbench.js").createWorkbench>} workbench @param {import("gpui-kit").Context} _cx */
  constructor(workbench, _cx) {
    this.workbench = workbench;
    this.target = /** @type {any} */ (props())?.diff ?? null;
  }

  /** @param {import("gpui-kit").Context} _cx */
  render(_cx) {
    const t = theme();
    return v_flex().size_full().bg(t.surface).text_color(t.muted).text_size(13).p(12)
      .child(div().child(`Diff view: ${this.target?.newPath ?? "(no target)"}`));
  }
}
