// ===========================================================================
// BODYiQ embeddable chat widget — vanilla TS, no framework.
//
// Compiled by build.config.ts into a single IIFE bundle (public/widget.js) that
// exposes `window.BODYiQAssistant.init(config)`.
//
// The widget is a floating, bottom-right LAUNCHER with a small state machine:
//
//   dormant → pill → (peek) → expanded
//
//   • dormant  — nothing visible (initial state on every page load)
//   • pill     — small rounded launcher with a context-aware label
//   • peek     — an auto-surfacing card above the pill with a contextual line
//   • expanded — the full chat panel (the pill "grows" into it)
//
// The expanded panel's internal chat UI (messages, chips, input, streaming,
// citations) is unchanged — only the triggering/transition shell around it is.
// ===========================================================================

type SourceType = "product" | "blog" | "policy";

// Mirrors PageContext in src/lib/types.ts (kept inline so the widget bundle
// stays self-contained). NOTE: article pages are typed as "blog" here.
interface WidgetPageContext {
  type?: SourceType;
  handle?: string;
  /** Contextual one-liner for the auto peek. Omit to disable peek on a page. */
  peekMessage?: string;
  /** Dwell seconds before peek fires on product pages (default 20). */
  peekTriggerSeconds?: number;
  /** Quick-reply chips; also used to enrich the pill aria-label. */
  quickReplies?: string[];
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

type LauncherState = "dormant" | "pill" | "peek" | "expanded";

const DEFAULTS = {
  title: "Ask BODYiQ",
  greeting:
    "Hi! I can help you choose products, answer questions, and explain the science behind them. What are you looking for?",
  quickReplies: [] as string[],
};

// --- Launcher tuning (transition durations mirror chat-widget.css) ----------

/** Delay before dormant → pill so it isn't jarring on page load. */
const PILL_REVEAL_MS = 1500;
/** How long a peek stays up before auto-collapsing back to the pill. */
const PEEK_TIMEOUT_MS = 8000;
/** peek → pill exit-animation length (must match the CSS transition). */
const PEEK_EXIT_MS = 200;
/** pill/peek → expanded grow-in length (must match the CSS transition). */
const EXPAND_MS = 250;
/** Default product-page dwell before the peek fires. */
const DEFAULT_PEEK_DWELL_SECONDS = 20;
/** Article scroll depth (0-1) that fires the peek. */
const ARTICLE_SCROLL_FIRE_RATIO = 0.5;
/** Suppress future peeks once the user has dismissed this many in a session. */
const MAX_PEEK_DISMISSALS = 2;

// sessionStorage keys (session-scoped: reset on a new tab session).
const SS_OPENS = "biq:opens";
const SS_PEEK_DISMISSALS = "biq:peek-dismissals";
const ssPeekFiredKey = (handle?: string) => `biq:peek-fired:${handle || "_"}`;
// Persisted so a conversation survives full-page navigations within a session.
const SS_HISTORY = "biq:history";
const SS_PANEL_OPEN = "biq:panel-open";

// Inline, static SVGs (safe innerHTML — no user data).
const ICON_CHAT =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

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

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function ssGet(key: string): number {
  try {
    return parseInt(window.sessionStorage.getItem(key) || "0", 10) || 0;
  } catch {
    return 0; // storage may be unavailable (private mode, etc.)
  }
}

function ssSet(key: string, value: number): void {
  try {
    window.sessionStorage.setItem(key, String(value));
  } catch {
    /* no-op: peek gating just falls back to in-page defaults */
  }
}

function ssGetRaw(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function ssSetRaw(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* no-op: persistence is best-effort */
  }
}

// --- Peek trigger evaluator ------------------------------------------------
//
// Small, page-type-configurable evaluator that decides WHEN a peek should
// surface. It only measures — the widget owns all gating (session limits,
// once-per-page, peekMessage presence) and the actual state transition.

class PeekTrigger {
  private disposed = false;
  private timer?: number;
  private scrollHandler?: () => void;

  constructor(
    private readonly pageType: SourceType | undefined,
    private readonly dwellSeconds: number,
    private readonly onFire: () => void,
  ) {}

  start(): void {
    if (this.pageType === "product") {
      // Product pages: fire after N seconds of dwell time.
      this.timer = window.setTimeout(() => this.fire(), this.dwellSeconds * 1000);
    } else if (this.pageType === "blog") {
      // Article/blog pages: fire once scroll depth crosses ~50%.
      this.scrollHandler = () => this.evaluateScroll();
      window.addEventListener("scroll", this.scrollHandler, { passive: true });
      this.evaluateScroll(); // handle deep-links / short pages already past 50%
    }
    // Any other page type has no automatic trigger.
  }

  private evaluateScroll(): void {
    if (this.disposed) return;
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return; // nothing to scroll (short page)
    const ratio = (window.scrollY || window.pageYOffset || 0) / scrollable;
    if (ratio >= ARTICLE_SCROLL_FIRE_RATIO) this.fire();
  }

  private fire(): void {
    if (this.disposed) return;
    this.dispose();
    this.onFire();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.scrollHandler) {
      window.removeEventListener("scroll", this.scrollHandler);
      this.scrollHandler = undefined;
    }
  }
}

// --- Widget ----------------------------------------------------------------

class BodyiqWidget {
  private cfg: Required<Pick<BodyiqWidgetConfig, "title" | "greeting">> &
    BodyiqWidgetConfig;
  private root: HTMLElement;
  private pillEl!: HTMLButtonElement;
  private peekEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private widgetEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private history: ChatTurn[] = [];
  private busy = false;

  private state: LauncherState = "dormant";
  private peekTrigger?: PeekTrigger;
  private pillTimer?: number;
  private peekTimeoutId?: number;

  constructor(config: BodyiqWidgetConfig) {
    this.cfg = {
      ...config,
      title: config.title ?? DEFAULTS.title,
      greeting: config.greeting ?? DEFAULTS.greeting,
    };
    this.root = resolveTarget(config.target);
    this.history = this.loadHistory();
    this.render();
  }

  // --- Rendering -----------------------------------------------------------

  private render() {
    this.root.classList.add("biq-root");
    this.root.innerHTML = "";

    this.buildPill();
    this.buildPeek();
    this.buildPanel();

    // Resume an in-progress conversation across a full-page navigation. We go
    // straight to expanded (and deliberately do NOT steal focus, since this is
    // an unsolicited restore on page load), skipping the pill/peek intro.
    if (this.wasPanelOpen()) {
      this.setState("expanded");
      return;
    }

    this.setState("dormant");

    // dormant → pill after a short delay so it's not jarring on load.
    this.pillTimer = window.setTimeout(() => {
      if (this.state === "dormant") this.setState("pill");
    }, PILL_REVEAL_MS);

    this.initPeek();
  }

  /** The small rounded launcher. */
  private buildPill() {
    const pill = el("button", "biq-pill") as HTMLButtonElement;
    pill.type = "button";

    const icon = el("span", "biq-pill__icon");
    icon.innerHTML = ICON_CHAT;
    const label = el("span", "biq-pill__label", this.launcherLabel());

    pill.appendChild(icon);
    pill.appendChild(label);
    pill.setAttribute("aria-label", this.pillAriaLabel());
    pill.addEventListener("click", () => this.open());

    this.pillEl = pill;
    this.root.appendChild(pill);
  }

  /**
   * The auto-surfacing peek card. The container is persistent (so it can be
   * animated), carries aria-live so screen readers announce it when populated,
   * and its interactive contents are mounted only while visible (correct tab
   * order + reliable live-region announcement).
   */
  private buildPeek() {
    const peek = el("div", "biq-peek");
    peek.setAttribute("aria-live", "polite");
    this.peekEl = peek;
    this.root.appendChild(peek);
  }

  /** The expanded chat panel — wraps the (unchanged) internal chat UI. */
  private buildPanel() {
    const panel = el("div", "biq-panel");
    const widget = el("div", "biq-widget");
    this.widgetEl = widget;
    panel.appendChild(widget);
    this.panelEl = panel;
    this.root.appendChild(panel);

    this.renderChatUI(widget);
  }

  /**
   * Builds the internal chat UI into `mount`. This is the pre-existing widget
   * body (header, messages, chips, composer, footer) — unchanged except for a
   * close button in the header that drives expanded → pill.
   */
  private renderChatUI(mount: HTMLElement) {
    // Header (title + close).
    const header = el("div", "biq-header");
    header.appendChild(el("span", "biq-title", this.cfg.title));

    const close = el("button", "biq-close") as HTMLButtonElement;
    close.type = "button";
    close.setAttribute("aria-label", "Close chat");
    close.innerHTML = ICON_CLOSE;
    close.addEventListener("click", () => this.close());
    header.appendChild(close);
    mount.appendChild(header);

    // Messages
    this.messagesEl = el("div", "biq-messages");
    this.messagesEl.setAttribute("aria-live", "polite");
    mount.appendChild(this.messagesEl);

    if (this.cfg.greeting) this.addMessage("assistant", this.cfg.greeting);

    // Replay any persisted conversation (text only — citation cards are not
    // restored across navigations). `this.history` is loaded in the ctor.
    for (const turn of this.history) this.addMessage(turn.role, turn.content);

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
    if (chips.length > 0) mount.appendChild(this.chipsEl);

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
    mount.appendChild(composer);

    // "Talk to a person" fallback — always visible.
    const footer = el("div", "biq-footer");
    const human = el("button", "biq-human", "Talk to a person");
    human.type = "button";
    human.addEventListener("click", () => this.handleHumanHandoff());
    footer.appendChild(human);
    mount.appendChild(footer);

    // Chips are dismissed once a conversation is underway; keep that on resume.
    if (this.history.length > 0) this.hideChips();
  }

  // --- Launcher copy -------------------------------------------------------

  /** Context-aware pill label. (Article pages are typed "blog".) */
  private launcherLabel(): string {
    switch (this.cfg.pageContext?.type) {
      case "product":
        return "Ask about this product";
      case "blog":
        return "Ask about this article";
      default:
        return "Ask BODYiQ";
    }
  }

  /** Descriptive aria-label reflecting the pill's current text (+ hints). */
  private pillAriaLabel(): string {
    let label = `${this.launcherLabel()} — open the BODYiQ assistant`;
    const replies =
      this.cfg.quickReplies ?? this.cfg.pageContext?.quickReplies ?? [];
    if (replies.length > 0) {
      label += `. For example: ${replies.slice(0, 2).join(", ")}`;
    }
    return label;
  }

  // --- State machine -------------------------------------------------------

  private setState(next: LauncherState) {
    this.state = next;
    this.root.classList.remove(
      "biq-root--dormant",
      "biq-root--pill",
      "biq-root--peek",
      "biq-root--expanded",
    );
    this.root.classList.add(`biq-root--${next}`);
  }

  /** pill/peek → expanded. User-initiated, so focusing the input is fine. */
  private open() {
    this.recordOpen();
    this.peekTrigger?.dispose();
    this.clearPeekTimeout();
    this.setState("expanded");
    this.setPanelOpenFlag(true);
    this.unmountPeek();

    // Focus the composer after the grow-in settles.
    const delay = prefersReducedMotion() ? 0 : EXPAND_MS;
    window.setTimeout(() => this.inputEl?.focus(), delay);
  }

  /** expanded → pill (never back to dormant). */
  private close() {
    this.setState("pill");
    this.setPanelOpenFlag(false);
    this.pillEl.focus();
  }

  // --- Cross-navigation persistence ----------------------------------------

  private loadHistory(): ChatTurn[] {
    const raw = ssGetRaw(SS_HISTORY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (t): t is ChatTurn =>
          !!t &&
          (t.role === "user" || t.role === "assistant") &&
          typeof t.content === "string",
      );
    } catch {
      return [];
    }
  }

  private saveHistory() {
    ssSetRaw(SS_HISTORY, JSON.stringify(this.history));
  }

  private wasPanelOpen(): boolean {
    return ssGetRaw(SS_PANEL_OPEN) === "1";
  }

  private setPanelOpenFlag(open: boolean) {
    ssSetRaw(SS_PANEL_OPEN, open ? "1" : "0");
  }

  // --- Peek behavior -------------------------------------------------------

  /** Wire up the trigger evaluator if this page is eligible for a peek. */
  private initPeek() {
    const msg = this.cfg.pageContext?.peekMessage;
    if (!msg) return; // no contextual copy → never peek (never show generic copy)
    if (this.peeksSuppressed()) return;
    if (this.peekAlreadyFired()) return;

    const dwell =
      this.cfg.pageContext?.peekTriggerSeconds ?? DEFAULT_PEEK_DWELL_SECONDS;
    this.peekTrigger = new PeekTrigger(this.cfg.pageContext?.type, dwell, () =>
      this.onPeekTrigger(),
    );
    this.peekTrigger.start();
  }

  /** Called by the trigger evaluator; re-checks gates before surfacing. */
  private onPeekTrigger() {
    if (this.state !== "pill") return; // only surface from the plain pill
    if (this.peeksSuppressed()) return;
    if (this.peekAlreadyFired()) return;
    this.showPeek();
  }

  private showPeek() {
    const msg = this.cfg.pageContext?.peekMessage;
    if (!msg) return;

    this.markPeekFired();
    this.mountPeek(msg);
    this.setState("peek");

    // Auto-collapse back to the pill if ignored.
    this.peekTimeoutId = window.setTimeout(
      () => this.collapsePeek(false),
      PEEK_TIMEOUT_MS,
    );
  }

  /**
   * peek → pill. `dismissed` is true only for an explicit X tap (which counts
   * toward the session dismissal limit); an ignored timeout does not.
   */
  private collapsePeek(dismissed: boolean) {
    if (this.state !== "peek") return;
    this.clearPeekTimeout();
    if (dismissed) this.recordPeekDismissal();

    this.setState("pill"); // animates the card back down behind the pill

    const delay = prefersReducedMotion() ? 0 : PEEK_EXIT_MS;
    window.setTimeout(() => {
      if (this.state === "pill") this.unmountPeek();
    }, delay);
  }

  /** Populate the (persistent, aria-live) peek container — announces on insert. */
  private mountPeek(message: string) {
    this.peekEl.innerHTML = "";

    const body = el("button", "biq-peek__body") as HTMLButtonElement;
    body.type = "button";
    body.appendChild(el("span", "biq-peek__text", message));
    body.addEventListener("click", () => this.open());

    const dismiss = el("button", "biq-peek__dismiss") as HTMLButtonElement;
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss suggestion");
    dismiss.innerHTML = ICON_CLOSE;
    dismiss.addEventListener("click", (e) => {
      e.stopPropagation();
      this.collapsePeek(true);
    });

    this.peekEl.appendChild(body);
    this.peekEl.appendChild(dismiss);
  }

  private unmountPeek() {
    this.peekEl.innerHTML = "";
  }

  private clearPeekTimeout() {
    if (this.peekTimeoutId !== undefined) {
      clearTimeout(this.peekTimeoutId);
      this.peekTimeoutId = undefined;
    }
  }

  // --- Peek session gating -------------------------------------------------

  private peeksSuppressed(): boolean {
    return (
      ssGet(SS_OPENS) >= 1 || ssGet(SS_PEEK_DISMISSALS) >= MAX_PEEK_DISMISSALS
    );
  }

  private peekAlreadyFired(): boolean {
    return ssGet(ssPeekFiredKey(this.cfg.pageContext?.handle)) >= 1;
  }

  private markPeekFired() {
    ssSet(ssPeekFiredKey(this.cfg.pageContext?.handle), 1);
  }

  private recordOpen() {
    ssSet(SS_OPENS, ssGet(SS_OPENS) + 1);
  }

  private recordPeekDismissal() {
    ssSet(SS_PEEK_DISMISSALS, ssGet(SS_PEEK_DISMISSALS) + 1);
  }

  // --- Chat UI (unchanged behavior) ----------------------------------------

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
      this.saveHistory();
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
