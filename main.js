// Stub for the dev-loop check. Replaced by the real Workbench later.
import { View } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";

const STAMP = "stub v4 via dev-sync";

export default class GitWorkbench extends View {
  render(_cx) {
    const t = theme();
    return v_flex()
      .size_full()
      .bg(t.surface)
      .p(10)
      .text_size(13)
      .text_color(t.foreground)
      .child(`Git Workbench (${STAMP})`);
  }
}
