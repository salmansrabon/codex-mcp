/**
 * The running transcript of a `codex_ask` conversation.
 *
 * The model is stateless — every `codex exec` starts blank — so remembering an
 * earlier turn means re-sending it. That is the only mechanism available, and
 * it is cheap here: Codex spends ~14,000 tokens of fixed overhead on every
 * call regardless, against which a remembered turn costs roughly 40.
 *
 * The caps below are therefore a safety rail, not a cost optimisation. They
 * exist for the pathological case — a pasted document in one question — which
 * would otherwise ride along on every later turn for the life of the session.
 */

export interface AskConversationOptions {
  maxTurns?: number;
  maxChars?: number;
}

interface Turn {
  question: string;
  answer: string;
}

/** Generous on purpose: at ~40 tokens a turn, trimming earlier buys nothing. */
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CHARS = 20_000;

export class AskConversation {
  private history: Turn[] = [];
  private readonly maxTurns: number;
  private readonly maxChars: number;

  constructor(options: AskConversationOptions = {}) {
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  get turns(): number {
    return this.history.length;
  }

  record(question: string, answer: string): void {
    this.history.push({ question, answer });
    this.trim();
  }

  reset(): void {
    this.history = [];
  }

  /**
   * The prior exchanges, oldest first, ready to prepend to a prompt.
   *
   * Speakers are labelled so the model reads its own prior claims as its own
   * rather than as more input from the user.
   */
  transcript(): string {
    if (this.history.length === 0) return '';
    return this.history.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join('\n\n');
  }

  /**
   * Drop oldest-first until both caps hold.
   *
   * The newest turn is always kept, even when it alone busts the character cap:
   * remembering one oversized exchange is better than silently remembering
   * nothing at all, which would look identical to the feature being broken.
   */
  private trim(): void {
    if (this.history.length > this.maxTurns) {
      this.history = this.history.slice(this.history.length - this.maxTurns);
    }
    while (this.history.length > 1 && this.transcript().length > this.maxChars) {
      this.history.shift();
    }
  }
}
