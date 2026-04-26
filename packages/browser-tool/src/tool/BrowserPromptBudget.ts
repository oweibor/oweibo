// packages/browser-tool/src/tool/BrowserPromptBudget.ts
// IPromptBudgetCollaborator implementation that trims browser observations
// (snapshot text, last screenshot description, etc.) into the agent prompt budget.
import type { IPromptBudgetCollaborator, ITokenizer } from '@oweibo/core-contracts';

export class BrowserPromptBudget implements IPromptBudgetCollaborator {
  readonly sectionKey = 'browser-observations';

  async trim(
    sectionText: string,
    tokenBudget: number,
    tokenizer: ITokenizer,
  ): Promise<{ trimmed: string; tokensUsed: number }> {
    let text = sectionText;
    let used = tokenizer.countTokens(text);
    if (used <= tokenBudget) return { trimmed: text, tokensUsed: used };

    // Greedy line-trim from the front (older observations first).
    const lines = text.split('\n');
    while (used > tokenBudget && lines.length > 1) {
      lines.shift();
      text = lines.join('\n');
      used = tokenizer.countTokens(text);
    }
    return { trimmed: text, tokensUsed: used };
  }
}
