// ===========================================================================
// BODYiQ embeddable chat widget — vanilla TS, no framework.
//
// Compiled by build.config.ts into a single IIFE bundle (public/widget.js) that
// exposes `window.BODYiQAssistant.init(config)`. It renders INLINE into a host
// container (not a floating corner bubble) so the Shopify theme controls
// placement (e.g. inside a PDP section or an article sidebar).
// ===========================================================================

type SourceType = "product" | "blog" | "policy";

interface WidgetPageContext {
  type?: SourceType;
  handle?: string;
}

interface WidgetCitation {
  title: string;
  url: string;
  sourceType: SourceType;
}

export interface BodyiqWidgetConfig {
  /** Container element or a CSS selector to mount into. */
  target: string | HTMLElement;
  /** Full URL of the chat endpoint, e.g. https://assistant.bodyiq.com/api/chat */
  apiUrl: string;
  /** Where the shopper is, so the backend can bias retrieval. */
  pageContext?: WidgetPageContext;
  /** 2-4 contextual quick-reply chips shown on load. */
  quickReplies?: string[];
  /** Opening assistant message. */
  greeting?: string;
  /** URL opened by "Talk to a person" (e.g. contact page or chat). */
  humanHandoffUrl?: string;
  /** Optional hook invoked instead of navigating for human handoff. */
  onHumanHandoff?: () => void;
  /** Heading shown at the top of the widget. */
  title?: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const DEFAULTS = {
  title: "Ask BODYiQ",
  greeting:
    "Hi! I can help you choose products, answer questions, and explain the science behind them. What are you looking for?",
  quickReplies: [] as string[],
};

// --- Small DOM helpers -----------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent = XSS-safe
  return node;
}

function resolveTarget(target: string | HTMLElement): HTMLElement {
  const node =
    typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!node) throw new Error(`BODYiQ widget: target not found (${String(target)})`);
  return node;
}

// --- Widget ----------------------------------------------------------------

class BodyiqWidget {
  private cfg: Required<Pick<BodyiqWidgetConfig, "title" | "greeting">> &
    BodyiqWidgetConfig;
  private root: HTMLElement;
  private messagesEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private history: ChatTurn[] = [];
  private busy = false;

  constructor(config: BodyiqWidgetConfig) {
    this.cfg = {
      ...config,
      title: config.title ?? DEFAULTS.title,
      greeting: config.greeting ?? DEFAULTS.greeting,
    };
    this.root = resolveTarget(config.target);
    this.render();
  }

  private render() {
    this.root.classList.add("biq-widget");
    this.root.innerHTML = "";

    // Header
    const header = el("div", "biq-header");
    header.appendChild(el("span", "biq-title", this.cfg.title));
    this.root.appendChild(header);

    // Messages
    this.messagesEl = el("div", "biq-messages");
    this.messagesEl.setAttribute("aria-live", "polite");
    this.root.appendChild(this.messagesEl);

    if (this.cfg.greeting) this.addMessage("assistant", this.cfg.greeting);

    // Quick-reply chips
    this.chipsEl = el("div", "biq-chips");
    const chips = (this.cfg.quickReplies ?? DEFAULTS.quickReplies).slice(0, 4);
    for (const chip of chips) {
      const btn = el("button", "biq-chip", chip);
      btn.type = "button";
      btn.addEventListener("click", () => {
        if (!this.busy) this.submit(chip);
      });
      this.chipsEl.appendChild(btn);
    }
    if (chips.length > 0) this.root.appendChild(this.chipsEl);

    // Composer
    const composer = el("form", "biq-composer");
    this.inputEl = el("textarea", "biq-input") as HTMLTextAreaElement;
    this.inputEl.rows = 1;
    this.inputEl.placeholder = "Type your question…";
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.onSubmit();
      }
    });

    this.sendBtn = el("button", "biq-send", "Send") as HTMLButtonElement;
    this.sendBtn.type = "submit";

    composer.appendChild(this.inputEl);
    composer.appendChild(this.sendBtn);
    composer.addEventListener("submit", (e) => {
      e.preventDefault();
      this.onSubmit();
    });
    this.root.appendChild(composer);

    // "Talk to a person" fallback — always visible.
    const footer = el("div", "biq-footer");
    const human = el("button", "biq-human", "Talk to a person");
    human.type = "button";
    human.addEventListener("click", () => this.handleHumanHandoff());
    footer.appendChild(human);
    this.root.appendChild(footer);
  }

  private onSubmit() {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) return;
    this.inputEl.value = "";
    this.submit(text);
  }

  private handleHumanHandoff() {
    if (this.cfg.onHumanHandoff) {
      this.cfg.onHumanHandoff();
      return;
    }
    if (this.cfg.humanHandoffUrl) {
      window.open(this.cfg.humanHandoffUrl, "_blank", "noopener");
      return;
    }
    // Let the theme react (e.g. open its own live-chat) if nothing configured.
    this.root.dispatchEvent(
      new CustomEvent("biq:human-handoff", { bubbles: true }),
    );
    this.addMessage(
      "assistant",
      "I've flagged that you'd like to talk to a person — our team will follow up. You can also reach us from the store's contact page.",
    );
  }

  private addMessage(role: ChatTurn["role"], text: string): HTMLElement {
    const wrap = el("div", `biq-msg biq-msg--${role}`);
    const bubble = el("div", "biq-bubble", text);
    wrap.appendChild(bubble);
    this.messagesEl.appendChild(wrap);
    this.scrollToBottom();
    return bubble;
  }

  private renderCitations(container: HTMLElement, citations: WidgetCitation[]) {
    if (citations.length === 0) return;
    const wrap = el("div", "biq-citations");
    wrap.appendChild(el("div", "biq-citations__label", "Sources"));
    for (const c of citations) {
      const card = el("a", "biq-citation") as HTMLAnchorElement;
      card.href = c.url;
      card.target = "_blank";
      card.rel = "noopener";
      card.appendChild(el("span", "biq-citation__type", c.sourceType));
      card.appendChild(el("span", "biq-citation__title", c.title));
      wrap.appendChild(card);
    }
    container.appendChild(wrap);
    this.scrollToBottom();
  }

  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.inputEl.disabled = busy;
  }

  /** Send a message and stream the assistant response. */
  private async submit(message: string) {
    this.setBusy(true);
    this.hideChips();
    this.addMessage("user", message);

    const assistantMsg = this.addMessage("assistant", "");
    assistantMsg.classList.add("biq-bubble--streaming");
    const answerWrap = assistantMsg.parentElement as HTMLElement;

    let answer = "";
    try {
      await this.streamChat(message, (delta) => {
        answer += delta;
        assistantMsg.textContent = answer;
        this.scrollToBottom();
      }, (citations) => {
        this.renderCitations(answerWrap, citations);
      });
    } catch (err) {
      assistantMsg.textContent =
        "Sorry — something went wrong reaching the assistant. Please try again or talk to a person.";
      // eslint-disable-next-line no-console
      console.error("BODYiQ widget error", err);
    } finally {
      assistantMsg.classList.remove("biq-bubble--streaming");
      this.history.push({ role: "user", content: message });
      if (answer) this.history.push({ role: "assistant", content: answer });
      this.setBusy(false);
      this.inputEl.focus();
    }
  }

  private hideChips() {
    if (this.chipsEl?.parentElement) this.chipsEl.style.display = "none";
  }

  /**
   * POST to /api/chat and parse the SSE stream. Our protocol is one JSON object
   * per `data:` frame: { type: "token" | "citations" | "done" | "error" }.
   */
  private async streamChat(
    message: string,
    onToken: (delta: string) => void,
    onCitations: (citations: WidgetCitation[]) => void,
  ) {
    const res = await fetch(this.cfg.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        conversationHistory: this.history,
        pageContext: this.cfg.pageContext,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Chat request failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? ""; // keep incomplete trailing frame

      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const json = line.slice("data:".length).trim();
        if (!json) continue;

        let evt: { type: string; text?: string; citations?: WidgetCitation[]; message?: string };
        try {
          evt = JSON.parse(json);
        } catch {
          continue;
        }

        if (evt.type === "token" && evt.text) onToken(evt.text);
        else if (evt.type === "citations" && evt.citations) onCitations(evt.citations);
        else if (evt.type === "error") throw new Error(evt.message || "stream error");
      }
    }
  }
}

// --- Public bootstrap ------------------------------------------------------

declare global {
  interface Window {
    BODYiQAssistant?: { init: (config: BodyiqWidgetConfig) => void };
  }
}

const api = {
  init(config: BodyiqWidgetConfig) {
    const boot = () => new BodyiqWidget(config);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
  },
};

window.BODYiQAssistant = api;

export {};
