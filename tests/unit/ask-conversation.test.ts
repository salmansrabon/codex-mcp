import { describe, expect, it } from 'vitest';

import { AskConversation } from '../../src/tools/ask-conversation.js';

/**
 * The model is stateless: every call starts blank, so "remembering" is always
 * re-supplying the context. This class is that context, and its whole job is to
 * stay bounded — a question containing a pasted document must not make every
 * later turn carry it forever.
 */
describe('AskConversation', () => {
  it('has nothing to say before the first exchange', () => {
    expect(new AskConversation().transcript()).toBe('');
    expect(new AskConversation().turns).toBe(0);
  });

  it('replays an earlier exchange verbatim', () => {
    const conversation = new AskConversation();
    conversation.record('Does Ghost exist?', 'No reliable evidence.');

    const transcript = conversation.transcript();

    expect(transcript).toContain('Does Ghost exist?');
    expect(transcript).toContain('No reliable evidence.');
    expect(conversation.turns).toBe(1);
  });

  it('keeps exchanges in the order they happened', () => {
    const conversation = new AskConversation();
    conversation.record('first question', 'first answer');
    conversation.record('second question', 'second answer');

    const transcript = conversation.transcript();

    expect(transcript.indexOf('first question')).toBeLessThan(transcript.indexOf('second question'));
  });

  it('distinguishes who said what, so the model reads its own words as its own', () => {
    const conversation = new AskConversation();
    conversation.record('the question', 'the answer');

    // Without labels a transcript is an undifferentiated wall of text and the
    // model cannot tell its own prior claims from the user's.
    expect(conversation.transcript()).toMatch(/Q:\s*the question/);
    expect(conversation.transcript()).toMatch(/A:\s*the answer/);
  });

  it('drops the oldest exchange once the turn cap is reached', () => {
    const conversation = new AskConversation({ maxTurns: 3 });
    for (const n of [1, 2, 3, 4]) conversation.record(`question ${n}`, `answer ${n}`);

    const transcript = conversation.transcript();

    expect(transcript).not.toContain('question 1');
    expect(transcript).toContain('question 4');
    expect(conversation.turns).toBe(3);
  });

  it('drops old exchanges when one turn is enormous', () => {
    // The safety rail this exists for: a pasted document in a single question
    // must not ride along on every later turn.
    const conversation = new AskConversation({ maxChars: 500 });
    conversation.record('x'.repeat(2000), 'huge answer');
    conversation.record('small question', 'small answer');

    const transcript = conversation.transcript();

    expect(transcript).not.toContain('huge answer');
    expect(transcript).toContain('small question');
    expect(transcript.length).toBeLessThanOrEqual(500);
  });

  it('keeps the newest exchange even when it alone exceeds the cap', () => {
    // Better to carry one oversized turn than to silently remember nothing.
    const conversation = new AskConversation({ maxChars: 100 });
    conversation.record('y'.repeat(1000), 'answer');

    expect(conversation.transcript()).toContain('answer');
    expect(conversation.turns).toBe(1);
  });

  it('forgets everything when reset', () => {
    const conversation = new AskConversation();
    conversation.record('a question', 'an answer');

    conversation.reset();

    expect(conversation.transcript()).toBe('');
    expect(conversation.turns).toBe(0);
  });

  it('keeps two conversations independent', () => {
    const one = new AskConversation();
    const two = new AskConversation();
    one.record('only in one', 'answer');

    expect(two.transcript()).toBe('');
    expect(one.transcript()).toContain('only in one');
  });
});
