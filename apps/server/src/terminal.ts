import { Box, Container, Editor, Loader, Markdown, matchesKey, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const muted = (text: string): string => `\x1b[90m${text}\x1b[39m`;
const accent = (text: string): string => `\x1b[36m${text}\x1b[39m`;
const pink = (text: string): string => `\x1b[38;5;201m${text}\x1b[39m`;
const slime = (text: string): string => `\x1b[38;5;154m${text}\x1b[39m`;
const clean = (text: string): string => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

export function responseMarkdown(text = ""): Markdown {
  return new Markdown(clean(text), 2, 1, {
    heading: (value) => `\x1b[1;38;5;141m${value}\x1b[22;39m`,
    link: accent,
    linkUrl: muted,
    code: slime,
    codeBlock: (value) => `\x1b[38;5;216m${value}\x1b[39m`,
    codeBlockBorder: (value) => muted(value.replace(/^```/, "─ ")),
    quote: muted,
    quoteBorder: pink,
    hr: muted,
    listBullet: pink,
    bold: (value) => `\x1b[1m${value}\x1b[22m`,
    italic: (value) => `\x1b[3m${value}\x1b[23m`,
    strikethrough: (value) => `\x1b[9m${value}\x1b[29m`,
    underline: (value) => `\x1b[4m${value}\x1b[24m`,
  });
}

export class SlopBotTerminal {
  private readonly tui = new TuiMainScreen(new ProcessTerminal(), true);
  private readonly conversation = new Container();
  private readonly footer = new Text("", 2, 0);
  private readonly loading = new Container();
  private loader: Loader | undefined;
  private readonly editor = new Editor(this.tui, {
    borderColor: pink,
    selectList: { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted },
  }, { paddingX: 1 });
  private pending: ((line: string | undefined) => void) | undefined;
  private response = responseMarkdown();
  private content = "";
  private closed = false;

  constructor() {
    const letters = [
      [" ▄▄▄ ", "█▄▄  ", "   █ ", "▄▄▄▀ "],
      ["█    ", "█    ", "█    ", "▀▄▄▄ "],
      [" ▄▄  ", "█  █ ", "█  █ ", " ▀▀  "],
      ["▄▄▄  ", "█  █ ", "█▀▀  ", "█    "],
      ["▄▄▄  ", "█▄▄▀ ", "█  █ ", "▀▄▄▀ "],
      [" ▄▄  ", "█  █ ", "█  █ ", " ▀▀  "],
      ["▄▄▄▄▄", "  █  ", "  █  ", "  ▀  "],
    ];
    const colors = [201, 214, 154, 51, 165, 226, 198];
    const header = {
      invalidate() {},
      render(width: number): string[] {
        const title = width >= 41
          ? Array.from({ length: 4 }, (_, row) => letters.map((letter, index) => `\x1b[38;5;${colors[index]}m${letter[row]}\x1b[39m`).join(""))
          : [pink("S") + slime("L") + accent("O") + pink("P") + slime("B") + accent("O") + pink("T")];
        return new Text([
          pink("     *") + slime("    _..---.._    ") + accent("+"),
          slime("         /  o   O  \\"),
          slime("         |    ~    |") + pink("  *"),
          slime("      ___/  .___,  \\___"),
          slime("     (___.._/   \\_..___)"),
          "",
          ...title,
          slime("  ▀  ▄     ▀▄   ▄    ▀   ▄     ▀"),
          "",
        ].join("\n"), 2, 1).render(width);
      },
    };
    const composer = new Box(2, 0, (text) => `\x1b[48;5;235m${text}\x1b[49m`);
    composer.addChild(this.editor);
    this.tui.addChild(header);
    this.tui.addChild(this.conversation);
    this.tui.addChild(this.loading);
    this.tui.addChild(composer);
    this.tui.addChild(this.footer);
    this.editor.onSubmit = (value) => {
      if (!this.pending || !value.trim()) return;
      this.editor.addToHistory(value);
      this.editor.setText("");
      this.editor.disableSubmit = true;
      this.conversation.addChild(new Text(accent("› ") + clean(value), 2, 1));
      this.content = "";
      this.response = responseMarkdown();
      this.conversation.addChild(this.response);
      const resolve = this.pending;
      this.pending = undefined;
      this.footer.setText(muted("Working… · Ctrl+C disconnect"));
      this.loader = new Loader(this.tui, (value) => value, slime, "slopping…", {
        frames: [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].map((position) =>
          pink("[") + muted("·".repeat(position)) + slime("▓") + accent("█") + pink("▒") + muted("·".repeat(6 - position)) + pink("]") + " " + slime("(o ~ O)")),
        intervalMs: 140,
      });
      this.loading.addChild(this.loader);
      resolve(value);
      this.tui.requestRender();
    };
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c") || (matchesKey(data, "ctrl+d") && !this.editor.getText())) {
        this.close();
        process.exit(0);
      }
      return undefined;
    });
    this.tui.setFocus(this.editor);
    this.tui.start();
    this.conversation.addChild(this.response);
    this.footer.setText(muted("Connecting…"));
  }

  write(value: string): void {
    this.content += clean(value);
    this.response.setText(this.content.trimStart());
    this.tui.requestRender();
  }

  clear(): void {
    this.conversation.clear();
    this.content = "";
    this.response = responseMarkdown();
    this.conversation.addChild(this.response);
    this.tui.requestRender(true);
  }

  async *lines(): AsyncGenerator<string> {
    while (!this.closed) {
      this.stopLoading();
      this.editor.disableSubmit = false;
      this.footer.setText(muted("Enter send · Shift+Enter newline · /help commands · Ctrl+C disconnect"));
      const next = new Promise<string | undefined>((resolve) => { this.pending = resolve; });
      this.tui.requestRender();
      const line = await next;
      if (line === undefined) return;
      yield line;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopLoading();
    this.pending?.(undefined);
    this.tui.stop();
  }

  private stopLoading(): void {
    this.loader?.stop();
    this.loader = undefined;
    this.loading.clear();
  }
}
